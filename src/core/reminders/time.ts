import { canonicalTimezone } from '../chat-onboarding/timezone';

const minute = 60_000;
const day = 24 * 60 * minute;
const maxDate = 8_640_000_000_000_000;
const amount = /(\d+)\s+(мин(?:ут[ауые]?|\.)?|час(?:а|ов)?|день|дня|дней)(?![\p{L}\p{N}_])/giu;
const impreciseAmount =
  /(?:полчаса|полтора(?:\s+часа)?|с\s+половиной|ещ[её]\s+немного|(?:ещ[её]\s+)?(?:несколько|пару)\s+(?:минут|часов|дней)|час|день|минуту|\d+\s*(?:ч\.|мин\.)|(?:\d+\s+)?(?:секунд[ауые]?|недел[юяиеь]?|месяц(?:а|ев)?|года?|лет))(?![\p{L}\p{N}])/iu;
const amountWithoutUnit = /\d+(?![\p{L}\p{N}_]|[.,:]\d)/u;
function components(first: string, subsequent = first) {
  return first + '(?:(?:\\s*,\\s*|\\s+)(?:и\\s+)?(?:ещ[её]\\s+)?' + subsequent + ')*';
}
const exactDuration = new RegExp('^' + components(amount.source) + '$', 'iu');
const durationComponent = '(?:' + amount.source + '|' + impreciseAmount.source + ')';
// Число без единицы относится к сроку внутри уже распознанной длительности или её альтернативы.
const subsequentComponent = '(?:' + durationComponent + '|' + amountWithoutUnit.source + ')';
const duration = components(durationComponent, subsequentComponent);
const alternativeDuration = components(subsequentComponent);
const interval = new RegExp(
  '(?<![\\p{L}\\p{N}])через\\s+' +
    duration +
    '(?:\\s+или\\s+(?:через\\s+)?' +
    alternativeDuration +
    ')*',
  'giu',
);
const monthNames = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const namedDateText = String.raw`\d{1,2}\s+(?:${monthNames.join('|')})(?:\s+\d{4}(?:\s+(?:года|г\.))?)?`;
const namedDateStart = new RegExp(String.raw`^${namedDateText}(?![\p{L}\p{N}_/:]|\.\d)`, 'iu');
const numericDateText = String.raw`\d{1,2}\.\d{1,2}(?:\.\d{4})?`;
const calendarDate = new RegExp(
  String.raw`(?<![\p{L}\p{N}_./:])(${numericDateText}|${namedDateText})(?![\p{L}\p{N}_/:]|\.\d)`,
  'giu',
);
const clock = new RegExp(
  String.raw`(?<![\p{L}\p{N}:.])(?:(сегодня|завтра|послезавтра|${numericDateText}|${namedDateText})\s+(?:в\s+)?|(?:в|или)\s+)(\d{1,2}):(\d{2})(?![\p{L}\p{N}:])`,
  'giu',
);
const relativeDay = /^(?:сегодня|завтра|послезавтра)$/u;
const vague =
  /(?<!\p{L})(?:(сегодня|завтра|послезавтра)(?:\s+(?:утром|дн[её]м|вечером|ночью))?|утром|дн[её]м|вечером|ночью)(?!\p{L})/giu;
const zoneToken =
  /(?:по\s+Москве|(?<![\p{L}\p{N}_])(?:UTC(?:[+-][\p{L}\p{N}_]*(?:[:.]\d+)?)?|[A-Za-z][A-Za-z_+-]*(?:\/[A-Za-z0-9_+.-]+)+))(?![\p{L}\p{N}_/+-]|[:.]\d)/giu;
const urlText = String.raw`(?<![\p{L}\p{N}_])(?:[a-z][a-z\d+.-]*://|www\.)[^\s<>"«»]+`;
const urlToken = new RegExp(urlText, 'giu');
const contentEdges = new RegExp(String.raw`(${urlText})|^[\s,.:;–—-]+|[\s,;–—-]+$`, 'giu');

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

export function startsWithNamedReminderDate(text: string) {
  return namedDateStart.test(text);
}

