import type { StoredMessage } from '../../storage/context-types';
import type { AgentLoopMessage } from '../agent-loop/types';

interface ContextEntry {
  readonly message: StoredMessage;
  readonly truncated?: boolean;
}

const dataPrefix = JSON.stringify({ kind: 'untrusted_chat_data' }).slice(0, -1) + ',';
// Поле и запятая внутри существующего объекта, без внешних скобок.
export const dataMarkerBytes = Buffer.byteLength(dataPrefix) - 1;

export function createContextMessageFormatter(
  current: StoredMessage,
  group: boolean,
  timezone: string,
) {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  });

  function serializeEntry({ message, truncated }: ContextEntry): string {
    return JSON.stringify({
      author: message.authorName,
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
  const suffix = `,"current":${serializeEntry({ message: current })}}`;
  return {
    fixedLatestTextBytes: Buffer.byteLength(prefix + replyPrefix + suffix, 'utf8'),
    serializeEntry,
    serializeHistoryEntry(entry: ContextEntry): AgentLoopMessage {
      const data = serializeEntry(entry);
      // В группе запись становится элементом общего массива history.
      return { role: entry.message.role, text: group ? data : `${dataPrefix}"history":${data}}` };
    },
    messages(history: readonly AgentLoopMessage[], replyJson: string): readonly AgentLoopMessage[] {
      const latest = replyPrefix + replyJson + suffix;
      if (group) {
        return [
          { role: 'user', text: prefix + history.map((entry) => entry.text).join(',') + latest },
        ];
      }
      return [...history, { role: 'user', text: prefix + latest }];
    },
  };
}
