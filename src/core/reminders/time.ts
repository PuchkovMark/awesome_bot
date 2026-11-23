import { canonicalTimezone } from '../chat-onboarding/timezone';

const minute = 60_000;
const day = 24 * 60 * minute;
const maxDate = 8_640_000_000_000_000;
const intervalUnits = /^(?:минут[ауые]?|час(?:а|ов)?|(?:день|дня|дней))$/u;
const interval =
  /(?<![\p{L}\p{N}])через\s+(\d+)\s+(минут[ауые]?|час(?:а|ов)?|день|дня|дней)(?![\p{L}\p{N}])/giu;
const clock =
  /(?<![\p{L}\p{N}:.])(?:(сегодня|завтра|послезавтра|\d{1,2}\.\d{1,2}(?:\.\d{4})?)\s+(?:в\s+)?|в\s+)(\d{1,2}):(\d{2})(?![\p{L}\p{N}:])/giu;
const relativeDay = /^(?:сегодня|завтра|послезавтра)$/u;
const vague =
  /(?<!\p{L})(сегодня|завтра|послезавтра)(?:\s+(?:утром|дн[её]м|вечером|ночью))?|(?<!\p{L})(?:утром|дн[её]м|вечером|ночью)(?!\p{L})/giu;
const zoneToken =
  /(?:по\s+Москве|(?<![\p{L}\p{N}_])(?:UTC|[A-Za-z][A-Za-z_+-]*(?:\/[A-Za-z0-9_+.-]+)+))(?![\p{L}\p{N}_/])/giu;

export type ReminderSchedule =
  | { readonly kind: 'relative'; readonly minutes: number }
  | {
      readonly kind: 'local';
      readonly date: string;
      readonly hour: number;
      readonly minute: number;
    };
export type ReminderTime =
  | { readonly kind: 'scheduled'; readonly dueAt: number; readonly timezone: string }
  | { readonly kind: 'time' | 'zone' | 'skipped' }
  | {
      readonly kind: 'overlap';
      readonly choices: readonly [number, number];
      readonly timezone: string;
    };

export function reminderTimezone(value: string): string | null {
  const text = value.trim();
  return /^по\s+москве$/iu.test(text) ? 'Europe/Moscow' : canonicalTimezone(text);
}

interface ReminderTimeInput {
  readonly originAt: number;
  readonly schedule?: ReminderSchedule | undefined;
  readonly timezone?: string | undefined;
  readonly explicitTimezone?: string | undefined;
}

function civil(year: number, month: number, date: number, hour = 0, minuteOfHour = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, date);
  d.setUTCHours(hour, minuteOfHour, 0, 0);
  return d;
}

function calendar(timezone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
}

function localFields(format: Intl.DateTimeFormat, at: number) {
  const fields = Object.fromEntries(
    format.formatToParts(at).map(({ type, value }) => [type, Number(value)]),
  );
  return [fields.year!, fields.month!, fields.day!, fields.hour!, fields.minute!] as const;
}

export function resolveReminderTime(input: ReminderTimeInput): ReminderTime {
  const { originAt, schedule } = input;
  if (!schedule || !Number.isSafeInteger(originAt) || originAt < 0 || originAt > maxDate - 4 * day)
    return { kind: 'time' };
  const timezone = input.explicitTimezone
    ? reminderTimezone(input.explicitTimezone)
    : input.timezone && reminderTimezone(input.timezone);
  if (input.explicitTimezone && !timezone) return { kind: 'zone' };
  if (schedule.kind === 'relative') {
    const dueAt = originAt + schedule.minutes * minute;
    return Number.isSafeInteger(dueAt) && dueAt > originAt && dueAt <= maxDate
      ? { kind: 'scheduled', dueAt, timezone: timezone || 'UTC' }
      : { kind: 'time' };
  }
  if (!timezone) return { kind: 'zone' };
  const format = calendar(timezone);
  const [year, month, date] = localFields(format, originAt);
  const { hour, minute: minuteOfHour } = schedule;
  if (hour < 0 || hour > 23 || minuteOfHour < 0 || minuteOfHour > 59) return { kind: 'time' };
  let target: Date;
  if (relativeDay.test(schedule.date)) {
    const shift = schedule.date === 'послезавтра' ? 2 : Number(schedule.date === 'завтра');
    target = civil(year, month, date + shift, hour, minuteOfHour);
  } else {
    const [d, m, y = year] = schedule.date.split('.').map(Number);
    target = civil(y, m!, d!, hour, minuteOfHour);
    if (target.getUTCMonth() + 1 !== m || target.getUTCDate() !== d || y < 1970)
      return { kind: 'time' };
  }
  const targetAt = target.getTime();
  // Смещения по обе стороны перехода дают кандидаты. Обратное преобразование отсеивает пропуск часа.
  const offsets = new Set<number>();
  for (let delta = -2 * day; delta <= 2 * day; delta += 6 * 60 * minute) {
    const sample = targetAt + delta;
    offsets.add(civil(...localFields(format, sample)).getTime() - sample);
  }
  const exact = [...offsets]
    .map((offset) => targetAt - offset)
    .filter((at) => civil(...localFields(format, at)).getTime() === targetAt)
    .sort((a, b) => a - b);
  if (exact.length === 1) return { kind: 'scheduled', dueAt: exact[0]!, timezone };
  if (exact.length === 2) return { kind: 'overlap', choices: [exact[0]!, exact[1]!], timezone };
  return { kind: 'skipped' };
}

export function extractReminderTime(text: string) {
  const relatives = [...text.matchAll(interval)];
  const absolute = [...text.matchAll(clock)];
  const zones = [...text.matchAll(zoneToken)];
  const relative = relatives.length === 1 && absolute.length === 0 ? relatives[0] : undefined;
  const local = absolute.length === 1 && relatives.length === 0 ? absolute[0] : undefined;
  const vagueTime =
    relatives.length + absolute.length === 0 ? [...text.matchAll(vague)][0] : undefined;
  let schedule: ReminderSchedule | undefined;
  if (relative && intervalUnits.test(relative[2]!.toLowerCase())) {
    const unit = relative[2]!.toLowerCase();
    schedule = {
      kind: 'relative',
      minutes:
        Number(relative[1]) * (unit.startsWith('минут') ? 1 : unit.startsWith('час') ? 60 : 1440),
    };
  } else if (local) {
    schedule = {
      kind: 'local',
      date: local[1]?.toLowerCase() ?? 'сегодня',
      hour: Number(local[2]),
      minute: Number(local[3]),
    };
  }
  const parts = [relative ?? local ?? vagueTime, ...zones]
    .filter((match) => match !== undefined)
    .sort((a, b) => b.index! - a.index!);
  let content = text;
  for (const part of parts)
    content = content.slice(0, part.index) + ' ' + content.slice(part.index! + part[0].length);
  return {
    schedule,
    date: (local?.[1] ?? vagueTime?.[1])?.toLowerCase(),
    explicitTimezone: zones.length > 1 ? 'неоднозначно' : zones[0]?.[0],
    content: content.replace(/^[\s,.:;–—-]+|[\s,;–—-]+$/gu, '').replace(/[ \t]{2,}/gu, ' '),
  };
}

export function formatReminderTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}