function explicitReminderTimezone(value: string): string | null {
  const offset = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/iu.exec(value);
  if (!offset) return reminderTimezone(value);
  const [, sign, hour, minutes = '00'] = offset;
  if (Number(hour) > 23 || Number(minutes) > 59) return null;
  return sign + hour!.padStart(2, '0') + ':' + minutes;
}

function normalizeCalendarDate(value: string) {
  const text = value.toLowerCase();
  const [date, name, year] = text.split(/\s+/u);
  const month = name === undefined ? 0 : monthNames.indexOf(name) + 1;
  return month ? [date, month, year].filter((part) => part !== undefined).join('.') : text;
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
    ? explicitReminderTimezone(input.explicitTimezone)
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
  // Маска сохраняет индексы и отделяет слова по обе стороны адреса.
  const timeText = text.replace(urlToken, (url) => '~'.repeat(url.length));
  const relatives = [...timeText.matchAll(interval)];
  const calendarText = timeText.replace(
    /(?<!\p{L})верси(?:я|ю|и|ей)\s+\d+(?:\.\d+)+/giu,
    (version) => ' '.repeat(version.length),
  );
  const absolute = [...calendarText.matchAll(clock)];
  const zones = [...timeText.matchAll(zoneToken)];
  const separateDays = [...timeText.matchAll(vague), ...calendarText.matchAll(calendarDate)].filter(
    (part) => !absolute.some((local) => local.index === part.index),
  );
  const relativeChoices = relatives.flatMap((part) =>
    part[0]
      .toLowerCase()
      .split(/\s+или\s+/u)
      .map((choice) => choice.replace(/^через\s+/u, '')),
  );
  const days = [...absolute, ...separateDays].flatMap((part) =>
    part[1] ? [normalizeCalendarDate(part[1])] : [],
  );
  const date = days.length === 1 ? days[0] : undefined;
  const possibleTimes = relativeChoices.length + absolute.length;
  const preciseChoices = relativeChoices.filter((choice) => exactDuration.test(choice));
  const parts = [...relatives, ...absolute, ...separateDays, ...zones].sort(
    (a, b) => a.index - b.index,
  );
  const kept: string[] = [];
  let end = 0;
  let alternatives = false;
  for (const part of parts) {
    const gap = text.slice(end, part.index);
    if (end && /^\s*или\s*$/iu.test(gap)) alternatives = true;
    else if (!end || !/^\s*и\s*$/iu.test(gap)) kept.push(gap);
    end = part.index + part[0].length;
  }
  kept.push(text.slice(end));
  const ambiguous =
    alternatives ||
    possibleTimes > 1 ||
    days.length > 1 ||
    preciseChoices.length < relativeChoices.length ||
    (relatives.length > 0 && separateDays.length > 0);
  let schedule: ReminderSchedule | undefined;
  if (!ambiguous && relativeChoices.length === 1) {
    let minutes = 0;
    for (const part of relativeChoices[0]!.matchAll(amount)) {
      const unit = part[2]!;
      minutes +=
        Number(part[1]) * (unit.startsWith('мин') ? 1 : unit.startsWith('час') ? 60 : 1440);
    }
    schedule = { kind: 'relative', minutes };
  } else if (!ambiguous && absolute.length === 1) {
    const local = absolute[0]!;
    schedule = {
      kind: 'local',
      date: date ?? 'сегодня',
      hour: Number(local[2]),
      minute: Number(local[3]),
    };
  }
  let timeExample: string | undefined;
  if (relativeChoices.length > 1 && preciseChoices.length)
    timeExample = 'через ' + preciseChoices.at(-1);
  else if (relativeChoices.length === 1 && !preciseChoices.length)
    timeExample = 'через 1 час 30 минут';
  const content = kept.join(' ');
  return {
    schedule,
    date,
    ambiguous,
    timeExample,
    explicitTimezone: zones.length > 1 ? 'неоднозначно' : zones[0]?.[0],
    content: content
      .replace(contentEdges, (_, url?: string) => url ?? '')
      .replace(/[ \t]{2,}/gu, ' '),
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
