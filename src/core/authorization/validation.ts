import type { ChatId, UserId } from '../../contracts/index';

export function validId(value: unknown): value is ChatId | UserId {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]*:[^\s]+$/.test(value);
}
export function platformOf(id: string): string { return id.slice(0, id.indexOf(':')); }
export function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
