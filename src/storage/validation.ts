import { isAbsolute } from 'node:path';
import { StorageError } from './errors.js';

export function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new StorageError('invalid_input');
}
export function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireInput(Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key)));
}
export function string(value: unknown, nonempty = false): asserts value is string {
  requireInput(typeof value === 'string' && (!nonempty || value.length > 0));
}
export function compositeId(value: unknown): asserts value is `${string}:${string}` {
  string(value, true);
  const separator = value.indexOf(':');
  requireInput(separator > 0 && separator < value.length - 1);
}
export function timestamp(value: unknown): asserts value is number {
  requireInput(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
export function databasePath(value: unknown): asserts value is string {
  string(value, true);
  requireInput(value === ':memory:' || isAbsolute(value));
}
export function timezone(value: unknown): asserts value is string {
  string(value, true);
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { throw new StorageError('invalid_input'); }
}
export function mode(value: unknown): void { requireInput(value === 'always' || value === 'mention'); }
export function nullableString(value: unknown): void { if (value !== null) string(value); }
