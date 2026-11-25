/// <reference lib="esnext.temporal" />
import { localDay } from './calendar';
import type { CalendarPeriod } from './calendar';

export interface RecapBounds {
  readonly from?: number;
  readonly to?: number;
  readonly calendar?: CalendarSelection;
}
export type RecapPeriodResult =
  | { readonly kind: 'period'; readonly period: CalendarPeriod }
  | { readonly kind: 'clarify'; readonly known: RecapBounds };

const months = [
  'январь января январе',
  'февраль февраля феврале',
  'март марта марте',
  'апрель апреля апреле',
  'май мая мае',
  'июнь июня июне',
  'июль июля июле',
  'август августа августе',
  'сентябрь сентября сентябре',
  'октябрь октября октябре',
  'ноябрь ноября ноябре',
  'декабрь декабря декабре',
];
const days = [
  'первое первого первый один',
  'второе второго второй два',
  'третье третьего третий три',
  'четвертое четвертого четвертый четыре',
  'пятое пятого пятый пять',
  'шестое шестого шестой шесть',
  'седьмое седьмого седьмой семь',
  'восьмое восьмого восьмой восемь',
  'девятое девятого девятый девять',
  'десятое десятого десятый десять',
  'одиннадцатое одиннадцатого одиннадцатый одиннадцать',
  'двенадцатое двенадцатого двенадцатый двенадцать',
  'тринадцатое тринадцатого тринадцатый тринадцать',
  'четырнадцатое четырнадцатого четырнадцатый четырнадцать',
  'пятнадцатое пятнадцатого пятнадцатый пятнадцать',
  'шестнадцатое шестнадцатого шестнадцатый шестнадцать',
  'семнадцатое семнадцатого семнадцатый семнадцать',
  'восемнадцатое восемнадцатого восемнадцатый восемнадцать',
  'девятнадцатое девятнадцатого девятнадцатый девятнадцать',
  'двадцатое двадцатого двадцатый двадцать',
];
const monthNames = new Map(
  months.flatMap((forms, index) => forms.split(' ').map((form) => [form, index + 1] as const)),
);
const dayNames = new Map(
  days.flatMap((forms, index) => forms.split(' ').map((form) => [form, index + 1] as const)),
);
for (const form of ['тридцатое', 'тридцатого', 'тридцатый', 'тридцать']) dayNames.set(form, 30);
for (const [word, unit] of [...dayNames]) {
  if (unit < 10) dayNames.set('двадцать ' + word, 20 + unit);
  if (unit === 1) dayNames.set('тридцать ' + word, 31);
}
const words = new RegExp(
  '(?<!\\p{L})(?:' +
    [...dayNames.keys()]
      .sort((a, b) => b.length - a.length)
      .join('|')
      .replaceAll(' ', '\\s+') +
    ')(?!\\p{L})',
  'gu',
);
const iso = /\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:z|[+-]\d{2}:\d{2})?)?/u;
const numeric = /\d{1,2}[./]\d{1,2}(?:[./]\d{4})?/u;
const named = '\\d{1,2}(?:\\s+(?:' + [...monthNames.keys()].join('|') + ')(?:\\s+\\d{4})?)?';
const tokens = new RegExp(
  '(?<![\\p{L}\\p{N}:./])(?:' +
    [iso.source, numeric.source, 'позавчера|вчера|сегодня', named].join('|') +
    ')(?![\\p{L}\\p{N}:])',
  'gu',
);

