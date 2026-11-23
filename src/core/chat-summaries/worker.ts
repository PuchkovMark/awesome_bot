import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectionScope } from '../../contracts/index';
import type {
  ChatSummaryStore,
  SummaryEntry,
  SummaryLevel,
  SummaryPeriod,
} from '../../storage/chat-summary-store';
import { compressTexts, summarizeMessages, SummaryFailure, type Compression } from './compress';
import { localDay } from './calendar';

export interface SummaryRun {
  readonly scope: ConnectionScope;
  readonly cutoff: number;
  readonly compression: Compression;
  current(): boolean;
  canStart?(): boolean;
  beforeRaw?(): Promise<void>;
}
export interface SummaryPiece {
  entry: SummaryEntry;
  ids: readonly number[];
}
export function summaryEngine(store: ChatSummaryStore, fragmentSize: number) {
  async function produce(
    run: SummaryRun,
    period: SummaryPeriod,
    level: SummaryLevel,
    ids: readonly number[],
    children: readonly SummaryPiece[],
  ) {
    const scope = run.scope;
    if (!run.current()) throw new SummaryFailure('cancelled');
    if (run.canStart && !run.canStart()) throw new SummaryFailure('busy');
    const acquire = () =>
      store.claim(
        scope,
        period,
        level,
        ids,
        children.map((child) => child.entry.id),
        Date.now(),
      );
    let claim = acquire();
    if (!claim && run.beforeRaw) {
      if (level === 'fragment' && store.inputsCurrent(scope, ids)) await run.beforeRaw();
      while (!claim && run.current() && !run.compression.signal.aborted) {
        if (
          !store.inputsCurrent(scope, ids) ||
          !store.current(
            scope,
            children.map((child) => child.entry.id),
          )
        )
          throw new SummaryFailure('cancelled');
        await delay(50, undefined, { signal: run.compression.signal });
        claim = acquire();
      }
    }
    if (!claim) throw new SummaryFailure('busy');
    if (claim.kind === 'ready') return { entry: claim.entry, ids };
    const current = () =>
      !run.compression.signal.aborted && run.current() && store.hold(scope, claim.id, claim.token);
    try {
      let texts: readonly string[];
      if (level === 'fragment') {
        await run.beforeRaw?.();
        if (!current()) throw new SummaryFailure('cancelled');
        const rows = store.messages(scope, ids);
        if (rows.length !== ids.length) throw new SummaryFailure('cancelled');
        texts = summarizeMessages(rows, period.timezone);
      } else texts = children.map((child) => child.entry.text);
      const summary = await compressTexts(texts, {
        ...run.compression,
        invoke(request) {
          if (!current()) throw new SummaryFailure('cancelled');
          return run.compression.invoke(request);
        },
      });
      if (!current()) throw new SummaryFailure('cancelled');
      const entry = store.finish(scope, claim.id, claim.token, summary);
      if (!entry) throw new SummaryFailure('cancelled');
      return { entry, ids };
    } catch (error) {
      try {
        store.release(scope, claim.id, claim.token);
      } catch {
        /* Старое поколение уже закрыто. */
      }
      throw error;
    }
  }
  function ready(
    scope: ConnectionScope,
    period: SummaryPeriod,
    level: SummaryLevel,
    cutoff: number,
    ids: readonly number[],
  ): SummaryPiece | undefined {
    const entry = store
      .entries(scope, period, level, cutoff)
      .find((row) => row.count === ids.length && row.lastId === ids.at(-1));
    // Все источники видимы и входят в тот же период и границу. Равенство мощностей означает полное покрытие.
    return entry ? { entry, ids } : undefined;
  }
  async function fragments(
    run: SummaryRun,
    period: SummaryPeriod,
    ids: readonly number[],
    closeTail: boolean,
    save?: (piece: SummaryPiece) => void,
  ) {
    const remaining = new Set(ids);
    const pieces: SummaryPiece[] = [];
    for (const row of store.entries(run.scope, period, 'fragment', run.cutoff)) {
      const covered = store.sources(run.scope, row.id);
      if (!covered.length || !covered.every((id) => remaining.has(id))) continue;
      for (const id of covered) remaining.delete(id);
      const piece = { entry: row, ids: covered };
      pieces.push(piece);
      save?.(piece);
    }
    const pending = [...remaining];
    const width = run.beforeRaw ? 2 : 1;
    for (let start = 0; start < pending.length; start += fragmentSize * width) {
      const batches = [];
      for (let i = 0; i < width; i++) {
        const batch = pending.slice(start + i * fragmentSize, start + (i + 1) * fragmentSize);
        if (batch.length && (closeTail || batch.length === fragmentSize)) batches.push(batch);
      }
      const completed = await Promise.allSettled(
        batches.map((batch) => produce(run, period, 'fragment', batch, [])),
      );
      for (const result of completed)
        if (result.status === 'fulfilled') {
          pieces.push(result.value);
          save?.(result.value);
        }
      for (const result of completed) if (result.status === 'rejected') throw result.reason;
    }
    return pieces.sort((a, b) => a.ids[0]! - b.ids[0]!);
  }
  async function day(run: SummaryRun, period: SummaryPeriod, closed: boolean) {
    const ids = store.ids(run.scope, period, run.cutoff);
    if (!ids.length) return;
    const cached = ready(run.scope, period, 'day', run.cutoff, ids);
    if (cached) return cached;
    const parts = await fragments(run, period, ids, closed);
    if (closed) return produce(run, period, 'day', ids, parts);
  }
  async function maintain(run: SummaryRun, first: number, now: number, timezone: string) {
    const today = localDay(now, timezone);
    const week = { ...today, from: localDay(now, timezone, -7).from, to: today.from };
    const days: SummaryPiece[] = [];
    for (
      let period = localDay(first, timezone);
      period.from <= today.from;
      period = localDay(period.to, timezone)
    ) {
      if (!run.current()) throw new SummaryFailure('cancelled');
      const entry = await day(run, period, period.to <= today.from);
      if (entry && period.from >= week.from && period.to <= week.to) days.push(entry);
      await delay(0, undefined, { signal: run.compression.signal });
    }
    if (days.length) {
      const ids = days.flatMap((piece) => piece.ids).sort((a, b) => a - b);
      if (!ready(run.scope, week, 'rolling', run.cutoff, ids))
        await produce(run, week, 'rolling', ids, days);
    }
  }
  return { maintain, ready, fragments, produce };
}
export type SummaryEngine = ReturnType<typeof summaryEngine>;
