import config from '../../config/index.js';
import { normalizeCommandName } from '../command/commandAliases.js';

export type ImageCommand = {
  action: 'generate' | 'edit';
  prompt: string;
};

const botNameAliasPattern = /(?<![\p{L}\p{N}_])(?:пенек|пенечек)(?![\p{L}\p{N}_])/u;
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
      `^\\s*(?:@(?:club|public)?${groupIdMatch[1]}\\b|\\[(?:club|public)?${groupIdMatch[1]}\\|[^\\]]+\\])[,!:;]?\\s*`,
      'iu',
    );
    commandText = commandText.replace(mentionPattern, '');
  }

  return commandText.trimStart();
}

/**
 * Определяет обращения к боту и разбирает команды.
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
    const match = this.stripBotAddressPrefix(text)
      .trim()
      .match(/^[/!]([^\s]+)(?:\s+([\s\S]*))?$/u);
    if (!match) return null;
    const command = normalizeCommandName(match[1]);
    if (command !== 'image' && command !== 'edit') return null;
    return { action: command === 'edit' ? 'edit' : 'generate', prompt: match[2]?.trim() ?? '' };
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
    if (t.startsWith('/') || t.startsWith('!')) {
      const command = t.split(/\s+/u)[0].slice(1);
      return command ? normalizeCommandName(command) : null;
    }
    return null;
  }
}

const detectorService = new DetectorService();
export default detectorService;