type DatePart = { day: number; month?: number; year?: number; instant?: number };
function readDate(text: string, today: Temporal.PlainDate, timezone: string): DatePart {
  if (text.endsWith('вчера') || text === 'сегодня') {
    const date = today.subtract({ days: text === 'позавчера' ? 2 : text === 'вчера' ? 1 : 0 });
    return { day: date.day, month: date.month, year: date.year };
  }
  if (/^\d{4}-/u.test(text)) {
    const date = Temporal.PlainDate.from(text.slice(0, 10));
    if (text.length === 10) return { day: date.day, month: date.month, year: date.year };
    const timestamp = text.replace(' ', 'T').toUpperCase();
    const instant = /Z|[+-]\d{2}:\d{2}$/u.test(timestamp)
      ? Temporal.Instant.from(timestamp)
      : Temporal.PlainDateTime.from(timestamp).toZonedDateTime(timezone, {
          disambiguation: 'reject',
        });
    return {
      day: date.day,
      month: date.month,
      year: date.year,
      instant: instant.epochMilliseconds,
    };
  }
  const [day, month, year] = text.split(/[./\s]+/u);
  return {
    day: Number(day),
    ...(month ? { month: monthNames.get(month) ?? Number(month) } : {}),
    ...(year ? { year: Number(year) } : {}),
  };
}

function bounds(
  part: DatePart,
  other: DatePart | undefined,
  today: Temporal.PlainDate,
  timezone: string,
  time?: string,
) {
  if (part.instant !== undefined) return { from: part.instant, to: part.instant };
  const month = part.month ?? other?.month;
  const year = part.year ?? other?.year ?? (month === today.month ? today.year : undefined);
  if (!month) return undefined;
  if (year === undefined) {
    Temporal.PlainDate.from({ year: 2000, month, day: part.day }, { overflow: 'reject' });
    return undefined;
  }
  const date = Temporal.PlainDate.from({ year, month, day: part.day }, { overflow: 'reject' });
  if (time) {
    const at = date
      .toPlainDateTime(Temporal.PlainTime.from(time.padStart(5, '0')))
      .toZonedDateTime(timezone, { disambiguation: 'reject' }).epochMilliseconds;
    return { from: at, to: at };
  }
  return {
    from: date.toZonedDateTime(timezone).epochMilliseconds,
    to: date.add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
  };
}

interface CalendarSelection {
  first: DatePart;
  second?: DatePart;
  edge: 'from' | 'to' | 'whole';
  times: readonly string[];
}

function calendarAnswer(text: string): { month?: number; year?: number } | undefined {
  const parts = text
    .trim()
    .replace(/^в\s+/u, '')
    .replace(/\s+(?:г\.?|году|года|год)$/u, '')
    .split(/[\s./]+/u);
  const result: { month?: number; year?: number } = {};
  for (const part of parts) {
    if (/^\d{4}$/u.test(part) && !result.year) result.year = Number(part);
    else {
      const month = monthNames.get(part) ?? (/^\d{1,2}$/u.test(part) ? Number(part) : 0);
      if (!month || month > 12 || result.month) return undefined;
      result.month = month;
    }
  }
  return result;
}

function selectionPeriod(
  selection: CalendarSelection,
  known: RecapBounds,
  today: Temporal.PlainDate,
  timezone: string,
): RecapPeriodResult {
  const { first, second, edge, times } = selection;
  const base = known.from ?? (known.to === undefined ? undefined : known.to - 1);
  const previous =
    base === undefined
      ? undefined
      : Temporal.Instant.fromEpochMilliseconds(base).toZonedDateTimeISO(timezone).toPlainDate();
  const left = bounds(first, second ?? previous, today, timezone, times[0]);
  const right = bounds(second ?? first, second ? first : previous, today, timezone, times[1]);
  if (!left || !right) return { kind: 'clarify', known: { ...known, calendar: selection } };
  let from = left.from,
    to = right.to;
  if (!second) {
    if (edge === 'from' && known.to === undefined) return { kind: 'clarify', known: { from } };
    if (edge === 'to' && known.from === undefined) return { kind: 'clarify', known: { to } };
    if (edge !== 'from') from = known.from ?? from;
    if (edge !== 'to') to = known.to ?? to;
  }
  return from < to
    ? { kind: 'period', period: { from, to, timezone } }
    : { kind: 'clarify', known: {} };
}

