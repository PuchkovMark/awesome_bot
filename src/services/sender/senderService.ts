import { VK } from 'vk-io';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';

/**
 * SenderService — отвечает за отправку сообщений в VK и разбиение длинных текстов.
 */
export class SenderService {
  private vk: VK;
  private MAX_LEN = 4000;
  private readonly sentConversationMessages = new Map<number, Set<number>>();
  private readonly maxTrackedMessagesPerPeer = 1000;

  constructor() {
    this.vk = new VK({ token: config.VK_TOKEN });
  }

  async send(
    peerId: number,
    text: string,
    options?: { replyTo?: number; conversationMessageId?: number },
  ): Promise<void> {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += this.MAX_LEN) parts.push(text.slice(i, i + this.MAX_LEN));

    for (const [index, part] of parts.entries()) {
      try {
        const result: unknown = await this.vk.api.messages.send({
          peer_id: peerId,
          random_id: Date.now() % 1e9,
          message: part,
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
