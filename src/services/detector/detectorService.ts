import config from '../../config/index.js';
import { normalizeCommandName } from '../command/commandAliases.js';

export type ImageCommand = {
  action: 'generate' | 'edit';
  prompt: string;
};

const botNameAliasPattern = /(?<![\p{L}\p{N}_])(?:пенек|пенечек)(?![\p{L}\p{N}_])/u;
const rejectedBotAddressPattern = /^\s*@?бот(?=$|[\s,!:;])/iu;
const memberProfileCommands = new Set([
  'анкета',
  'анкеты',
  'профиль',
  'profile',
  'profiles',
  'удалить',
  'подтвердить',
]);

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/ё/gi, 'е')
    .toLowerCase()
    .trim();
}

function stripBotAddressPrefix(text: string): string {
  const botNamePrefix = /^\s*(?:пен[её]к|пен[её]чек)(?:[,!:;]\s*|\s+)/iu.exec(text);
  let commandText = botNamePrefix ? text.slice(botNamePrefix[0].length) : text;

  const groupIdMatch = config.VK_GROUP_ID.trim().match(/^(?:club|public)?(\d+)$/i);
  if (groupIdMatch?.[1]) {
    const mentionPattern = new RegExp(
      `(?:@(?:club|public)?${groupIdMatch[1]}\\b|\\[(?:club|public)?${groupIdMatch[1]}\\|[^\\]]+\\])[,!:;]?`,
      'giu',
    );
    commandText = commandText.replace(mentionPattern, ' ');
  }

  return commandText.trimStart();
}

/**
 * Определяет адресованные боту сообщения, команды и другие распознаваемые намерения.
 */
export class DetectorService {
  /**
   * Возвращает true если сообщение адресовано боту.
   */
  isAddressed(text: string, isReplyToBot = false): boolean {
    return this.isExplicitlyAddressed(text, isReplyToBot);
  }

  isExplicitlyAddressed(text: string, isReplyToBot = false): boolean {
    return Boolean(text) && (this.isMentioned(text) || isReplyToBot);
  }

  stripBotAddressPrefix(text: string): string {
    return stripBotAddressPrefix(text);
  }

  isActiveEvent(text: string): boolean {
    if (rejectedBotAddressPattern.test(normalizeText(text))) return false;
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
    const commandText = this.stripBotAddressPrefix(text);
    const slashCommand = commandText
      .trim()
      .match(/^[/!](image|edit|изображение|преобразить)(?:\s+([\s\S]*))?$/iu);
    if (slashCommand) {
      return {
        action: /^(?:edit|преобразить)$/iu.test(slashCommand[1]) ? 'edit' : 'generate',
        prompt: slashCommand[2]?.trim() ?? '',
      };
    }

    const normalized = normalizeText(commandText);
    const match = normalized.match(
      /^(?:(?:пенек|пенечек)[,!:;]?\s+)?(нарисуй|сгенерируй|создай(?:\s+картинку)?|преобрази|измени|переделай)\s+([\s\S]+)$/u,
    );
    if (!match) return null;

    const action = /^(?:преобрази|измени|переделай)$/u.test(match[1]) ? 'edit' : 'generate';
    const prompt = commandText
      .trim()
      .match(
        /^(?:(?:пенёк|пенек|пенёчек|пенечек)[,!:;]?\s+)?(?:нарисуй|сгенерируй|создай(?:\s+картинку)?|преобрази|измени|переделай)\s+([\s\S]+)$/iu,
      )?.[1];
    if (!prompt?.trim()) return null;

    return { action, prompt: prompt.trim() };
  }

  isFreeformMessage(
    text: string,
    command: string | null,
    imageCommand: ImageCommand | null,
  ): boolean {
    return Boolean(text.trim()) && !command && !imageCommand;
  }

  isMemberProfileCommand(command: string | null): boolean {
    return command !== null && memberProfileCommands.has(command);
  }

  parseCommand(text: string): string | null {
    if (!text) return null;
    const t = this.stripBotAddressPrefix(text).trim();
    const normalized = normalizeText(t);
    if (/^пересказ(?:\s|[.!?,…]|$)/u.test(normalized)) {
      return 'summary';
    }
    if (/^анкета[!.?]*$/u.test(normalized)) return 'анкета';
    if (/^анкеты(?:\s+\d+)?[!.?]*$/u.test(normalized)) return 'анкеты';
    if (/^профиль[!.?]*$/u.test(normalized)) return 'профиль';
    if (/^удалить\s+профиль[!.?]*$/u.test(normalized)) return 'удалить';
    if (/^подтвердить\s+удаление\s+профиля[!.?]*$/u.test(normalized)) return 'подтвердить';
    if (t.startsWith('/') || t.startsWith('!')) {
      return normalizeCommandName(t.split(/\s+/u)[0].slice(1));
    }
    return null;
  }
}

const detectorService = new DetectorService();
export default detectorService;
