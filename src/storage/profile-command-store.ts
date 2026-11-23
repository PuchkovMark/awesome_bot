import { randomInt } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type {
  ProfileCommandChange,
  ProfileCommandEdit,
  ProfileCommandEditResult,
  ProfileCommandEvent,
} from './profile-command-types';
import type { OwnProfileFact } from './participant-types';
import { selectOwnProfile } from './profile-fact-selection';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';

const day = 86_400_000;
const messageKey = /^[1-9][0-9]*$/u;

export interface ProfileCommandPartRange {
  readonly first: number;
  readonly last: number;
}
export interface ProfileCommandList {
  readonly id: number;
  readonly actor: UserId;
  readonly privateScope: ConnectionScope;
  readonly target: ConnectionScope;
  readonly title: string | null;
  readonly facts: readonly OwnProfileFact[];
}

interface ListRow {
  readonly id: number;
  readonly user_id: UserId;
  readonly private_generation: number;
  readonly chat_id: ChatId;
  readonly generation: number;
  readonly opened_at: number;
}

function listRow(db: Database, actor: UserId, privateScope: ConnectionScope, now: number) {
  return db
    .prepare(
      'SELECT * FROM profile_command_lists WHERE user_id=? AND private_generation=? AND opened_at>?',
    )
    .get(actor, privateScope.generation, now - day) as ListRow | undefined;
}

