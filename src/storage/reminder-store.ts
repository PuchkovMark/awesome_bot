import { randomInt, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { ReminderSchedule } from '../core/reminders/time';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';
import { requireInput } from './validation';

export const reminderGraceMs = 15 * 60_000;
export const reminderStatusMs = 7 * 86_400_000;
const leaseMs = 90_000;
const retryMs = 15_000;
const startedDelivery = `SELECT state FROM personal_reminder_parts
  WHERE reminder_id=r.id AND stage='delivery' AND state!='ready'
  ORDER BY state='unknown' DESC,part LIMIT 1`;
const reminderDetails = `r.*, (${startedDelivery}) AS delivery_state,
  (SELECT definite_failure FROM personal_reminder_parts
    WHERE reminder_id=r.id AND stage='confirmation' AND state!='confirmed'
    ORDER BY part LIMIT 1) AS confirmation_failed`;

export type ReminderStage = 'confirmation' | 'delivery';
type ReminderState = 'draft' | 'pending' | 'delivered' | 'cancelled' | 'missed' | 'unknown';
export interface ReminderDraft {
  readonly needs: 'time' | 'zone' | 'skipped' | 'overlap' | 'text';
  readonly date?: string | undefined;
  readonly schedule?: ReminderSchedule | undefined;
  readonly explicitTimezone?: string | undefined;
  readonly choices?: readonly [number, number] | undefined;
  readonly chosenAt?: number | undefined;
  readonly timeExample?: string | undefined;
}

export type ReminderFields =
  | { readonly draft: ReminderDraft; readonly text: string }
  | {
      readonly dueAt: number;
      readonly timezone: string;
      readonly text: string;
      readonly confirmation: (id: number) => readonly string[];
      readonly scheduleKey?: string;
    };

interface ReminderRecord {
  readonly id: number;
  readonly chat_id: ChatId;
  readonly generation: number;
  readonly origin_at: number;
  readonly state: ReminderState;
  readonly confirmation: 'pending' | 'delivered' | 'unknown';
  readonly text: string | null;
  readonly draft: string | null;
  readonly expires_at: number | null;
  readonly due_at: number | null;
  readonly timezone: string | null;
  readonly finished_at: number | null;
  readonly schedule_key: string | null;
  readonly lock_until: number | null;
  readonly lock_stage: ReminderStage | null;
  readonly delivery_state: Part['state'] | null;
  readonly confirmation_failed: 0 | 1 | null;
}

interface Source {
  readonly scope: ConnectionScope;
  readonly messageId: string;
  readonly originAt: number;
}
interface Recipient {
  readonly userId: UserId;
  readonly scope: ConnectionScope;
}
interface Lease {
  readonly id: number;
  readonly token: string;
  readonly stage: ReminderStage;
  readonly chatId: ChatId;
  readonly generation: number;
  readonly dueAt: number;
  readonly leaseUntil: number;
}
interface Part {
  readonly part: number;
  readonly send_id: number;
  readonly text: string;
  readonly state: 'ready' | 'sending' | 'confirmed' | 'unknown';
  readonly attempted_at: number | null;
  readonly receipt: string | null;
  readonly definite_failure: 0 | 1;
}

interface ConfirmationReceipt {
  readonly part: number;
  readonly send_id: number;
  readonly text: string;
  readonly attempted_at: number;
  readonly receipt: string;
}

type ReminderAssignment =
  | { readonly kind: 'created' | 'existing'; readonly item: ReturnType<typeof view> }
  | { readonly kind: 'choose'; readonly items: readonly ReturnType<typeof view>[] };

function record(db: Database, id: number) {
  return db.prepare(`SELECT ${reminderDetails} FROM personal_reminders r WHERE id=?`).get(id) as
    ReminderRecord | undefined;
}

function recipientRecord(db: Database, recipient: Recipient, id: number) {
  const row = record(db, id);
  return row?.chat_id === recipient.scope.chatId && row.generation === recipient.scope.generation
    ? row
    : undefined;
}

function view(row: ReminderRecord) {
  return {
    id: row.id,
    originAt: row.origin_at,
    state: row.state,
    confirmation:
      row.confirmation === 'delivered'
        ? ('delivered' as const)
        : row.confirmation_failed === 1
          ? ('failed' as const)
          : ('unknown' as const),
    text: row.text,
    draft: row.draft === null ? null : (JSON.parse(row.draft) as ReminderDraft),
    expiresAt: row.expires_at,
    dueAt: row.due_at,
    timezone: row.timezone,
    finishedAt: row.finished_at,
    deliveryStarted: row.delivery_state !== null,
    deliveryUnknown: row.delivery_state === 'unknown',
  };
}

function finishConfirmation(db: Database, id: number) {
  db.prepare("UPDATE personal_reminders SET confirmation='delivered' WHERE id=?").run(id);
  db.prepare(
    "DELETE FROM personal_reminder_parts WHERE reminder_id=? AND stage='confirmation'",
  ).run(id);
}

function finish(
  db: Database,
  id: number,
  state: Exclude<ReminderState, 'draft' | 'pending'>,
  at: number,
) {
  db.prepare(
    `UPDATE personal_reminders SET state=?, finished_at=?, text=NULL,draft=NULL,expires_at=NULL,
    next_at=NULL,lock_token=NULL,lock_until=NULL,lock_stage=NULL,schedule_key=NULL,hint_claimed=0
    WHERE id=?`,
  ).run(state, at, id);
  db.prepare('DELETE FROM personal_reminder_parts WHERE reminder_id=?').run(id);
}

function insertParts(db: Database, id: number, stage: ReminderStage, chunks: readonly string[]) {
  requireInput(chunks.length > 0);
  const insert = db.prepare(
    `INSERT INTO personal_reminder_parts(reminder_id,stage,part,send_id,text)
    VALUES(?,?,?,?,?) ON CONFLICT(send_id) DO NOTHING`,
  );
  for (const [index, text] of chunks.entries()) {
    let inserted = 0;
    while (inserted === 0) {
      inserted = insert.run(id, stage, index, randomInt(1, 2_147_483_648), text).changes;
    }
  }
}

function nextPart(db: Database, lease: Lease) {
  return db
    .prepare(
      `SELECT part,send_id,text,state,attempted_at,receipt,definite_failure FROM personal_reminder_parts
    WHERE reminder_id=? AND stage=? AND state!='confirmed' ORDER BY part LIMIT 1`,
    )
    .get(lease.id, lease.stage) as Part | undefined;
}

function currentLease(db: Database, lease: Lease, now: number, forSend: boolean) {
  return !!db
    .prepare(
      `SELECT 1 FROM personal_reminders r
    JOIN chat_connections c USING(chat_id,generation)
    LEFT JOIN chats s USING(chat_id)
    WHERE r.id=? AND r.lock_token=? AND r.lock_stage=? AND r.lock_until>?
    AND (?=0 OR (c.state='active' AND coalesce(s.enabled,1)=1
    AND (r.lock_stage='confirmation' OR r.due_at+?>=?)))`,
    )
    .get(lease.id, lease.token, lease.stage, now, Number(forSend), reminderGraceMs, now);
}

function release(db: Database, lease: Lease) {
  db.prepare(
    `UPDATE personal_reminders SET lock_token=NULL,lock_until=NULL,lock_stage=NULL
    WHERE id=? AND lock_token=?`,
  ).run(lease.id, lease.token);
}

function leaseRow(db: Database, row: ReminderRecord, stage: ReminderStage, now: number): Lease {
  const token = randomUUID();
  db.prepare('UPDATE personal_reminders SET lock_token=?,lock_until=?,lock_stage=? WHERE id=?').run(
    token,
    now + leaseMs,
    stage,
    row.id,
  );
  return {
    id: row.id,
    token,
    stage,
    chatId: row.chat_id,
    generation: row.generation,
    dueAt: row.due_at!,
    leaseUntil: now + leaseMs,
  };
}

function pendingFromOrigin(db: Database, recipient: Recipient, source: Source) {
  return db
    .prepare(
      `SELECT reminder_id AS id FROM personal_reminder_inputs
    WHERE source_chat_id=? AND source_generation=? AND event_id=?
    AND target_chat_id=? AND target_generation=?`,
    )
    .get(
      source.scope.chatId,
      source.scope.generation,
      source.messageId,
      recipient.scope.chatId,
      recipient.scope.generation,
    ) as { id: number } | undefined;
}

function rememberOrigin(db: Database, recipient: Recipient, source: Source, id: number) {
  db.prepare('INSERT INTO personal_reminder_inputs VALUES (?,?,?,?,?,?)').run(
    source.scope.chatId,
    source.scope.generation,
    source.messageId,
    recipient.scope.chatId,
    recipient.scope.generation,
    id,
  );
}

function maintain(db: Database, now: number) {
  db.prepare("DELETE FROM personal_reminders WHERE state='draft' AND expires_at<=?").run(now);
  const expired = db
    .prepare(
      `SELECT r.id,r.due_at AS due,
    EXISTS(SELECT 1 FROM personal_reminder_parts p WHERE p.reminder_id=r.id
      AND p.stage='delivery' AND p.state!='ready') AS attempted
    FROM personal_reminders r WHERE r.state='pending' AND r.due_at+?<?
    AND (r.lock_until IS NULL OR r.lock_until<=?)`,
    )
    .all(reminderGraceMs, now, now) as { id: number; due: number; attempted: 0 | 1 }[];
  for (const row of expired)
    finish(db, row.id, row.attempted ? 'unknown' : 'missed', row.due + reminderGraceMs + 1);
  db.prepare('DELETE FROM personal_reminders WHERE finished_at<=?').run(now - reminderStatusMs);
}

export function createReminderStore(connection: Connection, lifecycle: LifecycleBackend) {
  function transaction<T>(operation: (db: Database) => T) {
    return connection.run((db) => db.transaction(() => operation(db)).immediate());
  }

  function assertRecipient(db: Database, recipient: Recipient) {
    requireInput(recipient.scope.chatId === recipient.userId);
    lifecycle.assertScope(db, recipient.scope);
    const settings = db
      .prepare('SELECT enabled FROM chats WHERE chat_id=?')
      .get(recipient.scope.chatId) as { enabled: 0 | 1 } | undefined;
    requireInput(settings?.enabled !== 0);
  }

  function save(db: Database, id: number, fields: ReminderFields, expiresAt: number) {
    if ('draft' in fields) {
      db.prepare('UPDATE personal_reminders SET text=?,draft=?,expires_at=? WHERE id=?').run(
        fields.text,
        JSON.stringify(fields.draft),
        expiresAt,
        id,
      );
      return;
    }
    db.prepare(
      `UPDATE personal_reminders SET text=?,state='pending',draft=NULL,expires_at=NULL,
      due_at=?,timezone=?,next_at=?,schedule_key=? WHERE id=?`,
    ).run(fields.text, fields.dueAt, fields.timezone, fields.dueAt, fields.scheduleKey ?? null, id);
    insertParts(db, id, 'confirmation', fields.confirmation(id));
  }

  function addReminder(
    db: Database,
    recipient: Recipient,
    source: Source,
    fields: ReminderFields,
    now: number,
  ) {
    const expiresAt = now + reminderGraceMs;
    const row = db
      .prepare(
        `INSERT INTO personal_reminders(chat_id,generation,origin_at,text,state,draft,expires_at)
        VALUES(?,?,?,?,'draft','{}',?) RETURNING id`,
      )
      .get(
        recipient.scope.chatId,
        recipient.scope.generation,
        source.originAt,
        fields.text,
        expiresAt,
      ) as {
      id: number;
    };
    save(db, row.id, fields, expiresAt);
    rememberOrigin(db, recipient, source, row.id);
    return view(record(db, row.id)!);
  }

  return Object.freeze({
    replay(recipient: Recipient, source: Source, now: number) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        lifecycle.assertScope(db, source.scope);
        maintain(db, now);
        const previous = pendingFromOrigin(db, recipient, source);
        if (!previous) return undefined;
        const row = recipientRecord(db, recipient, previous.id);
        return row ? view(row) : null;
      });
    },
    create(
      recipient: Recipient,
      source: Source,
      fields: ReminderFields,
      now: number,
    ): ReminderAssignment | null {
      return transaction((db) => {
        assertRecipient(db, recipient);
        lifecycle.assertScope(db, source.scope);
        maintain(db, now);
        const previous = pendingFromOrigin(db, recipient, source);
        if (previous) {
          const row = recipientRecord(db, recipient, previous.id);
          return row ? { kind: 'existing', item: view(row) } : null;
        }
        if (!('draft' in fields) && fields.scheduleKey !== undefined) {
          const candidates = db
            .prepare(
              `SELECT ${reminderDetails} FROM personal_reminders r
              WHERE r.chat_id=? AND r.generation=? AND r.state='pending' AND r.confirmation!='delivered'
              AND r.text=? AND (r.schedule_key=? OR r.schedule_key IS NULL) ORDER BY r.id`,
            )
            .all(
              recipient.scope.chatId,
              recipient.scope.generation,
              fields.text,
              fields.scheduleKey,
            ) as ReminderRecord[];
          if (candidates.length === 1 && candidates[0]!.schedule_key === fields.scheduleKey) {
            const row = candidates[0]!;
            rememberOrigin(db, recipient, source, row.id);
            return { kind: 'existing', item: view(row) };
          }
          if (candidates.length) return { kind: 'choose', items: candidates.map(view) };
        }
        return { kind: 'created', item: addReminder(db, recipient, source, fields, now) };
      });
    },
    copy(
      recipient: Recipient,
      source: Source,
      id: number,
      clock: () => number,
      confirmation: (
        text: string,
        dueAt: number,
        timezone: string,
        copyId: number,
      ) => readonly string[],
    ) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        requireInput(source.scope === recipient.scope);
        const now = clock();
        maintain(db, now);
        if (pendingFromOrigin(db, recipient, source)) return { kind: 'replayed' } as const;
        const row = recipientRecord(db, recipient, id);
        if (!row) return null;
        const deadlineReached = row.due_at !== null && row.due_at <= now;
        if (row.state !== 'pending' || row.delivery_state !== null || deadlineReached)
          return { kind: 'unavailable', item: view(row), deadlineReached } as const;
        const text = row.text!;
        const dueAt = row.due_at!;
        const timezone = row.timezone!;
        const item = addReminder(
          db,
          recipient,
          source,
          {
            text,
            dueAt,
            timezone,
            ...(row.schedule_key === null ? {} : { scheduleKey: row.schedule_key }),
            confirmation: (copyId) => confirmation(text, dueAt, timezone, copyId),
          },
          now,
        );
        return { kind: 'created', item } as const;
      });
    },
    revise(
      recipient: Recipient,
      source: Source,
      previousId: number,
      fields: ReminderFields,
      now: number,
    ) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        requireInput(source.scope === recipient.scope);
        maintain(db, now);
        const previous = pendingFromOrigin(db, recipient, source);
        if (previous) {
          const row = record(db, previous.id);
          return row ? view(row) : null;
        }
        const row = record(db, previousId);
        if (
          row?.chat_id !== recipient.scope.chatId ||
          row.generation !== recipient.scope.generation ||
          row.state !== 'draft'
        )
          return null;
        save(db, row.id, fields, row.expires_at!);
        rememberOrigin(db, recipient, source, row.id);
        return view(record(db, row.id)!);
      });
    },
    timezone(recipient: Recipient, timezone?: string) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        const { chatId, generation } = recipient.scope;
        if (timezone)
          db.prepare(
            `INSERT INTO personal_reminder_timezones VALUES(?,?,?)
          ON CONFLICT(chat_id,generation) DO UPDATE SET timezone=excluded.timezone`,
          ).run(chatId, generation, timezone);
        return (
          db
            .prepare(
              'SELECT timezone FROM personal_reminder_timezones WHERE chat_id=? AND generation=?',
            )
            .get(chatId, generation) as { timezone: string } | undefined
        )?.timezone;
      });
    },
    list(recipient: Recipient, now: number, filter?: 'cancellable') {
      return transaction((db) => {
        assertRecipient(db, recipient);
        maintain(db, now);
        return (
          db
            .prepare(
              `SELECT ${reminderDetails} FROM personal_reminders r
            WHERE r.chat_id=? AND r.generation=?
            ${filter === 'cancellable' ? `AND r.state IN ('draft','pending') AND (${startedDelivery}) IS NULL` : ''}
            ORDER BY coalesce(r.due_at,r.origin_at),r.id`,
            )
            .all(recipient.scope.chatId, recipient.scope.generation) as ReminderRecord[]
        ).map(view);
      });
    },
    cancel(recipient: Recipient, id: number, now: number) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        maintain(db, now);
        const row = db
          .prepare(
            `SELECT r.state, (${startedDelivery}) AS started FROM personal_reminders r
          WHERE r.id=? AND r.chat_id=? AND r.generation=?`,
          )
          .get(id, recipient.scope.chatId, recipient.scope.generation) as
          { state: ReminderState; started: Part['state'] | null } | undefined;
        if (!row) return 'missing' as const;
        if (row.state !== 'pending' && row.state !== 'draft') return row.state;
        if (row.started)
          return row.started === 'unknown' ? ('unknown' as const) : ('sending' as const);
        finish(db, id, 'cancelled', now);
        return 'cancelled' as const;
      });
    },
    claimConfirmation(recipient: Recipient, id: number, now: number, retry = false) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        if (retry) maintain(db, now);
        const row = recipientRecord(db, recipient, id);
        if (
          row?.state !== 'pending' ||
          row.confirmation === 'delivered' ||
          row.delivery_state !== null ||
          (row.lock_until !== null && row.lock_until > now)
        )
          return;
        const part = db
          .prepare(
            `SELECT state,attempted_at,definite_failure FROM personal_reminder_parts
          WHERE reminder_id=? AND stage='confirmation' AND state!='confirmed'
          ORDER BY part LIMIT 1`,
          )
          .get(id) as Pick<Part, 'state' | 'attempted_at' | 'definite_failure'> | undefined;
        if (part?.state !== 'ready') return;
        if (
          retry
            ? part.definite_failure !== 1
            : row.confirmation !== 'pending' ||
              part.attempted_at !== null ||
              part.definite_failure === 1
        )
          return;
        return leaseRow(db, row, 'confirmation', now);
      });
    },
    inspectConfirmation(recipient: Recipient, id: number, now: number) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        maintain(db, now);
        const row = recipientRecord(db, recipient, id);
        if (!row) return;
        const parts =
          row.state === 'pending' && row.delivery_state === null && row.confirmation !== 'delivered'
            ? (db
                .prepare(
                  `SELECT part,send_id,text,attempted_at,receipt FROM personal_reminder_parts
                WHERE reminder_id=? AND stage='confirmation' AND state IN ('unknown','sending')
                AND receipt IS NOT NULL AND attempted_at IS NOT NULL ORDER BY part`,
                )
                .all(id) as ConfirmationReceipt[])
            : [];
        return { item: view(row), parts };
      });
    },
    confirmObservedPart(recipient: Recipient, id: number, part: ConfirmationReceipt, now: number) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        const row = recipientRecord(db, recipient, id);
        if (
          row?.state !== 'pending' ||
          row.delivery_state !== null ||
          (row.lock_stage === 'confirmation' && row.lock_until! > now)
        )
          return;
        const confirmed = db
          .prepare(
            `UPDATE personal_reminder_parts SET state='confirmed' WHERE reminder_id=?
          AND stage='confirmation' AND part=? AND send_id=? AND receipt=? AND attempted_at=?
          AND state IN ('sending','unknown')`,
          )
          .run(id, part.part, part.send_id, part.receipt, part.attempted_at);
        if (
          confirmed.changes &&
          !db
            .prepare(
              `SELECT 1 FROM personal_reminder_parts WHERE reminder_id=?
          AND stage='confirmation' AND state!='confirmed'`,
            )
            .get(id)
        )
          finishConfirmation(db, id);
      });
    },
    claimRecoveryHint(recipient: Recipient, source: Source, id: number) {
      return transaction((db) => {
        assertRecipient(db, recipient);
        lifecycle.assertScope(db, source.scope);
        if (
          source.scope.chatId === recipient.scope.chatId ||
          pendingFromOrigin(db, recipient, source)?.id !== id
        )
          return false;
        const row = recipientRecord(db, recipient, id);
        return (
          row?.state === 'pending' &&
          row.delivery_state === null &&
          (row.confirmation === 'unknown' || row.confirmation_failed === 1) &&
          db
            .prepare('UPDATE personal_reminders SET hint_claimed=1 WHERE id=? AND hint_claimed=0')
            .run(id).changes === 1
        );
      });
    },
    claimDelivery(now: number, chunks: (text: string, late: boolean) => readonly string[]) {
      return transaction((db) => {
        maintain(db, now);
        const row = db
          .prepare(
            `SELECT r.* FROM personal_reminders r JOIN chat_connections c USING(chat_id,generation)
          LEFT JOIN chats s USING(chat_id)
          WHERE r.state='pending' AND r.next_at<=? AND (r.lock_until IS NULL OR r.lock_until<=?)
          AND c.state='active' AND coalesce(s.enabled,1)=1
          ORDER BY r.next_at,r.id LIMIT 1`,
          )
          .get(now, now) as ReminderRecord | undefined;
        if (!row) return undefined;
        const lease = leaseRow(db, row, 'delivery', now);
        if (!nextPart(db, lease))
          insertParts(db, row.id, 'delivery', chunks(row.text!, now > row.due_at!));
        return lease;
      });
    },
    getPart(lease: Lease, now: number) {
      return transaction((db) =>
        currentLease(db, lease, now, false) ? nextPart(db, lease) : undefined,
      );
    },
    beginPart(lease: Lease, part: Part, now: number) {
      return transaction((db) => {
        if (!currentLease(db, lease, now, true)) return false;
        return (
          db
            .prepare(
              `UPDATE personal_reminder_parts SET state='sending',attempted_at=?,definite_failure=0
          WHERE reminder_id=? AND stage=? AND part=? AND state='ready' AND receipt IS NULL`,
            )
            .run(now, lease.id, lease.stage, part.part).changes === 1
        );
      });
    },
    receipt(lease: Lease, part: Part, receipt: string) {
      return transaction((db) => {
        db.prepare(
          `UPDATE personal_reminder_parts SET receipt=? WHERE reminder_id=? AND stage=? AND part=?
          AND state='sending' AND EXISTS(SELECT 1 FROM personal_reminders WHERE id=? AND lock_token=?)`,
        ).run(receipt, lease.id, lease.stage, part.part, lease.id, lease.token);
      });
    },
    settle(lease: Lease, part: Part, outcome: 'delivered' | 'failed' | 'unknown', now: number) {
      return transaction((db) => {
        if (!currentLease(db, lease, now, false)) return false;
        const state =
          outcome === 'delivered' ? 'confirmed' : outcome === 'failed' ? 'ready' : 'unknown';
        db.prepare(
          `UPDATE personal_reminder_parts SET state=?,receipt=CASE WHEN ?='ready' THEN NULL ELSE receipt END,
          definite_failure=?
          WHERE reminder_id=? AND stage=? AND part=?`,
        ).run(
          state,
          state,
          Number(lease.stage === 'confirmation' && outcome === 'failed'),
          lease.id,
          lease.stage,
          part.part,
        );
        if (outcome === 'delivered') {
          if (nextPart(db, lease)) return true;
          if (lease.stage === 'delivery') finish(db, lease.id, 'delivered', now);
          else {
            finishConfirmation(db, lease.id);
            release(db, lease);
          }
          return false;
        }
        if (lease.stage === 'delivery') {
          // A receipt can still be checked. A part without one is held to the end of the window.
          const retryAt =
            outcome === 'unknown' && !nextPart(db, lease)?.receipt
              ? lease.dueAt + reminderGraceMs + 1
              : Math.min(now + retryMs, lease.dueAt + reminderGraceMs + 1);
          db.prepare('UPDATE personal_reminders SET next_at=? WHERE id=?').run(retryAt, lease.id);
        } else if (outcome === 'unknown') {
          db.prepare("UPDATE personal_reminders SET confirmation='unknown' WHERE id=?").run(
            lease.id,
          );
        }
        release(db, lease);
        return false;
      });
    },
  });
}

const stores = new WeakMap<Storage, ReturnType<typeof createReminderStore>>();
export function registerReminders(storage: Storage, store: ReturnType<typeof createReminderStore>) {
  stores.set(storage, store);
}

export function reminderStore(storage: Storage) {
  const store = stores.get(storage);
  if (!store) throw new TypeError('Reminders: unavailable');
  return store;
}