export function recapClarification(known: RecapBounds) {
  if (known.calendar) {
    if (!known.calendar.first.month && !known.calendar.second?.month)
      return 'В каком месяце собрать пересказ? Ответь месяцем или полным периодом.';
    return 'За какой год собрать пересказ? Ответь годом или полным периодом.';
  }
  if (known.from !== undefined)
    return 'По какую дату собрать пересказ? Ответь датой конца или новым периодом.';
  if (known.to !== undefined)
    return 'С какой даты собрать пересказ? Ответь датой начала или новым периодом.';
  return 'За какой период собрать пересказ? Ответь на это сообщение, например «вчера» или «с 20 по 22 ноября».';
}

export function parseRecapPeriod(
  input: string,
  at: number,
  timezone: string,
  known: RecapBounds = {},
): RecapPeriodResult {
  const clarify = (partial = known): RecapPeriodResult => ({ kind: 'clarify', known: partial });
  const finish = (from: number, to: number): RecapPeriodResult =>
    from < to ? { kind: 'period', period: { from, to, timezone } } : clarify();
  let text = input
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(words, (word) => String(dayNames.get(word.replace(/\s+/gu, ' '))))
    .replace(/(\d{1,2})[-‑]?(?:го|е|ое|й)(?!\p{L})/gu, '$1');
  try {
    const today = Temporal.Instant.fromEpochMilliseconds(at)
      .toZonedDateTimeISO(timezone)
      .toPlainDate();
    const supplement = known.calendar && calendarAnswer(text);
    if (supplement && known.calendar) {
      const fill = (part: DatePart) => ({ ...supplement, ...part });
      const prior = known.calendar;
      return selectionPeriod(
        { ...prior, first: fill(prior.first), ...(prior.second && { second: fill(prior.second) }) },
        known,
        today,
        timezone,
      );
    }
    const recent = /(?:последни[ехйя]+\s+(?:(\d{1,2})\s+д|недел)|за неделю)/u.exec(text);
    if (recent) {
      const n = Number(recent[1] ?? 7);
      return n > 0
        ? finish(localDay(at, timezone, -n).from, localDay(at, timezone).from)
        : clarify();
    }
    if (/(?<!\p{L})(?:утром|вечером|ночью|днем|или)(?!\p{L})/u.test(text)) return clarify();
    const times: string[] = [];
    text = text.replace(/(?:с|по|до|в)\s+(\d{1,2}:\d{2})(?!\d)/gu, (_, time: string) => {
      times.push(time);
      return ' ';
    });
    if (times.length !== 0 && times.length !== 2) return clarify();
    const matches = [...text.matchAll(tokens)];
    if (!matches.length || matches.length > 2) return clarify();
    const first = matches[0]!,
      second = matches[1];
    const before = text.slice(0, first.index);
    const after = text.slice((second ?? first).index + (second ?? first)[0].length);
    if (
      second &&
      !/^\s*(?:года?\s*)?(?:[—–-]|по|до)\s*$/u.test(
        text.slice(first.index + first[0].length, second.index),
      )
    )
      return clarify();
    // Не достраиваем повреждённую цифровую дату по её фрагменту.
    if (/[./\d-]$/u.test(before) || /^[./-]\d/u.test(after) || /^\s*:\d/u.test(after))
      return clarify();
    const a = readDate(first[0], today, timezone),
      b = second ? readDate(second[0], today, timezone) : undefined;
    const edge = /(?:^|\s)(?:до|по)\s*$/u.test(before)
      ? 'to'
      : /(?:^|\s)(?:с|от)\s*$/u.test(before)
        ? 'from'
        : 'whole';
    return selectionPeriod(
      { first: a, ...(b && { second: b }), edge, times },
      known,
      today,
      timezone,
    );
  } catch {
    return clarify();
  }
}