export function claimProfileCommand(
  db: Database,
  actor: UserId,
  event: ProfileCommandEvent,
  now: number,
) {
  timestamp(now);
  timestamp(event.at);
  timestamp(event.at + day);
  requireInput(messageKey.test(event.messageId) && Number.isSafeInteger(Number(event.messageId)));
  if (event.at + day <= now) return false;
  return (
    db
      .prepare(`INSERT INTO profile_command_events VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(event.scope.chatId, event.scope.generation, event.messageId, actor, event.at + day)
      .changes === 1
  );
}

type Position = Pick<OwnProfileFact, 'factId' | 'restrictionId' | 'visibility'> & {
  readonly position: number;
};

function samePosition(saved: Position, current: OwnProfileFact) {
  return (
    saved.factId === current.factId &&
    saved.restrictionId === current.restrictionId &&
    saved.visibility === current.visibility
  );
}

function positionRows(db: Database, id: number) {
  return db
    .prepare(
      `SELECT position,fact_id AS factId,restriction_id AS restrictionId,visibility
    FROM profile_command_positions WHERE list_id=? ORDER BY position`,
    )
    .all(id) as Position[];
}

export function createProfileCommandStore(
  connection: Connection,
  lifecycle: LifecycleBackend,
  editFact: (
    db: Database,
    scope: ConnectionScope,
    actor: UserId,
    fact: OwnProfileFact,
    change: ProfileCommandChange,
    event: ProfileCommandEvent,
    now: number,
  ) => ProfileCommandEditResult,
) {
  function activeList(db: Database, list: ProfileCommandList, now: number) {
    lifecycle.assertScope(db, list.privateScope);
    return listRow(db, list.actor, list.privateScope, now)?.id === list.id;
  }

  function current(db: Database, list: ProfileCommandList, now: number) {
    if (!activeList(db, list, now)) return false;
    const facts = selectOwnProfile(db, list.target, list.actor, now);
    const previous = positionRows(db, list.id);
    return (
      facts.length === previous.length &&
      previous.every(
        (item, index) => item.position === index + 1 && samePosition(item, facts[index]!),
      )
    );
  }

  return {
    seen(event: ProfileCommandEvent, now: number) {
      return lifecycle.transaction(
        event.scope,
        (db) =>
          event.at + day <= now ||
          db
            .prepare(
              'SELECT 1 FROM profile_command_events WHERE chat_id=? AND generation=? AND event_id=?',
            )
            .get(event.scope.chatId, event.scope.generation, event.messageId) !== undefined,
      );
    },
    open(
      actor: UserId,
      privateScope: ConnectionScope,
      target: ConnectionScope,
      event: ProfileCommandEvent,
      now: number,
    ): ProfileCommandList | null {
      requireInput(privateScope.chatId === actor);
      const origin = event.scope.chatId === privateScope.chatId ? privateScope : target;
      requireInput(
        event.scope.chatId === origin.chatId && event.scope.generation === origin.generation,
      );
      return lifecycle.transaction(target, (db) => {
        lifecycle.assertScope(db, privateScope);
        lifecycle.assertScope(db, event.scope);
        if (!claimProfileCommand(db, actor, event, now)) return null;
        db.prepare('DELETE FROM profile_command_lists WHERE user_id=?').run(actor);
        const saved = db
          .prepare(
            `INSERT INTO profile_command_lists
          (user_id,private_generation,chat_id,generation,opened_at) VALUES(?,?,?,?,?)`,
          )
          .run(actor, privateScope.generation, target.chatId, target.generation, now);
        const id = Number(saved.lastInsertRowid);
        const facts = selectOwnProfile(db, target, actor, now);
        const insert = db.prepare('INSERT INTO profile_command_positions VALUES(?,?,?,?,?)');
        for (const [index, fact] of facts.entries())
          insert.run(id, index + 1, fact.factId, fact.restrictionId, fact.visibility);
        const title = db
          .prepare('SELECT title FROM chats WHERE chat_id=?')
          .pluck()
          .get(target.chatId) as string | null | undefined;
        return { id, actor, privateScope, target, facts, title: title ?? null };
      });
    },
    current(list: ProfileCommandList, now: number) {
      return lifecycle.transaction(list.target, (db) => current(db, list, now));
    },
    parts(list: ProfileCommandList, ranges: readonly ProfileCommandPartRange[], now: number) {
      return lifecycle.transaction(list.target, (db) => {
        if (!current(db, list, now)) return null;
        const insert = db.prepare(`INSERT INTO profile_command_parts
          (list_id,part,first_position,last_position,send_id) VALUES(?,?,?,?,?)
          ON CONFLICT(send_id) DO NOTHING`);
        return ranges.map(({ first, last }, index) => {
          let sendId: number;
          do {
            sendId = randomInt(1, 0x80000000);
          } while (insert.run(list.id, index + 1, first, last, sendId).changes === 0);
          return { number: index + 1, sendId };
        });
      });
    },
    confirm(list: ProfileCommandList, part: number, sendId: number, receipt: string, now: number) {
      requireInput(messageKey.test(receipt) && Number.isSafeInteger(Number(receipt)));
      return lifecycle.transaction(list.target, (db) => {
        if (!activeList(db, list, now)) return false;
        return (
          db
            .prepare(
              `UPDATE profile_command_parts SET receipt=?
          WHERE list_id=? AND part=? AND send_id=? AND receipt IS NULL`,
            )
            .run(receipt, list.id, part, sendId).changes === 1
        );
      });
    },
    edit(
      privateScope: ConnectionScope,
      actor: UserId,
      input: ProfileCommandEdit,
      now: number,
    ): ProfileCommandEditResult {
      requireInput(privateScope.chatId === actor);
      requireInput(Number.isSafeInteger(input.position) && input.position > 0);
      const event = { scope: privateScope, messageId: input.messageId, at: input.at };
      return lifecycle.transaction(privateScope, (db) => {
        if (!claimProfileCommand(db, actor, event, now)) return 'duplicate';
        const list = listRow(db, actor, privateScope, now);
        if (!list) return 'stale';
        const position = db
          .prepare(
            `SELECT p.position,p.fact_id AS factId,p.restriction_id AS restrictionId,p.visibility
          FROM profile_command_positions p JOIN profile_command_parts t ON t.list_id=p.list_id
          WHERE p.list_id=? AND p.position=? AND t.receipt=?
          AND p.position BETWEEN t.first_position AND t.last_position
          AND NOT EXISTS(SELECT 1 FROM profile_command_parts missed WHERE missed.list_id=p.list_id
            AND missed.receipt IS NULL AND p.position BETWEEN missed.first_position AND missed.last_position)`,
          )
          .get(list.id, input.position, input.replyId) as Position | undefined;
        if (!position) return 'stale';
        const available = db
          .prepare(
            "SELECT 1 FROM chat_connections WHERE chat_id=? AND generation=? AND state='active'",
          )
          .get(list.chat_id, list.generation);
        if (!available) return 'stale';
        const target = lifecycle.restore({ chatId: list.chat_id, generation: list.generation });
        return lifecycle.transaction(target, (targetDb) => {
          const fact = selectOwnProfile(targetDb, target, actor, now).find((row) =>
            samePosition(position, row),
          );
          return fact ? editFact(targetDb, target, actor, fact, input.change, event, now) : 'stale';
        });
      });
    },
    prune(now: number) {
      timestamp(now);
      connection.run((db) =>
        db
          .transaction(() => {
            db.prepare('DELETE FROM profile_command_lists WHERE opened_at<=?').run(now - day);
            db.prepare('DELETE FROM profile_command_events WHERE expires_at<=?').run(now);
          })
          .immediate(),
      );
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createProfileCommandStore>>();
export function registerProfileCommands(
  storage: Storage,
  store: ReturnType<typeof createProfileCommandStore>,
) {
  stores.set(storage, store);
}
export function profileCommandStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
