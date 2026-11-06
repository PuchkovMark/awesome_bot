import { Keyboard, VK } from 'vk-io';
import sharp from 'sharp';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import type { GeneratedImage } from '../image/imageGenerationService.js';
import splitterService from '../splitter/splitterService.js';
import type { PersonalityDefinition } from '../settings/personalityService.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * SenderService — отвечает за отправку сообщений в VK и разбиение длинных текстов.
 */
export class SenderService {
  private vk: VK;
  private readonly sentConversationMessages = new Map<number, Set<number>>();
  private readonly maxTrackedMessagesPerPeer = 1000;

  constructor() {
    this.vk = new VK({ token: config.VK_TOKEN });
  }

  async send(
    peerId: number,
    text: string,
    options?: { replyTo?: number; conversationMessageId?: number; keyboard?: string },
  ): Promise<void> {
    const parts = splitterService.split(text);

    for (const [index, part] of parts.entries()) {
      try {
        const result: unknown = await this.vk.api.messages.send({
          peer_id: peerId,
          random_id: Date.now() % 1e9,
          message: part,
          keyboard: index === 0 ? options?.keyboard : undefined,
          forward:
            index === 0 && (options?.replyTo || options?.conversationMessageId)
              ? JSON.stringify({
                  ...(options.conversationMessageId
                    ? { conversation_message_ids: options.conversationMessageId }
                    : { message_ids: options.replyTo }),
                  peer_id: peerId,
                  is_reply: true,
                })
              : undefined,
        });
        if (typeof result === 'number' && result > 0) {
          this.trackSentMessage(peerId, result);
        } else if (Array.isArray(result)) {
          for (const message of result) {
            if (
              typeof message === 'object' &&
              message !== null &&
              'peer_id' in message &&
              message.peer_id === peerId
            ) {
              if ('message_id' in message && typeof message.message_id === 'number') {
                this.trackSentMessage(peerId, message.message_id);
              }
              if (
                'conversation_message_id' in message &&
                typeof message.conversation_message_id === 'number'
              ) {
                this.trackSentMessage(peerId, message.conversation_message_id);
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, peerId }, 'Failed to send message');
        throw err;
      }
    }
  }

  async sendSummary(
    peerId: number,
    text: string,
    selectedHours: 2 | 6,
    options?: { replyTo?: number; conversationMessageId?: number },
  ): Promise<void> {
    await this.send(peerId, text, {
      ...options,
      keyboard: this.createSummaryKeyboard(selectedHours),
    });
  }

  async sendPersonalityMenu(
    peerId: number,
    text: string,
    profiles: PersonalityDefinition[],
    selectedId: string,
    scope: 'direct' | 'chat',
    options?: { replyTo?: number; conversationMessageId?: number },
  ): Promise<void> {
    const keyboard = Keyboard.builder();
    profiles.slice(0, 50).forEach((profile, index) => {
      if (index > 0 && index % 5 === 0) keyboard.row();
      keyboard.callbackButton({
        label: profile.name.slice(0, 40),
        payload: { command: 'personality_select', scope, id: profile.id },
        color: profile.id === selectedId ? Keyboard.POSITIVE_COLOR : Keyboard.PRIMARY_COLOR,
      });
    });
    await this.send(peerId, text, { ...options, keyboard: keyboard.inline().toString() });
  }

  async editSummary(
    peerId: number,
    conversationMessageId: number,
    text: string,
    selectedHours: 2 | 6,
  ): Promise<void> {
    try {
      await this.vk.api.messages.edit({
        peer_id: peerId,
        cmid: conversationMessageId,
        message: text,
        keyboard: this.createSummaryKeyboard(selectedHours),
      });
    } catch (err) {
      logger.error({ err, peerId, conversationMessageId }, 'Failed to edit summary message');
      throw err;
    }
  }

  private createSummaryKeyboard(selectedHours: 2 | 6): string {
    return Keyboard.builder()
      .callbackButton({
        label: 'За 2 часа',
        payload: { command: 'summary', hours: 2 },
        color: selectedHours === 2 ? Keyboard.POSITIVE_COLOR : Keyboard.PRIMARY_COLOR,
      })
      .callbackButton({
        label: 'За 6 часов',
        payload: { command: 'summary', hours: 6 },
        color: selectedHours === 6 ? Keyboard.POSITIVE_COLOR : Keyboard.PRIMARY_COLOR,
      })
      .inline()
      .toString();
  }

  async sendPhoto(
    peerId: number,
    image: GeneratedImage,
    caption: string,
    options?: { replyTo?: number; conversationMessageId?: number },
  ): Promise<void> {
    try {
      if (image.buffer.length === 0) {
        throw new Error('Generated image is empty');
      }
      const jpeg = await sharp(image.buffer).jpeg({ quality: 90 }).toBuffer();
      const metadata = await sharp(jpeg).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error('Generated image has invalid dimensions');
      }

      const uploadServer = await this.vk.api.photos.getMessagesUploadServer({
        peer_id: peerId,
      });
      const form = new FormData();
      form.append(
        'photo',
        new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
        'generated-image.jpg',
      );
      const uploadResponse = await fetch(uploadServer.upload_url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!uploadResponse.ok) {
        throw new Error(`VK photo upload failed (${uploadResponse.status})`);
      }

      const uploadPayload: unknown = await uploadResponse.json();
      const uploadResult =
        isRecord(uploadPayload) && 'response' in uploadPayload
          ? uploadPayload.response
          : uploadPayload;
      if (!isRecord(uploadResult)) {
        throw new Error('VK photo upload returned an invalid response');
      }
      const uploaded = uploadResult;
      if (
        typeof uploaded.photo !== 'string' ||
        uploaded.photo.length === 0 ||
        (typeof uploaded.server !== 'number' && typeof uploaded.server !== 'string') ||
        !Number.isFinite(Number(uploaded.server)) ||
        typeof uploaded.hash !== 'string' ||
        uploaded.hash.length === 0
      ) {
        const keys = Object.keys(uploaded).join(', ') || 'none';
        const photoLength = typeof uploaded.photo === 'string' ? uploaded.photo.length : 0;
        throw new Error(
          `VK photo upload returned incomplete data (keys: ${keys}, photo length: ${photoLength})`,
        );
      }

      const [photo] = await this.vk.api.photos.saveMessagesPhoto({
        server: Number(uploaded.server),
        photo: uploaded.photo,
        hash: uploaded.hash,
      });
      if (!photo?.id || !photo.owner_id) {
        throw new Error('VK did not save the uploaded photo');
      }

      const result: unknown = await this.vk.api.messages.send({
        peer_id: peerId,
        random_id: Date.now() % 1e9,
        message: caption,
        attachment: `photo${photo.owner_id}_${photo.id}`,
        forward:
          options?.replyTo || options?.conversationMessageId
            ? JSON.stringify({
                ...(options.conversationMessageId
                  ? { conversation_message_ids: options.conversationMessageId }
                  : { message_ids: options.replyTo }),
                peer_id: peerId,
                is_reply: true,
              })
            : undefined,
      });
      if (typeof result === 'number' && result > 0) {
        this.trackSentMessage(peerId, result);
      } else if (Array.isArray(result)) {
        for (const message of result) {
          if (
            typeof message !== 'object' ||
            message === null ||
            !('peer_id' in message) ||
            message.peer_id !== peerId
          ) {
            continue;
          }
          if ('message_id' in message && typeof message.message_id === 'number') {
            this.trackSentMessage(peerId, message.message_id);
          }
          if (
            'conversation_message_id' in message &&
            typeof message.conversation_message_id === 'number'
          ) {
            this.trackSentMessage(peerId, message.conversation_message_id);
          }
        }
      }
    } catch (err) {
      logger.error({ err, peerId }, 'Failed to send generated photo');
      throw err;
    }
  }

  async sendVoice(
    peerId: number,
    audio: Buffer,
    text: string,
    options?: { replyTo?: number; conversationMessageId?: number },
  ): Promise<void> {
    if (audio.length === 0) throw new Error('Generated voice message is empty');
    const attachment = await this.vk.upload.audioMessage({
      peer_id: peerId,
      source: {
        value: audio,
        filename: 'voice.ogg',
        contentType: 'audio/ogg',
        contentLength: audio.length,
      },
    });
    const result: unknown = await this.vk.api.messages.send({
      peer_id: peerId,
      random_id: Date.now() % 1e9,
      message: text,
      attachment: attachment.toString(),
      forward:
        options?.replyTo || options?.conversationMessageId
          ? JSON.stringify({
              ...(options.conversationMessageId
                ? { conversation_message_ids: options.conversationMessageId }
                : { message_ids: options.replyTo }),
              peer_id: peerId,
              is_reply: true,
            })
          : undefined,
    });
    if (typeof result === 'number' && result > 0) {
      this.trackSentMessage(peerId, result);
    } else if (Array.isArray(result)) {
      for (const message of result) {
        if (
          isRecord(message) &&
          'peer_id' in message &&
          message.peer_id === peerId &&
          'conversation_message_id' in message &&
          typeof message.conversation_message_id === 'number'
        ) {
          this.trackSentMessage(peerId, message.conversation_message_id);
        }
      }
    }
  }

  isBotMessage(peerId: number, messageId: number): boolean {
    return this.sentConversationMessages.get(peerId)?.has(messageId) ?? false;
  }

  private trackSentMessage(peerId: number, conversationMessageId: number): void {
    let messageIds = this.sentConversationMessages.get(peerId);
    if (!messageIds) {
      messageIds = new Set<number>();
      this.sentConversationMessages.set(peerId, messageIds);
    }

    messageIds.add(conversationMessageId);
    if (messageIds.size > this.maxTrackedMessagesPerPeer) {
      const oldest = messageIds.values().next().value;
      if (oldest !== undefined) messageIds.delete(oldest);
    }
  }
}

const senderService = new SenderService();
export default senderService;
