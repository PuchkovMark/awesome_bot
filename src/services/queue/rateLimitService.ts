export class RateLimitService {
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxTrackedUsers = 10_000,
  ) {}

  take(
    userId: string,
    now = Date.now(),
  ): { allowed: boolean; retryAfterMs: number; notify: boolean } {
    const recent = (this.requests.get(userId) ?? []).filter(
      (timestamp) => now - timestamp < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.requests.set(userId, recent);
      const lastNotified = this.lastNotified.get(userId) ?? 0;
      const notify = now - lastNotified >= this.windowMs;
      if (notify) this.lastNotified.set(userId, now);
      return {
        allowed: false,
        retryAfterMs: Math.max(1, this.windowMs - (now - recent[0])),
        notify,
      };
    }

    recent.push(now);
    this.requests.delete(userId);
    this.requests.set(userId, recent);
    if (this.requests.size > this.maxTrackedUsers) {
      const oldestUser = this.requests.keys().next().value;
      if (oldestUser !== undefined) {
        this.requests.delete(oldestUser);
        this.lastNotified.delete(oldestUser);
      }
    }
    return { allowed: true, retryAfterMs: 0, notify: false };
  }

  private readonly lastNotified = new Map<string, number>();
}
