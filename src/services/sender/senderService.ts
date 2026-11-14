import axios from 'axios';
import { Keyboard, VK } from 'vk-io';
import sharp from 'sharp';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import type { GeneratedImage } from '../image/imageGenerationService.js';
import splitterService, { MAX_VK_MESSAGE_LENGTH } from '../splitter/splitterService.js';
import type { PersonalityDefinition } from '../settings/personalityService.js';

const CHAT_PEER_ID_OFFSET = 2_000_000_000;
const CHAT_TRUNCATION_NOTICE = '\n\n[Ответ сокращён: лимит одного сообщения VK.]';

export const CHAT_REPLY_INSTRUCTION = `Ответ должен помещаться в одно сообщение VK: не более ${MAX_VK_MESSAGE_LENGTH} символов.`;

export function isChatPeer(peerId: number): boolean {
  return peerId > CHAT_PEER_ID_OFFSET;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

let lastRandomId = Date.now() % 0x7fffff00;

/**
 * Возвращает уникальный random_id для messages.send.
 * Монотонный счётчик исключает коллизии при отправке нескольких частей
 * в одну миллисекунду, из-за которых VK молча отбрасывал сообщения.
 */
export function nextRandomId(): number {
  lastRandomId = lastRandomId >= 0x7ffffffe ? 1 : lastRandomId + 1;
  return lastRandomId;
}

type PhotoUploadData = { server: number; photo: string; hash: string };

export function parsePhotoUploadResponse(value: unknown): PhotoUploadData | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  let payload = isRecord(parsed) && 'response' in parsed ? parsed.response : parsed;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;
  const server = Number(payload.server);
  if (
    !Number.isSafeInteger(server) ||
    server <= 0 ||
    typeof payload.photo !== 'string' ||
    !payload.photo.trim() ||
    typeof payload.hash !== 'string' ||
    !payload.hash.trim()
  ) {
    return null;
  }
  return { server, photo: payload.photo, hash: payload.hash };
}

export function parseAudioMessageUploadFile(value: unknown): string | null {
  const payload = isRecord(value) && 'response' in value ? value.response : value;
  return isRecord(payload) && typeof payload.file === 'string' && payload.file.trim()
    ? payload.file
    : null;
}

export function parseSavedAudioMessage(value: unknown): string | null {
  const payload = isRecord(value) && 'response' in value ? value.response : value;
  if (!isRecord(payload) || payload.type !== 'audio_message' || !isRecord(payload.audio_message)) {
    return null;
  }
  const audioMessage = payload.audio_message;
  const id = Number(audioMessage.id);
  const ownerId = Number(audioMessage.owner_id);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(ownerId) || ownerId === 0) {
    return null;
  }
  const accessKey =
    typeof audioMessage.access_key === 'string' && audioMessage.access_key
      ? `_${audioMessage.access_key}`
      : '';
  return `audio_message${ownerId}_${id}${accessKey}`;
}

function isMissingUploadedPhotoError(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === 100 &&
    typeof error.message === 'string' &&
    /photo is undefined/iu.test(error.message)
  );
}

function isRetryableUploadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /gateway time[- ]out|bad gateway|service unavailable|aborted|timed? ?out/iu.test(error.message)
  );
}

/**
 * SenderService — отвечает за отправку сообщений в VK и разбиение длинных текстов.
 */
/**
 * Отправляет текст и вложения через VK API и отслеживает исходящие сообщения бота.
 */
export class SenderService {
  private readonly vk: VK;
  private readonly sentConversationMessages = new Map<number, Set<number>>();
  private readonly maxTrackedMessagesPerPeer = 1000;

  constructor() {
    this.vk = new VK({ token: config.VK_TOKEN, uploadTimeout: 60_000 });
  }

