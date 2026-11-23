export function noticeInterval(value: unknown = 300000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new TypeError('Router: invalid_configuration');
  return value;
}
