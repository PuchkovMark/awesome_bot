import { VK } from 'vk-io';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';

/**
 * SenderService — отвечает за отправку сообщений в VK и разбиение длинных текстов.
 */
export class SenderService {
  private vk: VK;
  private MAX_LEN = 4000;

  constructor() {
    this.vk = new VK({ token: config.VK_TOKEN });
  }

  async send(peerId: number, text: string): Promise<void> {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += this.MAX_LEN) parts.push(text.slice(i, i + this.MAX_LEN));

    for (const part of parts) {
      try {
        await this.vk.api.messages.send({ peer_id: peerId, random_id: Date.now() % 1e9, message: part });
      } catch (err) {
        logger.error({ err, peerId }, 'Failed to send message');
      }
    }
  }
}

const senderService = new SenderService();
export default senderService;
