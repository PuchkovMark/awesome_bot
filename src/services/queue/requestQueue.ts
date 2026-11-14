import PQueue from 'p-queue';

/**
 * RequestQueue — управляет per-user очередями с concurrency=1,
 * чтобы избежать одновременной генерации ответов одному пользователю.
 */
/**
 * Выполняет асинхронные задачи каждого пользователя последовательно, сохраняя порядок сообщений.
 */
export class RequestQueue {
  private readonly queues: Map<string, PQueue> = new Map();

  getQueueForUser(userId: string): PQueue {
    let queue = this.queues.get(userId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.queues.set(userId, queue);
    }
    return queue;
  }

  async add<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const q = this.getQueueForUser(userId);
    const result = q.add(fn) as Promise<T>;
    void (async () => {
      await q.onIdle();
      if (this.queues.get(userId) === q && q.size === 0 && q.pending === 0) {
        this.queues.delete(userId);
      }
    })();
    return result;
  }
}

const requestQueue = new RequestQueue();
export default requestQueue;
