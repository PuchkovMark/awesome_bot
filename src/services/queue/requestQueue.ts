import PQueue from 'p-queue';

/**
 * RequestQueue — управляет per-user очередями с concurrency=1,
 * чтобы избежать одновременной генерации ответов одному пользователю.
 */
export class RequestQueue {
  private queues: Map<string, PQueue> = new Map();

  getQueueForUser(userId: string): PQueue {
    if (!this.queues.has(userId)) {
      this.queues.set(userId, new PQueue({ concurrency: 1 }));
    }
    return this.queues.get(userId)!;
  }

  async add<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const q = this.getQueueForUser(userId);
    const result = q.add(fn) as Promise<T>;
    void q.onIdle().then(() => {
      if (this.queues.get(userId) === q && q.size === 0 && q.pending === 0) {
        this.queues.delete(userId);
      }
    });
    return result;
  }
}

const requestQueue = new RequestQueue();
export default requestQueue;
