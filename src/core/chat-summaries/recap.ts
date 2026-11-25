/// <reference lib="esnext.temporal" />
import type { ChatSummaryStore, SummaryPeriod } from '../../storage/chat-summary-store';
import { localDay } from './calendar';
import type { SummaryEngine, SummaryPiece, SummaryRun } from './worker';
import { parseRecapPeriod } from './recap-period';
import { isRecapRequest } from './recap-intent';
import { SummaryFailure } from './compress';

export function recapPeriod(
  text: string,
  now: number,
  timezone: string,
): SummaryPeriod | 'clarify' | null {
  if (!isRecapRequest(text)) return null;
  const result = parseRecapPeriod(text, now, timezone);
  return result.kind === 'period' ? result.period : 'clarify';
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
