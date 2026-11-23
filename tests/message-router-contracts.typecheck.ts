import type { IncomingMessage, ConnectionScope } from '../src/contracts/index';
import type { ContextMessageReader } from '../src/storage/context-types';
import type { QueueHandler } from '../src/core/chat-queue/types';
export function contracts(
  message: IncomingMessage,
  reader: ContextMessageReader,
  scope: ConnectionScope,
) {
  const { isBot, ...missing } = message;
  void isBot;
  // @ts-expect-error isBot обязателен, неизвестность задаётся явно.
  const invalid: IncomingMessage = missing;
  void invalid;
  // @ts-expect-error контекстный reader не принимает голый chatId.
  void reader.list(scope.chatId, { limit: 1 });
  // @ts-expect-error контекстный reader не предоставляет полный журнал или запись.
  void reader.append(scope, message);
}
export const handler: QueueHandler = async () => ({ outcome: 'completed' });
