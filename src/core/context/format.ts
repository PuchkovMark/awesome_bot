import type { StoredMessage } from '../../storage/context-types';
import type { AgentLoopMessage } from '../agent-loop/types';
export interface ContextEntry {
  readonly message: StoredMessage;
  readonly truncated?: boolean;
}

const dataMarker = { kind: 'untrusted_chat_data' } as const;
// Поле и запятая внутри существующего объекта, без внешних скобок.
export const dataMarkerBytes = Buffer.byteLength(JSON.stringify(dataMarker)) - 1;

function formatData(fields: object): string {
  return JSON.stringify({ ...dataMarker, ...fields });
}

export function createMessageTimeFormatter(timezone: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function messageData(entry: ContextEntry, time: Intl.DateTimeFormat) {
  const m = entry.message;
  return {
    author: m.authorName,
    time: time.format(m.timestamp),
    bot: m.role === 'assistant',
    text:
      m.text ||
      (m.attachmentCount === 1
        ? '[Вложение: содержимое недоступно.]'
        : '[Текст сообщения отсутствует; содержимое недоступно.]'),
    ...(entry.truncated ? { truncated: true } : {}),
  };
}
export function formatMessages(
  history: readonly ContextEntry[],
  current: StoredMessage,
  reply: ContextEntry | null,
  replyState: string,
  group: boolean,
  time: Intl.DateTimeFormat,
): readonly AgentLoopMessage[] {
  const quote = reply
    ? messageData(reply, time)
    : replyState === 'unavailable'
      ? { unavailable: true }
      : null;
  const latest = { reply: quote, current: messageData({ message: current }, time) };
  if (group)
    return [
      {
        role: 'user',
        text: formatData({ history: history.map((m) => messageData(m, time)), ...latest }),
      },
    ];
  return [
    ...history.map((entry) => ({
      role: entry.message.role,
      text: formatData({ history: messageData(entry, time) }),
    })),
    { role: 'user', text: formatData(latest) },
  ];
}
