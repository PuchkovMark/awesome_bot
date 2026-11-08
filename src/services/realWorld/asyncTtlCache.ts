interface CacheEntry<T> {
  expiresAt: number;
  value?: T;
  error?: Error;
}

/**
 * Кэширует асинхронные значения на заданный срок и объединяет параллельные запросы одного ключа.
 */
export class AsyncTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, ttlMs: number, load: () => Promise<T>, failureTtlMs = 0): Promise<T> {
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      if (cached.error) throw cached.error;
      return cached.value as T;
    }
    if (cached) this.entries.delete(key);

    const pending = this.pending.get(key);
    if (pending) return pending;

    const request = load()
      .then((value) => {
        if (ttlMs > 0) this.store(key, { value, expiresAt: this.now() + ttlMs });
        return value;
      })
      .catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (failureTtlMs > 0) {
          this.store(key, { error, expiresAt: this.now() + failureTtlMs });
        }
        throw error;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });

    this.pending.set(key, request);
    return request;
  }

  private store(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
