import type { Storage } from '../src/storage/index';
import type { ChatQueue, QueueDecision } from '../src/core/index';
export function queueContracts(storage: Storage, queue: ChatQueue) {
  // @ts-expect-error Голый chatId не является подлинной областью.
  void storage.messages.get('vk:a',1);
  // @ts-expect-error Голый chatId не является подлинной областью.
  void storage.queue.get('vk:a',1);
  // @ts-expect-error Асинхронное решение запрещено.
  const asyncDecision: QueueDecision = async () => true;
  // @ts-expect-error Не выдаём модельный интерфейс глобального взятия задания.
  void storage.queue.take();
  void queue;void asyncDecision;
}
