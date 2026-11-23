const minute = 60_000;
export const autonomousHourMs = 60 * minute;
export const autonomousDayMs = 24 * autonomousHourMs;

const defaults = {
  userRequests: 3,
  userWindowMs: minute,
  chatRequests: 10,
  chatWindowMs: minute,
  autonomousPerHour: 2,
  autonomousPerDay: 6,
  autonomousIntervalMs: 20 * minute,
};

export type ChatLimits = Readonly<typeof defaults>;

export function chatLimits(input: Partial<ChatLimits> = {}): ChatLimits {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).some((key) => !Object.hasOwn(defaults, key))
  ) {
    throw new TypeError('Chat limits: invalid_configuration');
  }
  const limits = { ...defaults, ...input };
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    [limits.userWindowMs, limits.chatWindowMs, limits.autonomousIntervalMs].some(
      (value) => value > 8_640_000_000_000_000 - Date.now(),
    )
  ) {
    throw new TypeError('Chat limits: invalid_configuration');
  }
  return Object.freeze(limits);
}
