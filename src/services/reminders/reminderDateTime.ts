export type RecurrenceRule =
  | { type: 'interval'; intervalMs: number }
  | { type: 'daily' }
  | { type: 'weekly'; weekdays: number[] }
  | { type: 'monthly'; day: number }
  | { type: 'yearly'; month: number; day: number };

export interface LocalDateTime {
  date: string;
  time: string;
}

function localParts(date: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function localDateTimeValue(value: LocalDateTime): number {
  const [year, month, day] = value.date.split('-').map(Number);
  const [hour, minute] = value.time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

export function getLocalDateTime(date: Date, timeZone: string): LocalDateTime {
  return localParts(date, timeZone);
}

export function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(
    result.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function getLocalWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function toUtcDateTime(local: LocalDateTime, timeZone: string): Date {
  const target = localDateTimeValue(local);
  let guess = target;
  const visited = new Set<number>();
  const candidates: number[] = [];

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (visited.has(guess)) break;
    visited.add(guess);
    candidates.push(guess);
    const actual = localDateTimeValue(localParts(new Date(guess), timeZone));
    const difference = target - actual;
    if (difference === 0) return new Date(guess);
    guess += difference;
  }

  const exact = candidates
    .filter((candidate) => localDateTimeValue(localParts(new Date(candidate), timeZone)) === target)
    .sort((left, right) => left - right);
  if (exact.length > 0) return new Date(exact[0]);

  const afterGap = candidates
    .map((candidate) => ({
      candidate,
      localValue: localDateTimeValue(localParts(new Date(candidate), timeZone)),
    }))
    .filter(({ localValue }) => localValue > target)
    .sort((left, right) => left.localValue - right.localValue || left.candidate - right.candidate);
  if (afterGap.length > 0) return new Date(afterGap[0].candidate);

  throw new Error(`Unable to resolve local time ${local.date} ${local.time} in ${timeZone}`);
}

function dateTimeForLocalDate(date: string, time: string, timeZone: string): Date {
  return toUtcDateTime({ date, time }, timeZone);
}

export function getNextRecurringDate(
  now: Date,
  timeZone: string,
  time: string,
  rule: RecurrenceRule,
): Date {
  if (rule.type === 'interval') {
    return new Date(now.getTime() + rule.intervalMs);
  }

  const today = getLocalDateTime(now, timeZone).date;
  if (rule.type === 'daily') {
    for (let offset = 0; offset < 3; offset += 1) {
      const candidate = dateTimeForLocalDate(addLocalDays(today, offset), time, timeZone);
      if (candidate > now) return candidate;
    }
  }

  if (rule.type === 'weekly') {
    const weekdays = new Set(rule.weekdays);
    for (let offset = 0; offset < 15; offset += 1) {
      const date = addLocalDays(today, offset);
      if (!weekdays.has(getLocalWeekday(date))) continue;
      const candidate = dateTimeForLocalDate(date, time, timeZone);
      if (candidate > now) return candidate;
    }
  }

  if (rule.type === 'monthly') {
    const [year, month] = today.split('-').map(Number);
    for (let offset = 0; offset < 14; offset += 1) {
      const monthIndex = month - 1 + offset;
      const candidateYear = year + Math.floor(monthIndex / 12);
      const candidateMonth = (monthIndex % 12) + 1;
      const day = Math.min(rule.day, getDaysInMonth(candidateYear, candidateMonth));
      const date = `${candidateYear}-${String(candidateMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const candidate = dateTimeForLocalDate(date, time, timeZone);
      if (candidate > now) return candidate;
    }
  }

  if (rule.type === 'yearly') {
    const [year] = today.split('-').map(Number);
    for (let offset = 0; offset < 5; offset += 1) {
      const candidateYear = year + offset;
      const day = Math.min(rule.day, getDaysInMonth(candidateYear, rule.month));
      const date = `${candidateYear}-${String(rule.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const candidate = dateTimeForLocalDate(date, time, timeZone);
      if (candidate > now) return candidate;
    }
  }

  throw new Error(`Unable to find next reminder occurrence for ${rule.type}`);
}
