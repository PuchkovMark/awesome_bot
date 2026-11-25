import type { Database } from 'better-sqlite3';
import type { ChatId } from '../contracts/index';
import { historyBounds } from './history-retention-store';

type Operation = { code: string; chatId: ChatId; generation: number };

export function reconcileDisputes(
  staged: Database,
  newer: Database,
  operation: Operation,
  now: number,
) {
  const { code, chatId, generation } = operation;
  const receipts = newer.prepare(
    'SELECT source_chat_id,source_message_id,platform_message_id FROM personal_dispute_reports WHERE code=?',
  );
  const receive = staged.prepare(`INSERT INTO personal_dispute_reports
    (code,source_chat_id,source_message_id,platform_message_id) VALUES(@code,@source_chat_id,@source_message_id,@platform_message_id)
    ON CONFLICT(source_chat_id,source_message_id) DO UPDATE SET code=excluded.code,platform_message_id=excluded.platform_message_id`);
  for (const row of receipts.iterate(code) as Iterable<object>) receive.run({ ...row, code });

  const cases = newer.prepare(
    'SELECT platform_message_id,state FROM personal_dispute_cases WHERE code=?',
  );
  const save =
    staged.prepare(`INSERT INTO personal_dispute_cases(code,platform_message_id,state) VALUES(@code,@platform_message_id,@state)
    ON CONFLICT(code,platform_message_id) DO UPDATE SET state=excluded.state`);
  for (const row of cases.iterate(code) as Iterable<object>) save.run({ ...row, code });

  // До версии 58 оставленная запись не имела решения. Нужна доступная живая реплика той же операции.
  const legacy = staged
    .prepare(
      `SELECT m.platform_message_id,m.user_id,m.role,m.timestamp
    FROM personal_dispute_cases c JOIN messages m ON m.chat_id=? AND m.platform_message_id=c.platform_message_id
    JOIN personal_hidden_messages h ON h.message_id=m.id AND h.code=c.code AND h.disputed=1
    WHERE c.code=? AND c.state='legacy_open'`,
    )
    .all(chatId, code) as {
    platform_message_id: string;
    user_id: string;
    role: string;
    timestamp: number;
  }[];
  if (legacy.length) {
    const bounds = historyBounds(newer, chatId, now);
    const visible = newer.prepare(`SELECT 1 FROM personal_visible_messages m
      WHERE m.chat_id=@chatId AND m.platform_message_id=@platform_message_id AND m.user_id=@user_id
      AND m.role=@role AND m.timestamp=@timestamp AND m.id>@clearedThrough AND m.timestamp>@expiredThrough
      AND NOT EXISTS(SELECT 1 FROM personal_dispute_cases WHERE code=@code AND platform_message_id=@platform_message_id)
      AND NOT EXISTS(SELECT 1 FROM history_deleted_inputs WHERE chat_id=@chatId AND generation=@generation AND platform_message_id=@platform_message_id)`);
    for (const row of legacy)
      if (visible.get({ ...row, ...bounds, chatId, generation, code }))
        save.run({ code, platform_message_id: row.platform_message_id, state: 'keep' });
  }
  staged
    .prepare(
      `DELETE FROM personal_hidden_messages WHERE code=@code AND disputed=1 AND message_id IN (
    SELECT m.id FROM personal_dispute_cases c JOIN messages m ON m.platform_message_id=c.platform_message_id
    WHERE c.code=@code AND c.state='keep' AND m.chat_id=@chatId)`,
    )
    .run({ code, chatId });
}
