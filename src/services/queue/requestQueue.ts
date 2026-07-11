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
    return q.add(fn) as Promise<T>;
  }
}

const requestQueue = new RequestQueue();
export default requestQueue;
