/// <reference lib="esnext.temporal" />
import type { ChatSummaryStore, SummaryPeriod } from '../../storage/chat-summary-store';
import { localDay } from './calendar';
import type { SummaryEngine, SummaryPiece, SummaryRun } from './worker';
import { isRecapRequest } from './recap-intent';
import { SummaryFailure } from './compress';

export function recapPeriod(
  text: string,
  now: number,
  timezone: string,
): SummaryPeriod | 'clarify' | null {
  if (!isRecapRequest(text)) return null;
  const request = text.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const dates = [
    ...request.matchAll(/\d{4}-\d\d-\d\d(?:[t ]\d\d:\d\d(?::\d\d)?(?:z|[+-]\d\d:\d\d)?)?/gu),
  ].map((match) => match[0]!);
  const relative = request.match(/позавчера|вчера|сегодня/gu) ?? [];
  if (dates.length || relative.length) {
    if (dates.length > 2 || relative.length > 2 || (dates.length && relative.length))
      return 'clarify';
    try {
      const bounds = dates.length
        ? dates.map((value) => {
            if (value.length === 10)
              return {
                at: Temporal.PlainDate.from(value).toZonedDateTime(timezone).epochMilliseconds,
                day: true,
              };
            const iso = value.replace(' ', 'T').toUpperCase();
            const at = /Z|[+-]\d\d:\d\d$/u.test(iso)
              ? Temporal.Instant.from(iso)
              : Temporal.PlainDateTime.from(iso).toZonedDateTime(timezone, {
                  disambiguation: 'reject',
                });
            return { at: at.epochMilliseconds, day: false };
          })
        : relative.map((value) => ({
            at: localDay(now, timezone, value === 'позавчера' ? -2 : value === 'вчера' ? -1 : 0)
              .from,
            day: true,
          }));
      const first = bounds[0]!,
        last = bounds.at(-1)!;
      let from = first.at,
        to = last.day ? localDay(last.at, timezone).to : last.at;
      if (first.day && last.day) {
        const times = [...request.matchAll(/(?:с|по|до)\s+(\d{1,2}:\d{2})(?!\d)/gu)].map(
          (m) => m[1]!,
        );
        if (times.length === 2) {
          const timeAt = (at: number, time: string) =>
            Temporal.Instant.fromEpochMilliseconds(at)
              .toZonedDateTimeISO(timezone)
              .toPlainDate()
              .toPlainDateTime(Temporal.PlainTime.from(time.padStart(5, '0')))
              .toZonedDateTime(timezone, { disambiguation: 'reject' }).epochMilliseconds;
          from = timeAt(first.at, times[0]!);
          to = timeAt(last.at, times[1]!);
        } else if (/вечером|утром|ночью|днем|\d{1,2}:\d{2}|(?:с|до|в) \d{1,2}(?!\d)/u.test(request))
          return 'clarify';
      }
      return from < to ? { from, to, timezone } : 'clarify';
    } catch {
      return 'clarify';
    }
  }
  const recent = request.match(/последни[ехйя]+\s+(?:(\d{1,2})\s+д|недел)/u);
  if (recent || /за неделю/u.test(request)) {
    const days = recent?.[1] ? Number(recent[1]) : 7;
    if (days < 1) return 'clarify';
    return { ...localDay(now, timezone, -days), to: localDay(now, timezone).from };
  }
  return 'clarify';
}

export async function recap(
  engine: SummaryEngine,
  store: ChatSummaryStore,
  run: SummaryRun,
  period: SummaryPeriod,
) {
  const complete: SummaryPiece[] = [];
  let partial = false;
  try {
    // Пустые участки вне доступного журнала не требуют перебора календарных дней.
    const bounds = store.bounds(run.scope);
    if (bounds.first !== null && bounds.last !== null) {
      for (
        let day = localDay(Math.max(period.from, bounds.first), period.timezone);
        day.from < period.to && day.from <= bounds.last;
        day = localDay(day.to, period.timezone)
      ) {
        if (!run.current()) throw new SummaryFailure('cancelled');
        const slice = {
          ...day,
          from: Math.max(day.from, period.from),
          to: Math.min(day.to, period.to),
        };
        const ids = store.ids(run.scope, slice, run.cutoff);
        if (!ids.length) continue;
        const ready = engine.ready(run.scope, slice, 'day', run.cutoff, ids);
        if (ready) {
          complete.push(ready);
          continue;
        }
        const parts: SummaryPiece[] = [];
        try {
          await engine.fragments(run, day, ids, true, (part) => parts.push(part));
          parts.sort((a, b) => a.ids[0]! - b.ids[0]!);
          const daily = await engine.produce(run, slice, 'day', ids, parts);
          complete.push(daily);
        } catch (error) {
          complete.push(...parts);
          throw error;
        }
      }
    }
    if (complete.length > 1) {
      const ids = complete.flatMap((p) => p.ids).sort((a, b) => a - b);
      const result = await engine.produce(run, period, 'rolling', ids, complete);
      complete.splice(0, complete.length, result);
    }
  } catch (error) {
    if (
      !(error instanceof SummaryFailure) ||
      error.reason !== 'limit' ||
      !complete.some((p) => p.entry.text)
    )
      throw error;
    partial = true;
  }
  const data = complete.filter((p) => p.entry.text);
  // При исчерпании квоты выбираем целиком первый проверенный фрагмент.
  const used = partial ? data.slice(0, 1) : data;
  const body = used.map((p) => p.entry.text).join('\n');
  return {
    text: partial
      ? 'Удалось собрать только часть переписки. ' + body
      : body || 'За этот период нет доступных содержательных сообщений.',
    entries: (partial ? used : complete).map((p) => p.entry.id),
    ids: (partial ? used : complete).flatMap((p) => p.ids),
  };
}
