import { VK, type MessageContext } from 'vk-io';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import memoryService from '../memory/memoryService.js';
import type { AIMessage } from '../ai/AIProvider.js';
import requestQueue from '../queue/requestQueue.js';
import senderService from '../sender/senderService.js';
import detectorService from '../detector/detectorService.js';
import commandService from '../command/commandService.js';

/**
 * VkService — инициализация VK API и обработка входящих сообщений.
 */
export class VkService {
  private vk: VK;

  constructor() {
    this.vk = new VK({ token: config.VK_TOKEN });
  }

  /**
   * Запуск обработки обновлений. Хендлер сохраняет сообщение и вызывает AI.
   */
  async start() {
    if (!config.VK_TOKEN) {
      logger.warn('VK_TOKEN not set; VkService will not start (development mode)');
      return;
    }

    this.vk.updates.on('message', (context: MessageContext, next) => {
      if (context.isOutbox) return next();

      const peerId = context.peerId;
      const senderId = String(context.senderId);
      const text = context.text ?? '';

      // If message not addressed to bot in chats, ignore
      if (context.isChat && !detectorService.isAddressed(text)) return next();

      // Add task to per-user queue to avoid parallel responses
      void requestQueue.add(senderId, async () => {
        try {
          logger.info({ peerId, senderId, text }, 'Incoming message');

          // If this is a command, handle it and return
          const cmd = detectorService.parseCommand(text);
          if (cmd) {
            const args = text.replace(/^\/?\!?\w+\s*/, '');
            const result = await commandService.handleCommand(cmd, args, String(peerId), senderId);
            if (result) await senderService.send(Number(peerId), result);
            return;
          }

          await memoryService.addMessage({ conversationId: String(peerId), vkUserId: senderId, role: 'user', content: text });

          const aiMessages: AIMessage[] = [];
          const ctx = await memoryService.getContextForUser(String(peerId), senderId);
          for (const m of ctx) aiMessages.push({ role: m.role as 'user' | 'assistant' | 'system', content: m.content });
          aiMessages.push({ role: 'user', content: text });

          try {
            const mod = await import('../ai/providerFactory.js');
            const provider = mod.getAIProvider() as import('../ai/AIProvider.js').default;
            const resp = await provider.send(aiMessages, { maxTokens: 1500 });

            await memoryService.addMessage({ conversationId: String(peerId), role: 'assistant', content: resp.content, provider: provider.name, tokens: resp.tokens });

            await senderService.send(Number(peerId), resp.content);
          } catch (err) {
            logger.warn({ err }, 'AI provider not available or failed');
            await senderService.send(Number(peerId), 'AI не настроен или произошла ошибка при запросе к провайдеру.');
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
      await this.vk.api.messages.send({ peer_id: Number(peerId), random_id: Date.now() % 1e9, message: part });
    }
  }
}

export default new VkService();
