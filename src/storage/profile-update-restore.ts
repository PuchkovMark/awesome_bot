import type { Database } from 'better-sqlite3';
import { historyBounds } from './history-retention-store';
import { tokenBudgetWindowMs } from './token-budget-store';

function sources(db: Database, now: number) {
  const bounds = new Map<string, ReturnType<typeof historyBounds>>();
  const find = db.prepare(
    `SELECT id FROM personal_visible_messages
    WHERE chat_id=@chat AND platform_message_id=@message AND user_id=@user AND timestamp=@at
      AND id>@clearedThrough AND timestamp>@expiredThrough AND sender_bot=0
      AND purpose='conversation' AND role='user'`,
  );
  return (source: { chat: string; message: string; user: string; at: number }) => {
    let boundary = bounds.get(source.chat);
    if (!boundary) {
      boundary = historyBounds(db, source.chat, now);
      bounds.set(source.chat, boundary);
    }
    return !!find.get({ ...source, ...boundary });
  };
}

interface SourceKey {
  readonly chat: string;
  readonly user: string;
  readonly message: string;
  readonly at: number;
}

export function reconcileStagedProfileUpdates(staged: Database, newer: Database, now: number) {
  const inSnapshot = sources(staged, now);
  const inLatest = sources(newer, now);
  const latestWait = newer.prepare(
    `SELECT w.queued_at AS at FROM profile_update_waiting w JOIN messages m ON m.id=w.message_id
     WHERE w.chat_id=@chat AND w.generation=@generation AND m.platform_message_id=@message
       AND m.user_id=@user AND m.timestamp=@at`,
  );
  const waiting = staged
    .prepare(
      `SELECT w.message_id AS id,w.chat_id AS chat,w.generation,m.user_id AS user,
       m.platform_message_id AS message,m.timestamp AS at FROM profile_update_waiting w
       JOIN messages m ON m.id=w.message_id`,
    )
    .all() as (SourceKey & { id: number; generation: number })[];
  const forgetWaiting = staged.prepare('DELETE FROM profile_update_waiting WHERE message_id=?');
  const keepWaiting = staged.prepare(
    'UPDATE profile_update_waiting SET queued_at=? WHERE message_id=?',
  );
  for (const source of waiting) {
    const current = latestWait.get(source) as { at: number } | undefined;
    if (current && inSnapshot(source) && inLatest(source)) keepWaiting.run(current.at, source.id);
    else forgetWaiting.run(source.id);
  }

  const latestFact = newer.prepare(
    `SELECT r.rejected_at AS rejectedAt FROM profile_facts f
     LEFT JOIN profile_fact_rejections r ON r.fact_id=f.id
     WHERE f.chat_id=@chat AND f.generation=@generation AND f.user_id=@user AND f.source_user_id=@user
       AND f.source_message_id=@message AND f.source_at=@at AND f.event_key=@event
       AND f.field_key=@field AND f.value=@value AND f.source_kind='inferred'`,
  );
  const savedFacts = staged
    .prepare(
      `SELECT id,chat_id AS chat,generation,user_id AS user,source_message_id AS message,source_at AS at,
      event_key AS event,field_key AS field,value
     FROM profile_facts WHERE source_kind='inferred' AND generation IS NOT NULL`,
    )
    .all() as (SourceKey & {
    id: number;
    generation: number;
    event: string;
    field: string;
    value: string;
  })[];
  const erase = staged.prepare('DELETE FROM profile_facts WHERE id=?');
  const reject = staged.prepare(
    `INSERT INTO profile_fact_rejections VALUES(?,?)
      ON CONFLICT(fact_id) DO UPDATE SET rejected_at=max(rejected_at,excluded.rejected_at)`,
  );
  for (const fact of savedFacts) {
    const current = latestFact.get(fact) as { rejectedAt: number | null } | undefined;
    if (!current || !inSnapshot(fact) || !inLatest(fact)) erase.run(fact.id);
    else if (current.rejectedAt !== null) reject.run(fact.id, current.rejectedAt);
  }

  const savedScope = staged.prepare(
    'SELECT 1 FROM chat_connections WHERE chat_id=@chat_id AND generation=@generation',
  );
  staged.exec(
    'DELETE FROM profile_inference_rejections; UPDATE profile_update_runs SET attempt_key=NULL;',
  );
  const copyRejection = staged.prepare(
    'INSERT INTO profile_inference_rejections VALUES(@chat_id,@generation,@user_id,@field_key,@value_key,@rejected_at)',
  );
  for (const row of newer
    .prepare('SELECT * FROM profile_inference_rejections')
    .iterate() as Iterable<object>)
    if (savedScope.get(row)) copyRejection.run(row);
  const copyRun = staged.prepare(
    `INSERT INTO profile_update_runs VALUES(@chat_id,@generation,@started_at,NULL)
     ON CONFLICT(chat_id,generation) DO UPDATE SET started_at=max(started_at,excluded.started_at)`,
  );
  for (const row of newer
    .prepare('SELECT * FROM profile_update_runs')
    .iterate() as Iterable<object>)
    if (savedScope.get(row)) copyRun.run(row);

  const copySpend = staged.prepare(
    `INSERT INTO token_budget_attempts VALUES(@chat_id,@generation,@attempt_key,@admitted_at,'profile_update',
       @input_reserve,@output_reserve,@input_tokens,@output_tokens)
     ON CONFLICT(chat_id,generation,attempt_key) DO UPDATE SET
       input_tokens=coalesce(excluded.input_tokens,input_tokens),
       output_tokens=coalesce(excluded.output_tokens,output_tokens)
     WHERE purpose='profile_update'`,
  );
  for (const row of newer
    .prepare("SELECT * FROM token_budget_attempts WHERE purpose='profile_update' AND admitted_at>?")
    .iterate(now - tokenBudgetWindowMs) as Iterable<object>)
    if (savedScope.get(row)) copySpend.run(row);
}
