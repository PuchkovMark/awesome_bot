import config from '../../config/index.js';

export type ImageCommand = {
  action: 'generate' | 'edit';
  prompt: string;
};

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

  isActiveEvent(text: string): boolean {
    return (
      /[?？]\s*$/u.test(text.trim()) ||
      /(?<![\p{L}\p{N}_])(?:помоги|подскажи|объясни|расскажи|посоветуй)(?![\p{L}\p{N}_])/iu.test(
        text,
      )
    );
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

  parseImageCommand(text: string): ImageCommand | null {
    if (!text) return null;
    const slashCommand = text.trim().match(/^\/(image|edit)(?:\s+([\s\S]*))?$/iu);
    if (slashCommand) {
      return {
        action: slashCommand[1].toLowerCase() === 'edit' ? 'edit' : 'generate',
        prompt: slashCommand[2]?.trim() ?? '',
      };
    }

    const normalized = normalizeText(text);
    const match = normalized.match(
      /^(?:(?:бот|пенек|пенечек)[,!:;]?\s+)?(нарисуй|сгенерируй|создай(?:\s+картинку)?|преобрази|измени|переделай)\s+([\s\S]+)$/u,
    );
    if (!match) return null;

    const action = /^(?:преобрази|измени|переделай)$/u.test(match[1]) ? 'edit' : 'generate';
    const prompt = text
      .trim()
      .match(
        /^(?:(?:бот|пенёк|пенек|пенёчек|пенечек)[,!:;]?\s+)?(?:нарисуй|сгенерируй|создай(?:\s+картинку)?|преобрази|измени|переделай)\s+([\s\S]+)$/iu,
      )?.[1];
    if (!prompt?.trim()) return null;

    return { action, prompt: prompt.trim() };
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
