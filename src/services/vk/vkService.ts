import { PhotoAttachment, VK, type MessageContext } from 'vk-io';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import memoryService from '../memory/memoryService.js';
import type { AIMessage, AIProvider, AIResponse } from '../ai/AIProvider.js';
import requestQueue from '../queue/requestQueue.js';
import senderService from '../sender/senderService.js';
import detectorService from '../detector/detectorService.js';
import commandService from '../command/commandService.js';
import imageGenerationService from '../image/imageGenerationService.js';
import type { GeneratedImage } from '../image/imageGenerationService.js';

/**
 * VkService — инициализация VK API и обработка входящих сообщений.
 */
export class VkService {
  private vk: VK;
  private readonly userDisplayNames = new Map<number, string>();
  private readonly pendingDisplayNameRequests = new Map<number, Promise<string | undefined>>();

  constructor() {
    const groupId = config.VK_GROUP_ID.match(/^(?:club|public)?(\d+)$/i)?.[1];
    this.vk = new VK({
      token: config.VK_TOKEN,
      ...(groupId ? { pollingGroupId: Number(groupId) } : {}),
    });
  }

  private async getUserDisplayName(userId: number): Promise<string | undefined> {
    if (userId <= 0) return undefined;
    const cached = this.userDisplayNames.get(userId);
    if (cached) return cached;

    const pending = this.pendingDisplayNameRequests.get(userId);
    if (pending) return pending;

    const request = (async () => {
      try {
        const [user] = await this.vk.api.users.get({ user_ids: [userId] });
        const displayName = `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim();
        if (displayName) this.userDisplayNames.set(userId, displayName);
        return displayName || undefined;
      } catch (err) {
        logger.warn({ err, userId }, 'Failed to load VK user name');
        return undefined;
      } finally {
        this.pendingDisplayNameRequests.delete(userId);
      }
    })();

    this.pendingDisplayNameRequests.set(userId, request);
    return request;
  }

  private async getPhotoAttachment(context: MessageContext): Promise<PhotoAttachment | undefined> {
    const findPhoto = (message: MessageContext) =>
      message.attachments.find(
        (attachment): attachment is PhotoAttachment => attachment instanceof PhotoAttachment,
      );

    let photo = findPhoto(context);
    if (!photo) {
      try {
        await context.loadMessagePayload({ force: true });
        photo = findPhoto(context);
      } catch (err) {
        logger.warn(
          { err, peerId: context.peerId, conversationMessageId: context.conversationMessageId },
          'Failed to load image command attachments',
        );
      }
    }
    if (photo) return photo;

    const repliedMessage = context.replyMessage;
    if (!repliedMessage) return undefined;
    photo = findPhoto(repliedMessage);
    if (!photo) {
      try {
        await repliedMessage.loadMessagePayload({ force: true });
        photo = findPhoto(repliedMessage);
      } catch (err) {
        logger.warn(
          {
            err,
            peerId: context.peerId,
            conversationMessageId: repliedMessage.conversationMessageId,
          },
          'Failed to load replied image',
        );
      }
    }
    return photo;
  }

  private startTyping(peerId: number): () => void {
    let stopped = false;
    let requestPending = false;
    let interval: ReturnType<typeof setInterval>;

    const update = async () => {
      if (stopped || requestPending) return;
      requestPending = true;
      try {
        await this.vk.api.messages.setActivity({
          peer_id: peerId,
          type: 'typing',
        });
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err.code === 922 || err.code === 932)
        ) {
          stopped = true;
          clearInterval(interval);
          logger.warn(
            { peerId },
            'Typing status unavailable: community is not a member of this chat or cannot interact with it',
          );
          return;
        }
        logger.warn({ err, peerId }, 'Failed to update typing status');
      } finally {
        requestPending = false;
      }
    };

    interval = setInterval(() => void update(), 4000);
    void update();

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  /**
   * Запуск обработки обновлений. Хендлер сохраняет сообщение и вызывает AI.
   */
  async start() {
    if (!config.VK_TOKEN) {
      logger.warn('VK_TOKEN not set; VkService will not start (development mode)');
      return;
    }

    this.vk.updates.on('message_new', async (context: MessageContext, next) => {
      logger.debug(
        { peerId: context.peerId, isChat: context.isChat, subTypes: context.subTypes },
        'Received VK message event',
      );
      if (context.isOutbox) return next();

      const peerId = context.peerId;
      const senderId = String(context.senderId);
      const displayName = await this.getUserDisplayName(context.senderId);
      let text = context.text ?? '';
      if (context.isChat && !text && context.conversationMessageId) {
        try {
          await context.loadMessagePayload();
          text = context.text ?? '';
        } catch (err) {
          logger.warn(
            { err, peerId, conversationMessageId: context.conversationMessageId },
            'Failed to load incoming chat message',
          );
        }
      }
      // Long Poll may provide only the replied-to conversation message ID.
      let isReplyToBot = false;
      const repliedMessage = context.replyMessage;
      const repliedConversationMessageId = repliedMessage?.conversationMessageId;
      const repliedMessageId = repliedMessage?.id ?? 0;
      if (context.isChat && (repliedConversationMessageId || repliedMessageId > 0)) {
        isReplyToBot = Boolean(
          (repliedConversationMessageId &&
            senderService.isBotMessage(peerId, repliedConversationMessageId)) ||
          (repliedMessageId > 0 && senderService.isBotMessage(peerId, repliedMessageId)),
        );
        const groupIdMatch = config.VK_GROUP_ID.match(/^(?:club|public)?(\d+)$/i);
        const groupId = groupIdMatch ? Number(groupIdMatch[1]) : Number.NaN;
        if (!isReplyToBot && repliedMessage) {
          isReplyToBot =
            repliedMessage.senderId === -groupId ||
            repliedMessage.senderId === groupId ||
            repliedMessage.isOutbox;
        }
        if (
          !isReplyToBot &&
          repliedMessage &&
          (repliedMessage.senderId === 0 || repliedMessage.senderId === peerId)
        ) {
          try {
            await repliedMessage.loadMessagePayload({ force: true });
            isReplyToBot =
              repliedMessage.senderId === -groupId ||
              repliedMessage.senderId === groupId ||
              repliedMessage.isOutbox;
          } catch (err) {
            logger.warn(
              {
                err,
                peerId,
                conversationMessageId: repliedConversationMessageId,
              },
              'Failed to load replied message',
            );
          }
        }
      }
      const imageCommand = detectorService.parseImageCommand(text);
      const command = imageCommand ? null : detectorService.parseCommand(text);
      if (context.isChat && !detectorService.isAddressed(text, isReplyToBot)) {
        if (text.trim()) {
          try {
            await memoryService.addMessage({
              conversationId: String(peerId),
              vkUserId: senderId,
              displayName,
              role: 'user',
              content: text,
            });
          } catch (err) {
            logger.warn({ err, peerId, senderId }, 'Failed to save chat message for summaries');
          }
        }
        return next();
      }

      let replyToMessageId: number | undefined;
      let conversationMessageId: number | undefined;
      if (context.isChat) {
        if (context.id === 0 && context.conversationMessageId) {
          try {
            await context.loadMessagePayload();
          } catch (err) {
            logger.warn(
              { err, peerId, conversationMessageId: context.conversationMessageId },
              'Failed to load addressed message',
            );
          }
        }

        replyToMessageId = context.id > 0 ? context.id : undefined;
        conversationMessageId = context.conversationMessageId || undefined;
        if (!replyToMessageId && !conversationMessageId) {
          logger.warn(
            { peerId, messageId: context.id },
            'Cannot reply because VK message ID is unavailable',
          );
        }
      }
      const replyOptions = { replyTo: replyToMessageId, conversationMessageId };

      // Add task to per-user queue to avoid parallel responses
      void requestQueue.add(senderId, async () => {
        try {
          logger.info({ peerId, senderId, text }, 'Incoming message');

          let sourcePhoto: PhotoAttachment | undefined;
          if (imageCommand) {
            if (imageCommand.action === 'edit') {
              sourcePhoto = await this.getPhotoAttachment(context);
              if (!sourcePhoto) {
                await senderService.send(
                  Number(peerId),
                  'Чтобы преобразить изображение, прикрепи фотографию к команде или ответь командой на сообщение с фотографией.',
                  replyOptions,
                );
                return;
              }
            }

            const stopTyping = this.startTyping(peerId);
            try {
              let image: GeneratedImage;
              if (imageCommand.action === 'generate') {
                image = await imageGenerationService.generate(imageCommand.prompt);
              } else if (sourcePhoto) {
                image = await imageGenerationService.edit(sourcePhoto, imageCommand.prompt);
              } else {
                throw new Error('No source photo was provided');
              }
              await senderService.sendPhoto(
                Number(peerId),
                image,
                imageCommand.action === 'generate'
                  ? 'Готово! Вот изображение по твоему описанию.'
                  : 'Готово! Вот преобразованное изображение.',
                replyOptions,
              );
            } catch (err) {
              logger.error({ err, peerId, senderId }, 'Image generation or editing failed');
              await senderService.send(
                Number(peerId),
                'Не удалось создать или преобразовать изображение. Проверьте CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN и доступ к выбранной модели, затем попробуйте ещё раз.',
                replyOptions,
              );
            } finally {
              stopTyping();
            }
            return;
          }

          // If this is a command, handle it and return
          if (command) {
            if (command === 'summary' && context.isChat) {
              const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
              const users = await memoryService.getRecentConversationUsers(String(peerId), since);
              for (const user of users) {
                if (user.displayName && user.displayName !== user.vkId) continue;
                const name = await this.getUserDisplayName(Number(user.vkId));
                if (name) await memoryService.updateUserDisplayName(user.vkId, name);
              }
            }
            const args = text.replace(/^\/?\!?\w+\s*/, '');
            const result = await commandService.handleCommand(
              command,
              args,
              String(peerId),
              senderId,
            );
            if (result) await senderService.send(Number(peerId), result, replyOptions);
            return;
          }

          await memoryService.addMessage({
            conversationId: String(peerId),
            vkUserId: senderId,
            displayName,
            role: 'user',
            content: text,
          });

          const aiMessages: AIMessage[] = [
            {
              role: 'system',
              content:
                'Ты — ИИ-ассистент в VK. Твоё имя — Пенёк: представляйся Пенёк, когда спрашивают, как тебя зовут, но не своди свою личность только к имени или слову «бот». Ты умеешь поддерживать разговор, отвечать на вопросы и помогать с задачами текстом; используй доступный контекст беседы, но не выдумывай факты и возможности. Честно говори, если чего-то не знаешь или не можешь сделать. Для изображений доступны команды «Пенёк, нарисуй <описание>» для генерации и «Пенёк, преобрази <описание>» для редактирования прикреплённой фотографии или фотографии, на которую ответили. В беседах доступна команда «Пенёк пересказ» (также «Пенек пересказ») — краткий пересказ текстовых сообщений за последние два часа. Команды /help и !help показывают справку, /ping и !ping проверяют отклик, /reset и !reset очищают твою историю с текущим пользователем в этом диалоге, /forget и !forget удаляют историю этого пользователя, /system <текст> и !system <текст> добавляют системную инструкцию в его контекст. Слеш-команды доступны также в личных сообщениях; пересказ предназначен для бесед. Когда спрашивают о командах или возможностях, объясни их простыми словами и не утверждай, что можешь выполнять действия, которых нет в этом списке.',
            },
          ];
          const ctx = await memoryService.getContextForUser(String(peerId), senderId);
          for (const m of ctx)
            aiMessages.push({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
            });

          try {
            const mod = await import('../ai/providerFactory.js');
            const provider: AIProvider = mod.getAIProvider();
            const stopTyping = this.startTyping(peerId);
            let resp: AIResponse;
            try {
              resp = await provider.send(aiMessages, {
                maxTokens: 1500,
                sessionId: `${peerId}:${senderId}`,
              });
            } finally {
              stopTyping();
            }

            await memoryService.addMessage({
              conversationId: String(peerId),
              vkUserId: senderId,
              displayName,
              role: 'assistant',
              content: resp.content,
              provider: resp.provider || provider.name,
              tokens: resp.tokens,
            });

            await senderService.send(Number(peerId), resp.content, replyOptions);
          } catch (err) {
            logger.warn({ err }, 'AI provider not available or failed');
            await senderService.send(
              Number(peerId),
              'AI не настроен или произошла ошибка при запросе к провайдеру.',
              replyOptions,
            );
          }
        } catch (err) {
          logger.error({ err }, 'Failed to handle queued message');
        }
      });

      return next();
    });

    // Start receiving updates
    await this.vk.updates.start();
    logger.info('VkService started');
  }

  /**
   * Отправляет сообщение в VK. Разбивает длинные тексты на части.
   */
  async sendMessage(peerId: string, text: string) {
    const MAX_LEN = 4000;
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += MAX_LEN) parts.push(text.slice(i, i + MAX_LEN));

    for (const part of parts) {
      await this.vk.api.messages.send({
        peer_id: Number(peerId),
        random_id: Date.now() % 1e9,
        message: part,
      });
    }
  }
}

export default new VkService();
