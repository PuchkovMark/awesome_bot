import {
  addLocalDays,
  getDaysInMonth,
  getLocalDateTime,
  getLocalWeekday,
  getNextRecurringDate,
  type RecurrenceRule,
  toUtcDateTime,
} from './reminderDateTime.js';

const monthNames: Record<string, number> = {
  января: 1,
  январь: 1,
  февраля: 2,
  февраль: 2,
  марта: 3,
  март: 3,
  апреля: 4,
  апрель: 4,
  мая: 5,
  май: 5,
  июня: 6,
  июнь: 6,
  июля: 7,
  июль: 7,
  августа: 8,
  август: 8,
  сентября: 9,
  сентябрь: 9,
  октября: 10,
  октябрь: 10,
  ноября: 11,
  ноябрь: 11,
  декабря: 12,
  декабрь: 12,
};

const weekdayNames: Record<string, number> = {
  воскресенье: 0,
  воскресенья: 0,
  понедельник: 1,
  понедельника: 1,
  вторник: 2,
  вторника: 2,
  среда: 3,
  среду: 3,
  среды: 3,
  четверг: 4,
  четверга: 4,
  пятница: 5,
  пятницу: 5,
  пятницы: 5,
  суббота: 6,
  субботу: 6,
  субботы: 6,
};

const numberWords: Record<string, number> = {
  один: 1,
  одна: 1,
  одну: 1,
  одного: 1,
  два: 2,
  две: 2,
  двух: 2,
  три: 3,
  трех: 3,
  трёх: 3,
  четыре: 4,
  четырех: 4,
  четырёх: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
};

interface Match<T> {
  value: T;
  text: string;
}

export interface ParsedReminder {
  content: string;
  dueAt?: Date;
  dueDate?: string;
  time?: string;
  recurrence?: RecurrenceRule;
  recurrenceEndAt?: Date;
  missing: 'time' | 'date' | 'content' | 'recipient' | null;
  ambiguousTime: boolean;
  groupRequested: boolean;
  recipientVkId?: string;
  recipientReference?: string;
  recognized: boolean;
}

function numberValue(value: string): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric
    : numberWords[value.toLocaleLowerCase('ru-RU')];
}

function getTimeMatches(text: string): Array<Match<{ time: string; ambiguous: boolean }>> {
  const matches: Array<Match<{ time: string; ambiguous: boolean }>> = [];
  const occupied: Array<[number, number]> = [];
  const add = (match: RegExpExecArray, value: { time: string; ambiguous: boolean }) => {
    if (
      occupied.some(([start, end]) => match.index < end && match.index + match[0].length > start)
    ) {
      return;
    }
    occupied.push([match.index, match.index + match[0].length]);
    matches.push({ text: match[0], value });
  };
  const colonPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:в|к|на)?\s*(\d{1,2})[:.](\d{2})(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/giu;
  for (const match of text.matchAll(colonPattern)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60)
      add(match, {
        time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        ambiguous: false,
      });
  }

  const dayPartPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))((?:в|к|около)\s*)?(\d{1,2}|один|одна|одну|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s*(утра|утром|дня|днём|днем|вечера|вечером|ночи)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/giu;
  for (const match of text.matchAll(dayPartPattern)) {
    const rawHour = numberValue(match[2]);
    if (!rawHour || rawHour > 12) continue;
    const part = match[3].toLocaleLowerCase('ru-RU');
    if (part.startsWith('дн') && !match[1]) continue;
    let hour = rawHour;
    if (part.startsWith('вечер') || part === 'дня' || part === 'днём' || part === 'днем') {
      if (hour < 12) hour += 12;
    } else if (part === 'ночи' && hour === 12) {
      hour = 0;
    }
    add(match, { time: `${String(hour).padStart(2, '0')}:00`, ambiguous: false });
  }

  const bareHourPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:в|к|на)\s*(\d{1,2})(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/giu;
  for (const match of text.matchAll(bareHourPattern)) {
    const hour = Number(match[1]);
    if (hour > 23) continue;
    add(match, {
      time: `${String(hour).padStart(2, '0')}:00`,
      ambiguous: hour > 0 && hour < 13,
    });
  }

  return matches;
}

export function parseReminderTime(text: string): { time?: string; ambiguous: boolean } {
  const matches = getTimeMatches(text);
  const times = [...new Set(matches.map(({ value }) => value.time))];
  return {
    ...(times.length === 1 ? { time: times[0] } : {}),
    ambiguous: times.length > 1 || matches.some(({ value }) => value.ambiguous),
  };
}

