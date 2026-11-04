import config from '../../config/index.js';

const botNameAliasPattern = /(?<![\p{L}\p{N}_])(?:бот|пенек|пенечек)(?![\p{L}\p{N}_])/u;

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/ё/gi, 'е')
    .toLowerCase()
    .trim();
}

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
  isAddressed(text: string, isReplyToBot = false): boolean {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    if (t.startsWith('/') || t.startsWith('!')) return true;
    if (this.isMentioned(text)) return true;
    if (isReplyToBot) return true;

    return false;
  }

  isMentioned(text: string): boolean {
    if (!text) return false;
    const t = normalizeText(text);
    const botName = normalizeText(this.botName);
    if (t.includes(`@${botName}`)) return true;
    if (
      new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(botName)}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(t)
    ) {
      return true;
    }
    if (botNameAliasPattern.test(t)) return true;

    const groupId = config.VK_GROUP_ID.trim();
    if (
      groupId &&
      new RegExp(`(?:@(?:club|public)?${groupId}\\b|\\[(?:club|public)?${groupId}\\|)`, 'i').test(
        text,
      )
    ) {
      return true;
    }

    return false;
  }

  parseCommand(text: string): string | null {
    if (!text) return null;
    const t = text.trim();
    const normalized = normalizeText(t);
    if (/^(?:бот|пенек|пенечек)\s+пересказ(?:\s|[.!?,…]|$)/u.test(normalized)) {
      return 'summary';
    }
    if (t.startsWith('/')) return t.split(' ')[0].slice(1).toLowerCase();
    if (t.startsWith('!')) return t.split(' ')[0].slice(1).toLowerCase();
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const detectorService = new DetectorService();
export default detectorService;
