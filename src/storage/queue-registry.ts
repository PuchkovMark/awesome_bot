import type { QueueBackend } from './queue-store.js';
import { StorageError } from './errors.js';
const backends = new WeakMap<object, QueueBackend>();
export function registerQueue(storage: object, backend: QueueBackend) { backends.set(storage, backend); }
/** Только сборка ядра; не экспортируется публичным storage/index. */
export function queueBackend(storage: object): QueueBackend {
  const backend = backends.get(storage); if (!backend) throw new StorageError('invalid_input'); return backend;
}
