import type { PublicProfileFact } from '../../contracts/profile-facts';
import type { ContextMessage } from '../../storage/context-types';
import type { AgentLoopMessage } from '../agent-loop/types';

interface ContextEntry {
  readonly message: ContextMessage;
  readonly truncated?: boolean;
}

const dataPrefix = JSON.stringify({ kind: 'untrusted_chat_data' }).slice(0, -1) + ',';
// Поле и запятая внутри существующего объекта, без внешних скобок.
export const dataMarkerBytes = Buffer.byteLength(dataPrefix) - 1;

export function createContextMessageFormatter(
  current: ContextMessage,
  group: boolean,
  timezone: string,
  addressForm?: string,
) {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  function authorLabel(message: ContextMessage) {
    const number = message.authorNumber;
    if (
      group &&
      message.role === 'user' &&
      number !== undefined &&
      Number.isSafeInteger(number) &&
      number > 0
    )
      return `u${number}`;
    return undefined;
  }

  function serializeEntry({ message, truncated }: ContextEntry, currentForm?: string): string {
    return JSON.stringify({
      author: message.authorName,
      ...(currentForm === undefined ? {} : { addressForm: currentForm }),
      authorLabel: authorLabel(message),
      time: time.format(message.timestamp),
      bot: message.role === 'assistant',
      text:
        message.text ||
        (message.attachmentCount === 1
          ? '[Вложение: содержимое недоступно.]'
          : '[Текст сообщения отсутствует; содержимое недоступно.]'),
      ...(truncated ? { truncated: true } : {}),
    });
  }

  const prefix = group ? dataPrefix + '"history":[' : dataPrefix;
  const replyPrefix = group ? '],"reply":' : '"reply":';
  const suffix = `,"current":${serializeEntry({ message: current }, addressForm)}}`;
  return {
    fixedLatestTextBytes: Buffer.byteLength(prefix + replyPrefix + suffix, 'utf8'),
    authorLabel,
    serializeEntry,
    serializeHistoryEntry(entry: ContextEntry): AgentLoopMessage {
      const data = serializeEntry(entry);
      // В группе запись становится элементом общего массива history.
      return { role: entry.message.role, text: group ? data : `${dataPrefix}"history":${data}}` };
    },
    messages(
      history: readonly AgentLoopMessage[],
      replyJson: string,
      evidenceField = '',
    ): readonly AgentLoopMessage[] {
      const latest = replyPrefix + replyJson + evidenceField + suffix;
      if (group) {
        return [
          { role: 'user', text: prefix + history.map((entry) => entry.text).join(',') + latest },
        ];
      }
      return [...history, { role: 'user', text: prefix + latest }];
    },
  };
}

export function serializeParticipantCard(card: {
  readonly author: string;
  readonly authorLabel: string | undefined;
  readonly addressForm?: string;
  readonly facts?: readonly PublicProfileFact[];
}) {
  return JSON.stringify({
    author: card.author,
    authorLabel: card.authorLabel,
    addressForm: card.addressForm,
    ...(card.facts?.length
      ? {
          facts: card.facts.map(({ fieldKey, value, sourceKind, reliability, stale }) => ({
            fieldKey,
            value,
            sourceKind,
            reliability,
            ...(stale ? { stale } : {}),
          })),
        }
      : {}),
  });
}

export function appendParticipantCards(text: string, parts: readonly string[]) {
  return text.slice(0, -1) + ',"participantCards":[' + parts.join(',') + ']}';
}