function parseDate(
  text: string,
  now: Date,
  timeZone: string,
  time?: string,
): Match<string> | undefined {
  const today = getLocalDateTime(now, timeZone).date;
  const [currentYear, currentMonth, currentDay] = today.split('-').map(Number);
  const currentLocal = Date.UTC(currentYear, currentMonth - 1, currentDay);
  const relativePattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(сегодня|завтра|послезавтра)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (relativePattern) {
    const offset =
      relativePattern[1].toLocaleLowerCase('ru-RU') === 'сегодня'
        ? 0
        : relativePattern[1].toLocaleLowerCase('ru-RU') === 'завтра'
          ? 1
          : 2;
    return { text: relativePattern[0], value: addLocalDays(today, offset) };
  }
  const relativeDays =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))через\s+(неделю|\d+|один|одна|одну|два|две|три|трех|трёх|четыре|пять|шесть|семь|восемь|девять|десять)\s*(день|дня|дней|неделю|недели)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  const oneWeek =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))через\s+неделю(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (oneWeek) return { text: oneWeek[0], value: addLocalDays(today, 7) };
  if (relativeDays) {
    const rawCount = relativeDays[1].toLocaleLowerCase('ru-RU');
    const count = rawCount === 'неделю' ? 1 : numberValue(rawCount);
    if (count) {
      const weeks = relativeDays[2].startsWith('недел') || rawCount === 'неделю';
      return {
        text: relativeDays[0],
        value: addLocalDays(today, count * (weeks ? 7 : 1)),
      };
    }
  }

  const isoPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(20\d{2})-(\d{1,2})-(\d{1,2})(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/u.exec(
      text,
    );
  const numericPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/u.exec(
      text,
    );
  const numeric = isoPattern
    ? {
        text: isoPattern[0],
        year: Number(isoPattern[1]),
        month: Number(isoPattern[2]),
        day: Number(isoPattern[3]),
      }
    : numericPattern
      ? {
          text: numericPattern[0],
          year: numericPattern[3] ? Number(numericPattern[3]) : currentYear,
          month: Number(numericPattern[2]),
          day: Number(numericPattern[1]),
        }
      : undefined;
  if (numeric && numeric.month >= 1 && numeric.month <= 12) {
    let year = numeric.year;
    if (
      !isoPattern &&
      !numericPattern?.[3] &&
      Date.UTC(year, numeric.month - 1, numeric.day) < currentLocal
    ) {
      year += 1;
    }
    if (numeric.day >= 1 && numeric.day <= getDaysInMonth(year, numeric.month)) {
      return {
        text: numeric.text,
        value: `${year}-${String(numeric.month).padStart(2, '0')}-${String(numeric.day).padStart(2, '0')}`,
      };
    }
  }

  const monthPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:(\d{1,2})(?:-?(?:го|е))?|первого|первое|второго|второе|третьего|третье)\s+(января|январь|февраля|февраль|марта|март|апреля|апрель|мая|май|июня|июнь|июля|июль|августа|август|сентября|сентябрь|октября|октябрь|ноября|ноябрь|декабря|декабрь)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (monthPattern) {
    const ordinalDays: Record<string, number> = {
      первого: 1,
      первое: 1,
      второго: 2,
      второе: 2,
      третьего: 3,
      третье: 3,
    };
    const day = monthPattern[1]
      ? Number(monthPattern[1])
      : ordinalDays[monthPattern[0].split(/\s+/u)[0]];
    const month = monthNames[monthPattern[2].toLocaleLowerCase('ru-RU')];
    let year = currentYear;
    if (Date.UTC(year, month - 1, day) < currentLocal) year += 1;
    if (day <= getDaysInMonth(year, month)) {
      return {
        text: monthPattern[0],
        value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      };
    }
  }

  const endOfMonth =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))в\s+конце\s+месяца(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (endOfMonth) {
    const lastDay = getDaysInMonth(currentYear, currentMonth);
    const date =
      currentDay < lastDay
        ? `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
        : `${currentMonth === 12 ? currentYear + 1 : currentYear}-${String(currentMonth === 12 ? 1 : currentMonth + 1).padStart(2, '0')}-${String(getDaysInMonth(currentYear, currentMonth === 12 ? 1 : currentMonth + 1)).padStart(2, '0')}`;
    return { text: endOfMonth[0], value: date };
  }

  const weekdayPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:(?:в\s+)?следующ(?:ий|ую|ее)\s+)?(?:в\s+)?(воскресенье|воскресенья|понедельник|понедельника|вторник|вторника|среда|среду|среды|четверг|четверга|пятница|пятницу|пятницы|суббота|субботу|субботы)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (weekdayPattern) {
    const weekday = weekdayNames[weekdayPattern[1].toLocaleLowerCase('ru-RU')];
    const currentWeekday = getLocalWeekday(today);
    let offset = (weekday - currentWeekday + 7) % 7;
    if (/следующ/iu.test(weekdayPattern[0]) && offset === 0) offset = 7;
    const date = addLocalDays(today, offset);
    const candidate = toUtcDateTime({ date, time: time ?? '12:00' }, timeZone);
    if (candidate <= now) return { text: weekdayPattern[0], value: addLocalDays(date, 7) };
    return { text: weekdayPattern[0], value: date };
  }

  return undefined;
}

function parseRecurrence(text: string): Match<RecurrenceRule> | undefined {
  const intervalPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))каждые?\s+(несколько|\d+|один|одна|одну|два|две|двух|три|трех|трёх|четыре|пять|шесть|семь|восемь|девять|десять|неделю)\s*(час(?:а|ов)?|минут(?:у|ы)?|дн(?:я|ей)?|недел(?:ю|и|ь)|месяц(?:а|ев)?)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (intervalPattern) {
    const raw = intervalPattern[1].toLocaleLowerCase('ru-RU');
    const unit = intervalPattern[2].toLocaleLowerCase('ru-RU');
    const count = raw === 'неделю' ? 1 : numberValue(raw);
    if (!count) return { text: intervalPattern[0], value: { type: 'interval', intervalMs: 0 } };
    const multiplier = unit.startsWith('час')
      ? 3_600_000
      : unit.startsWith('минут')
        ? 60_000
        : unit.startsWith('недел')
          ? 7 * 86_400_000
          : unit.startsWith('месяц')
            ? 30 * 86_400_000
            : 86_400_000;
    return {
      text: intervalPattern[0],
      value: { type: 'interval', intervalMs: count * multiplier },
    };
  }

  const weekdayRepeatPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))кажд(?:ый|ую|ое)\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu;
  const repeatedDays = [...text.matchAll(new RegExp(weekdayRepeatPattern.source, 'giu'))].map(
    (match) => weekdayNames[match[1].toLocaleLowerCase('ru-RU')],
  );
  if (repeatedDays.length > 0) {
    return {
      text: [...text.matchAll(new RegExp(weekdayRepeatPattern.source, 'giu'))]
        .map((match) => match[0])
        .join(' '),
      value: { type: 'weekly', weekdays: [...new Set(repeatedDays)].sort() },
    };
  }

  const monthlyDay =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:кажд(?:ое|ого)\s+месяц(?:а)?|каждый\s+месяц|ежемесячно)\s*(?:в\s*)?(\d{1,2})(?:-?го)?\s+числа(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))|(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))перв(?:ого|ое)\s+числа(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (monthlyDay) {
    const day = monthlyDay[1] ? Number(monthlyDay[1]) : 1;
    if (day >= 1 && day <= 31) {
      return { text: monthlyDay[0], value: { type: 'monthly', day } };
    }
  }
  const monthlyWithoutDay =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:каждый\s+месяц|ежемесячно)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (monthlyWithoutDay) {
    return { text: monthlyWithoutDay[0], value: { type: 'monthly', day: 0 } };
  }

  const yearly =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))кажд(?:ый|ое)\s+год(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))|(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))ежегодно(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (yearly) {
    return { text: yearly[0], value: { type: 'yearly', month: 0, day: 0 } };
  }

  const weekly =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))еженедельно(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))|(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))каждую\s+неделю(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (weekly) return { text: weekly[0], value: { type: 'weekly', weekdays: [] } };

  const dayPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))по\s+будням(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))|(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))каждый\s+будний\s+день(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (dayPattern) {
    return { text: dayPattern[0], value: { type: 'weekly', weekdays: [1, 2, 3, 4, 5] } };
  }
  const weekendPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))по\s+выходным(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (weekendPattern) {
    return { text: weekendPattern[0], value: { type: 'weekly', weekdays: [0, 6] } };
  }
  const dailyPattern =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))каждый\s+день(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))|(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))ежедневно(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      text,
    );
  if (dailyPattern) return { text: dailyPattern[0], value: { type: 'daily' } };

  return undefined;
}

function cleanContent(text: string, removable: string[]): string {
  let content = text;
  for (const value of removable.filter(Boolean)) {
    content = content.replace(value, ' ');
  }
  return content
    .replace(/^(?:\s*(?:пен(?:ё|е)к|бот)\s*[,!:—-]?\s*)+/iu, '')
    .replace(
      /^(?:\s*(?:напоминай|напомни|напомнить|напомни мне|не забудь|запомни|мне нужно не забыть)\s*)/iu,
      '',
    )
    .replace(/каждого\s+месяца/giu, ' ')
    .replace(
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:для\s+всех|мне|всем|ему|ей|им|участнику|пользователю|беседе|чату|группе|лично|напоминай|напоминать|напомни|напомнить|пожалуйста|что)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/giu,
      ' ',
    )
    .replace(/[,.!?;:—-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function parseReminder(text: string, now: Date, timeZone: string): ParsedReminder {
  const normalized = text.trim();
  const timeMatches = getTimeMatches(normalized);
  const uniqueTimes = [...new Set(timeMatches.map(({ value }) => value.time))];
  const time = uniqueTimes.length === 1 ? uniqueTimes[0] : undefined;
  const ambiguousTime = uniqueTimes.length > 1 || timeMatches.some(({ value }) => value.ambiguous);
  const recurrence = parseRecurrence(normalized);
  let dateMatch = parseDate(normalized, now, timeZone, time);

  if (recurrence?.value.type === 'yearly') {
    const annualDate = parseDate(normalized, now, timeZone, time);
    if (annualDate) {
      const month = Number(annualDate.value.split('-')[1]);
      const day = Number(annualDate.value.split('-')[2]);
      recurrence.value.month = month;
      recurrence.value.day = day;
    }
  }

  const relativeHours =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))через\s+(несколько|\d+|один|одна|одну|два|две|тр(?:и|ех|ёх)|четыре|пять|шесть|семь|восемь|девять|десять)\s*(час(?:а|ов)?|минут(?:у|ы)?)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      normalized,
    );
  let dueAt: Date | undefined;
  if (relativeHours && !recurrence) {
    const count = numberValue(relativeHours[1]);
    if (count) {
      const multiplier = relativeHours[2].startsWith('час') ? 3_600_000 : 60_000;
      dueAt = new Date(now.getTime() + count * multiplier);
    }
  }

  const start = getLocalDateTime(now, timeZone);
  const relativeDays =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))через\s+(неделю|\d+|один|одна|одну|два|две|три|трех|трёх|четыре|пять|шесть|семь|восемь|девять|десять)\s*(день|дня|дней|неделю|недели)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      normalized,
    );
  const oneWeek =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))через\s+неделю(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      normalized,
    );
  if (!dueAt && oneWeek && !time && !recurrence) {
    const date = addLocalDays(start.date, 7);
    dueAt = toUtcDateTime({ date, time: start.time }, timeZone);
    dateMatch = { text: oneWeek[0], value: date };
  }
  if (!dueAt && relativeDays && !time && !recurrence) {
    const rawCount = relativeDays[1].toLocaleLowerCase('ru-RU');
    const count = rawCount === 'неделю' ? 1 : numberValue(rawCount);
    if (count) {
      const weeks = relativeDays[2].startsWith('недел') || rawCount === 'неделю';
      const date = addLocalDays(start.date, count * (weeks ? 7 : 1));
      dueAt = toUtcDateTime({ date, time: start.time }, timeZone);
      dateMatch = { text: relativeDays[0], value: date };
    }
  }
  if (!dueAt && recurrence?.value.type === 'interval' && recurrence.value.intervalMs > 0) {
    dueAt = new Date(now.getTime() + recurrence.value.intervalMs);
  }

  const recurrenceNeedsDate =
    (recurrence?.value.type === 'monthly' && recurrence.value.day === 0) ||
    (recurrence?.value.type === 'yearly' && recurrence.value.month === 0);
  if (!dueAt && time && recurrence && !recurrenceNeedsDate) {
    const rule = recurrence.value;
    if (rule.type === 'weekly' && rule.weekdays.length === 0) {
      rule.weekdays = [getLocalWeekday(start.date)];
    }
    dueAt = dateMatch
      ? toUtcDateTime({ date: dateMatch.value, time }, timeZone)
      : getNextRecurringDate(now, timeZone, time, rule);
  }

  if (!dueAt && dateMatch && time) {
    dueAt = toUtcDateTime({ date: dateMatch.value, time }, timeZone);
    if (dueAt <= now && /(?:сегодня|завтра|послезавтра)/iu.test(dateMatch.text) === false) {
      const explicitYear =
        /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))20\d{2}(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/u.test(
          dateMatch.text,
        );
      if (!explicitYear) {
        const nextDate = addLocalDays(dateMatch.value, 7);
        dueAt = toUtcDateTime({ date: nextDate, time }, timeZone);
        dateMatch = { ...dateMatch, value: nextDate };
      }
    }
  }

  if (!dueAt && !dateMatch && time && !recurrenceNeedsDate) {
    dueAt = toUtcDateTime({ date: start.date, time }, timeZone);
    if (dueAt <= now) {
      const nextDate = addLocalDays(start.date, 1);
      dueAt = toUtcDateTime({ date: nextDate, time }, timeZone);
      dateMatch = { text: '', value: nextDate };
    }
  }

  const endDateMatch =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))до\s+(\d{1,2}[./]\d{1,2}(?:[./]20\d{2})?|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря))(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.exec(
      normalized,
    );
  const endDate = endDateMatch ? parseDate(endDateMatch[1], now, timeZone, '23:59') : undefined;
  const recurrenceEndAt =
    endDate && recurrence
      ? toUtcDateTime({ date: endDate.value, time: '23:59' }, timeZone)
      : undefined;

  const targetMatch = /(?:@id(\d+)|vk\.com\/id(\d+)|\[id(\d+)\|[^\]]+\]|@([a-z][a-z\d_.]*))/iu.exec(
    normalized,
  );
  const groupRequested =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:всем|всех|беседе|чату|группе|для\s+всех)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
      normalized,
    );
  const recurrencePhrases = [
    ...normalized.matchAll(
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:кажд(?:ый|ую|ое)\s+(?:день|будний\s+день|неделю|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|перв(?:ого|ое)\s+числа\s+каждого\s+месяца|каждого\s+месяца|по\s+будням|по\s+выходным|ежедневно|еженедельно|ежемесячно|ежегодно|каждые?\s+(?:несколько|\d+|один|одна|одну|два|две|двух|три|трех|трёх|четыре|пять|шесть|семь|восемь|девять|десять|неделю)\s*(?:час(?:а|ов)?|минут(?:у|ы)?|дн(?:я|ей)?|недел(?:ю|и|ь)|месяц(?:а|ев)?))(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/giu,
    ),
  ].map((match) => match[0]);
  const removable = [
    ...timeMatches.map(({ text: value }) => value),
    recurrence?.text ?? '',
    ...recurrencePhrases,
    dateMatch?.text ?? '',
    endDateMatch?.[0] ?? '',
    relativeHours?.[0] ?? '',
    targetMatch?.[0] ?? '',
    ...[
      ...normalized.matchAll(
        /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:каждый|каждую|каждое|еженедельно|ежегодно|ежемесячно)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/giu,
      ),
    ].map((match) => match[0]),
  ];
  const content = cleanContent(normalized, removable);
  const hasReminderIntent =
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:напомни|напоминай|напомнить|напоминание|не\s+забудь|не\s+забыть|мне\s+нужно\s+не\s+забыть|запланируй)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
      normalized,
    ) || Boolean(recurrence);

  const missing: ParsedReminder['missing'] = !content
    ? 'content'
    : recurrenceNeedsDate
      ? 'date'
      : ambiguousTime || (!time && !dueAt && !recurrence)
        ? 'time'
        : !dueAt && !dateMatch && !recurrence
          ? 'date'
          : null;

  return {
    content,
    ...(dueAt ? { dueAt } : {}),
    ...(dateMatch ? { dueDate: dateMatch.value } : {}),
    ...(time ? { time } : {}),
    ...(recurrence ? { recurrence: recurrence.value } : {}),
    ...(recurrenceEndAt ? { recurrenceEndAt } : {}),
    missing,
    ambiguousTime,
    groupRequested,
    ...(targetMatch?.[1] || targetMatch?.[2] || targetMatch?.[3]
      ? { recipientVkId: targetMatch[1] ?? targetMatch[2] ?? targetMatch[3] }
      : {}),
    ...(targetMatch?.[4] ? { recipientReference: `@${targetMatch[4]}` } : {}),
    recognized: hasReminderIntent,
  };
}

export function formatReminderDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
