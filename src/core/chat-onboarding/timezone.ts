export const timezoneCommand = '/часовой-пояс';

export function parseTimezoneCommand(text: string): string | null {
  const match = /^\/часовой-пояс(?:\s+(.*))?$/iu.exec(text.trim());
  return match ? (match[1] ?? '').trim() : null;
}

const zoneNames = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

export function canonicalTimezone(value: string): string | null {
  if (zoneNames.has(value)) return value;
  try {
    const resolved = new Intl.DateTimeFormat('en', {timeZone:value}).resolvedOptions().timeZone;
    return zoneNames.has(resolved) ? resolved : null;
  } catch { return null; }
}
