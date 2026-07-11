import config from '../../config';

/**
 * DetectorService — определяет, обращаются ли к боту в чате, и парсит команды.
 */
export class DetectorService {
  private botName: string;

  constructor() {
    this.botName = config.BOT_NAME.toLowerCase();
  }

  /**
   * Возвращает true если сообщение адресовано боту.
   */
  isAddressed(text: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    if (t.startsWith('/') || t.startsWith('!')) return true;
    if (t.includes(`@${this.botName}`)) return true;
    if (t.startsWith(this.botName)) return true;
    return false;
  }

  parseCommand(text: string): string | null {
    if (!text) return null;
    const t = text.trim();
    if (t.startsWith('/')) return t.split(' ')[0].slice(1).toLowerCase();
    if (t.startsWith('!')) return t.split(' ')[0].slice(1).toLowerCase();
    return null;
  }
}

const detectorService = new DetectorService();
export default detectorService;