  async canSendPrivateMessage(vkUserId: string | number): Promise<boolean> {
    const userId = Number(vkUserId);
    const groupId = Number(config.VK_GROUP_ID);
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !Number.isSafeInteger(groupId) ||
      groupId <= 0
    ) {
      throw new Error('VK group and user IDs must be positive integers');
    }
    const response: unknown = await this.vk.api.messages.isMessagesFromGroupAllowed({
      group_id: groupId,
      user_id: userId,
    });
    if (typeof response !== 'object' || response === null || !('is_allowed' in response)) {
      throw new Error('VK returned an invalid private-message permission response');
    }
    const allowed = response.is_allowed;
    return allowed === true || allowed === 1 || allowed === '1';
  }

  async send(
    peerId: number,
    text: string,
    options?: {
      replyTo?: number;
      conversationMessageId?: number;
      keyboard?: string;
      randomId?: number;
      attachment?: string;
    },
  ): Promise<void> {
    const parts = splitterService.split(this.formatMessage(peerId, text));
    if (parts.length === 0 && options?.attachment) parts.push('');

    for (const [index, part] of parts.entries()) {
      try {
        const result: unknown = await this.vk.api.messages.send({
          peer_id: peerId,
          random_id:
            index === 0 && options?.randomId !== undefined ? options.randomId : nextRandomId(),
          message: part,
          attachment: index === 0 ? options?.attachment : undefined,
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
          for (const rawMessage of result) {
            const message: unknown = rawMessage;
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

  formatMessage(peerId: number, text: string, suffix = ''): string {
    return isChatPeer(peerId)
      ? splitterService.truncate(text, CHAT_TRUNCATION_NOTICE, suffix)
      : `${text}${suffix}`;
  }

  hasContinuation(peerId: number, text: string): boolean {
    return !isChatPeer(peerId) && text.length > MAX_VK_MESSAGE_LENGTH;
  }

  private async editMessage(
    peerId: number,
    conversationMessageId: number,
    text: string,
    keyboard: string,
    hasContinuations: boolean,
  ): Promise<void> {
    const formatted = this.formatMessage(peerId, text);
    const parts = splitterService.split(formatted);
    if (parts.length === 0) throw new Error('Cannot edit a message with empty text');
    const sendSeparately = !isChatPeer(peerId) && (hasContinuations || parts.length > 1);
    await this.vk.api.messages.edit({
      peer_id: peerId,
      cmid: conversationMessageId,
      message: sendSeparately
        ? 'Обновлённый ответ — в последних сообщениях диалога. Предыдущие части могут быть неактуальны.'
        : parts[0],
      keyboard,
    });
    if (sendSeparately) await this.send(peerId, formatted);
  }

  createMenuPaginationKeyboard(
    menu: 'help' | 'admin',
    page: number,
    totalPages: number,
    hasContinuations = false,
  ): string {
    const keyboard = Keyboard.builder();
    if (page > 1) {
      keyboard.callbackButton({
        label: '◀ Назад',
        payload: { command: 'menu_page', menu, page: page - 1, hasContinuations },
        color: Keyboard.SECONDARY_COLOR,
      });
    }
    if (page < totalPages) {
      keyboard.callbackButton({
        label: 'Далее ▶',
        payload: { command: 'menu_page', menu, page: page + 1, hasContinuations },
        color: Keyboard.PRIMARY_COLOR,
      });
    }
    return keyboard.inline().toString();
  }

  async editMenuPage(
    peerId: number,
    conversationMessageId: number,
    menu: 'help' | 'admin',
    page: number,
    totalPages: number,
    text: string,
    previousHasContinuations = true,
  ): Promise<void> {
    try {
      const hasContinuations =
        this.hasContinuation(peerId, text) || (!isChatPeer(peerId) && previousHasContinuations);
      await this.editMessage(
        peerId,
        conversationMessageId,
        text,
        this.createMenuPaginationKeyboard(menu, page, totalPages, hasContinuations),
        hasContinuations,
      );
    } catch (err) {
      logger.error({ err, peerId, conversationMessageId, menu, page }, 'Failed to edit menu page');
      throw err;
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
      keyboard: this.createSummaryKeyboard(selectedHours, this.hasContinuation(peerId, text)),
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
    profiles.slice(0, 20).forEach((profile, index) => {
      if (index > 0 && index % 2 === 0) keyboard.row();
      const name = Array.from(profile.name);
      keyboard.callbackButton({
        label: name.length > 20 ? `${name.slice(0, 19).join('')}…` : profile.name,
        payload: { command: 'personality_select', scope, id: profile.id },
        color: profile.id === selectedId ? Keyboard.POSITIVE_COLOR : Keyboard.PRIMARY_COLOR,
      });
    });
    const limitNotice =
      profiles.length > 20 ? '\nОстальные персонажи доступны по команде с их ID.' : '';
    await this.send(peerId, `${text}${limitNotice}`, {
      ...options,
      keyboard: keyboard.inline().toString(),
    });
  }

  createFunFeedbackKeyboard(outputId: string): string {
    return Keyboard.builder()
      .callbackButton({
        label: '😂',
        payload: { command: 'fun_feedback', outputId, value: 'laugh' },
        color: Keyboard.POSITIVE_COLOR,
      })
      .callbackButton({
        label: '😐',
        payload: { command: 'fun_feedback', outputId, value: 'neutral' },
        color: Keyboard.SECONDARY_COLOR,
      })
      .callbackButton({
        label: '🔥',
        payload: { command: 'fun_feedback', outputId, value: 'fire' },
        color: Keyboard.POSITIVE_COLOR,
      })
      .callbackButton({
        label: 'Ещё',
        payload: { command: 'fun_again', outputId },
        color: Keyboard.PRIMARY_COLOR,
      })
      .inline()
      .toString();
  }

  createMemeDayVotingKeyboard(publicationId: string): string {
    return Keyboard.builder()
      .callbackButton({
        label: '😂',
        payload: { command: 'meme_vote', publicationId, value: 'laugh' },
        color: Keyboard.POSITIVE_COLOR,
      })
      .callbackButton({
        label: '🔥',
        payload: { command: 'meme_vote', publicationId, value: 'fire' },
        color: Keyboard.POSITIVE_COLOR,
      })
      .callbackButton({
        label: '😐',
        payload: { command: 'meme_vote', publicationId, value: 'neutral' },
        color: Keyboard.SECONDARY_COLOR,
      })
      .callbackButton({
        label: '👎',
        payload: { command: 'meme_vote', publicationId, value: 'dislike' },
        color: Keyboard.NEGATIVE_COLOR,
      })
      .inline()
      .toString();
  }

  async editSummary(
    peerId: number,
    conversationMessageId: number,
    text: string,
    selectedHours: 2 | 6,
    previousHasContinuations = true,
  ): Promise<void> {
    try {
      const hasContinuations =
        this.hasContinuation(peerId, text) || (!isChatPeer(peerId) && previousHasContinuations);
      await this.editMessage(
        peerId,
        conversationMessageId,
        text,
        this.createSummaryKeyboard(selectedHours, hasContinuations),
        hasContinuations,
      );
    } catch (err) {
      logger.error({ err, peerId, conversationMessageId }, 'Failed to edit summary message');
      throw err;
    }
  }

  private createSummaryKeyboard(selectedHours: 2 | 6, hasContinuations: boolean): string {
    return Keyboard.builder()
      .callbackButton({
        label: 'За 2 часа',
        payload: { command: 'summary', hours: 2, hasContinuations },
        color: selectedHours === 2 ? Keyboard.POSITIVE_COLOR : Keyboard.PRIMARY_COLOR,
      })
      .callbackButton({
        label: 'За 6 часов',
        payload: { command: 'summary', hours: 6, hasContinuations },
        color: selectedHours === 6 ? Keyboard.POSITIVE_COLOR : Keyboard.PRIMARY_COLOR,
      })
      .inline()
      .toString();
  }

  async sendPhoto(
    peerId: number,
    image: GeneratedImage,
    caption: string,
    options?: {
      replyTo?: number;
      conversationMessageId?: number;
      keyboard?: string;
      randomId?: number;
    },
  ): Promise<string> {
    try {
      if (image.buffer.length === 0) {
        throw new Error('Generated image is empty');
      }
      let attachment: string | undefined;
      for (const [attempt, settings] of [
        { width: 1600, quality: 82 },
        { width: 1024, quality: 65 },
      ].entries()) {
        const jpeg = await sharp(image.buffer)
          .rotate()
          .flatten({ background: '#ffffff' })
          .resize({
            width: settings.width,
            height: settings.width,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: settings.quality })
          .toBuffer();
        const metadata = await sharp(jpeg).metadata();
        if (!metadata.width || !metadata.height || jpeg.length === 0) {
          throw new Error('VK photo upload image has invalid data or dimensions');
        }

        const uploadServer = await this.vk.api.photos.getMessagesUploadServer({ peer_id: peerId });
        const form = new FormData();
        form.append(
          'photo',
          new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
          'generated-image.jpg',
        );
        let uploadData: unknown;
        try {
          ({ data: uploadData } = await axios.post<unknown>(uploadServer.upload_url, form, {
            timeout: 60_000,
            maxBodyLength: jpeg.length + 1024 * 1024,
            maxContentLength: 1024 * 1024,
          }));
        } catch (err) {
          const status = axios.isAxiosError(err) ? err.response?.status : undefined;
          const code = axios.isAxiosError(err) ? err.code : undefined;
          if (
            attempt === 0 &&
            (status === 408 ||
              status === 429 ||
              (status && status >= 500) ||
              isRetryableUploadError(err))
          ) {
            logger.warn(
              { peerId, status, code, attempt: attempt + 1, imageBytes: jpeg.length },
              'VK photo upload request failed; retrying with a smaller image',
            );
            await new Promise((resolve) => setTimeout(resolve, 750));
            continue;
          }
          logger.warn(
            { peerId, status, code, attempt: attempt + 1 },
            'VK photo upload request failed',
          );
          throw new Error(`VK photo upload failed${status ? ` (${status})` : ''}`, { cause: err });
        }
        const uploaded = parsePhotoUploadResponse(uploadData);
        if (!uploaded) {
          const responseObject =
            isRecord(uploadData) && isRecord(uploadData.response)
              ? uploadData.response
              : uploadData;
          if (attempt === 0) {
            logger.warn(
              {
                peerId,
                attempt: attempt + 1,
                imageBytes: jpeg.length,
                responseType: typeof uploadData,
                responseLength: typeof uploadData === 'string' ? uploadData.length : undefined,
                responseKeys: isRecord(responseObject) ? Object.keys(responseObject) : undefined,
              },
              'VK photo upload returned incomplete data; retrying with a smaller image',
            );
            continue;
          }
          logger.error(
            {
              peerId,
              attempt: attempt + 1,
              imageBytes: jpeg.length,
              responseType: typeof uploadData,
              responseLength: typeof uploadData === 'string' ? uploadData.length : undefined,
              responseKeys: isRecord(responseObject) ? Object.keys(responseObject) : undefined,
            },
            'VK photo upload returned incomplete data after retry',
          );
          throw new Error('VK photo upload returned incomplete data after retry');
        }

        try {
          const [photo] = await this.vk.api.photos.saveMessagesPhoto(uploaded);
          if (!photo?.id || !photo.owner_id) {
            throw new Error('VK did not save the uploaded photo');
          }
          attachment = `photo${photo.owner_id}_${photo.id}`;
          break;
        } catch (error) {
          if (attempt === 0 && isMissingUploadedPhotoError(error)) {
            logger.warn(
              { peerId, attempt: attempt + 1, imageBytes: jpeg.length },
              'VK rejected the uploaded photo; retrying with a smaller image',
            );
            continue;
          }
          throw error;
        }
      }
      if (!attachment) throw new Error('VK photo upload did not produce an attachment');

      await this.send(peerId, caption, { ...options, attachment });
      return attachment;
    } catch (err) {
      logger.error({ err, peerId }, 'Failed to send generated photo');
      throw err;
    }
  }

  private async uploadAudioMessageWithAxios(peerId: number, audio: Buffer): Promise<string> {
    const uploadServer = await this.vk.api.docs.getMessagesUploadServer({
      peer_id: peerId,
      type: 'audio_message',
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice.ogg');
    const { data } = await axios.post<unknown>(uploadServer.upload_url, form, {
      timeout: 60_000,
      maxBodyLength: audio.length + 1024 * 1024,
      maxContentLength: 1024 * 1024,
    });
    const file = parseAudioMessageUploadFile(data);
    if (!file) throw new Error('VK audio upload returned no file token');

    const saved = await this.vk.api.docs.save({ file, title: 'voice.ogg' });
    const attachment = parseSavedAudioMessage(saved);
    if (!attachment) throw new Error('VK did not save the uploaded audio message');
    return attachment;
  }

  async sendPhotoAttachment(
    peerId: number,
    attachment: string,
    caption: string,
    keyboard?: string,
  ): Promise<void> {
    try {
      await this.send(peerId, caption, { attachment, keyboard });
    } catch (error) {
      logger.error({ err: error, peerId, attachment }, 'Failed to send saved meme photo');
      throw error;
    }
  }

  async uploadVoice(peerId: number, audio: Buffer): Promise<string> {
    if (audio.length === 0) throw new Error('Generated voice message is empty');
    let attachment: string | undefined;
    let uploadTimedOut = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const audioMessage = await this.vk.upload.audioMessage({
          peer_id: peerId,
          source: {
            value: audio,
            filename: 'voice.ogg',
            contentType: 'audio/ogg',
            contentLength: audio.length,
          },
        });
        attachment = audioMessage.toString();
        break;
      } catch (error) {
        if (!isRetryableUploadError(error)) throw error;
        if (attempt === 2) {
          uploadTimedOut = true;
          logger.warn(
            { err: error, peerId, attempt, audioBytes: audio.length },
            'VK voice upload timed out; retrying with alternate upload transport',
          );
          break;
        }
        logger.warn(
          { err: error, peerId, attempt, audioBytes: audio.length },
          'VK voice upload timed out; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
    if (!attachment && uploadTimedOut) {
      attachment = await this.uploadAudioMessageWithAxios(peerId, audio);
    }
    if (!attachment) throw new Error('VK voice upload did not produce an attachment');
    return attachment;
  }

  async sendVoice(
    peerId: number,
    audio: Buffer,
    text: string,
    options?: { replyTo?: number; conversationMessageId?: number },
  ): Promise<void> {
    const attachment = await this.uploadVoice(peerId, audio);
    await this.send(peerId, text, { ...options, attachment });
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
