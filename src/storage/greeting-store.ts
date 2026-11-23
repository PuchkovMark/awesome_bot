import { randomInt } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import { readChatControl } from './chat-control-store';
import { readDisclosureGate } from './chat-disclosure-store';
import type { Connection } from './connection';
import { greetingsAllowed, invitationsAllowed } from './greeting-entry';
import type { LifecycleBackend } from './lifecycle-store';
import { createMessageStore } from './messages';
import { participantProfileAvailable, readDeparture } from './participant-departures';
import { profileAdmitted } from './personal-data-store';
import {
  finishResponse,
  responseSlotAvailable,
  startResponse,
  type ResponseRateOutcome,
} from './response-rate-store';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';
import type { VersionBackend } from './version-store';

export type WelcomePublication = 'greeting' | 'invitation';

interface Window {
  readonly id: number;
  readonly chatId: ChatId;
  readonly generation: number;
  readonly dueAt: number;
  readonly state: 'waiting' | 'dispatching' | 'delivered' | 'skipped' | 'unknown';
  readonly invitationState: Window['state'];
}
const columns =
  'id,chat_id AS chatId,generation,due_at AS dueAt,state,invitation_state AS invitationState';
const fields = {
  greeting: { state: 'state', send: 'send_id', message: 'message_id' },
  invitation: {
    state: 'invitation_state',
    send: 'invitation_send_id',
    message: 'invitation_message_id',
  },
} as const;
const rateKey = (id: number, publication: WelcomePublication) => publication + ':' + id;

function windowRow(db: Database, scope: ConnectionScope, id: number) {
  return db
    .prepare(`SELECT ${columns} FROM greeting_windows WHERE chat_id=? AND generation=? AND id=?`)
    .get(scope.chatId, scope.generation, id) as Window | undefined;
}

export function createGreetingStore(
  connection: Connection,
  lifecycle: LifecycleBackend,
  versions: VersionBackend,
) {
  const messages = createMessageStore(connection);
  function prepare(scope: ConnectionScope, id: number, now: number) {
    return lifecycle.transaction(scope, (db) => {
      const window = windowRow(db, scope, id);
      if (window?.state !== 'waiting' || window.dueAt > now) return null;
      const controls = readChatControl(db, scope.chatId);
      const disclosure = readDisclosureGate(db, scope);
      if (
        !disclosure.journal ||
        disclosure.version === null ||
        !greetingsAllowed(controls, window.dueAt) ||
        !greetingsAllowed(controls, now)
      )
        return null;
      const candidates = db
        .prepare(
          `SELECT g.user_id AS user,g.was_returning AS wasReturning,g.confirmed_at AS confirmedAt,
        EXISTS(SELECT 1 FROM participant_profiles f WHERE f.chat_id=p.chat_id AND f.user_id=p.user_id) AS profile
        FROM greeting_members g JOIN chat_participants p ON p.chat_id=? AND p.user_id=g.user_id
        WHERE g.window_id=? AND g.greet=1 AND p.status='present' AND NOT EXISTS (
          SELECT 1 FROM personal_deletions d WHERE d.chat_id=p.chat_id AND d.generation=? AND d.user_id=p.user_id
          AND d.confirmed_at IS NOT NULL
        ) ORDER BY g.confirmed_at,g.user_id`,
        )
        .all(scope.chatId, id, scope.generation) as {
        user: UserId;
        wasReturning: number;
        confirmedAt: number;
        profile: number;
      }[];
      const members = candidates.flatMap(({ user, wasReturning, profile, confirmedAt }) => {
        const departure = readDeparture(db, scope, user);
        if (!participantProfileAvailable(departure)) return [];
        return [
          {
            user,
            confirmedAt,
            participationRevision: departure?.revision ?? 0,
            returning: wasReturning === 1 && profile === 1 && profileAdmitted(db, scope, user, now),
          },
        ];
      });
      if (!members.length) return null;
      return {
        members,
        disclosure: disclosure.version,
        revision: lifecycle.assertScope(db, scope).revision,
        template: versions.selected(scope, 'greeting_template'),
        persona: versions.selected(scope, 'persona'),
      };
    });
  }
  function prepareInvitation(scope: ConnectionScope, id: number, now: number) {
    return lifecycle.transaction(scope, (db) => {
      const window = windowRow(db, scope, id);
      if (
        window?.invitationState !== 'waiting' ||
        window.dueAt > now ||
        window.state === 'waiting' ||
        window.state === 'dispatching'
      )
        return null;
      const controls = readChatControl(db, scope.chatId);
      const disclosure = readDisclosureGate(db, scope);
      if (
        !disclosure.journal ||
        disclosure.version === null ||
        !invitationsAllowed(controls, window.dueAt) ||
        !invitationsAllowed(controls, now)
      )
        return null;
      const followsGreeting = window.state === 'delivered' && greetingsAllowed(controls, now);
      const recipients = db
        .prepare(
          `SELECT g.user_id AS user,g.confirmed_at AS confirmedAt
        FROM greeting_members g JOIN chat_participants p ON p.chat_id=? AND p.user_id=g.user_id
        WHERE g.window_id=? AND (g.invitation=1 OR (g.invitation=2 AND ?=1))
        AND p.status='present' AND NOT EXISTS (
          SELECT 1 FROM personal_deletions d WHERE d.chat_id=p.chat_id AND d.generation=? AND d.user_id=p.user_id
          AND d.confirmed_at IS NOT NULL
        ) ORDER BY g.confirmed_at,g.user_id`,
        )
        .all(scope.chatId, id, Number(followsGreeting), scope.generation) as {
        user: UserId;
        confirmedAt: number;
      }[];
      return {
        recipients: recipients.flatMap((recipient) => {
          const departure = readDeparture(db, scope, recipient.user);
          return participantProfileAvailable(departure)
            ? [{ ...recipient, participationRevision: departure?.revision ?? 0 }]
            : [];
        }),
        disclosure: disclosure.version,
      };
    });
  }

  return {
    prepare,
    prepareInvitation,
    due(now: number): (Window & { publication: WelcomePublication }) | null {
      timestamp(now);
      return connection.run((db) =>
        db
          .transaction(() => {
            db.prepare(
              `UPDATE greeting_windows SET state='skipped' WHERE state='waiting' AND due_at<=?
          AND EXISTS(SELECT 1 FROM chat_connections c WHERE c.chat_id=greeting_windows.chat_id
          AND c.generation=greeting_windows.generation AND c.state='uncertain')`,
            ).run(now);
            return (
              (db
                .prepare(
                  `SELECT ${columns},CASE WHEN state='waiting' THEN 'greeting' ELSE 'invitation' END AS publication
          FROM greeting_windows w WHERE due_at<=? AND (
            state='waiting' OR (invitation_state='waiting' AND state IN ('delivered','skipped','unknown')
              AND EXISTS(SELECT 1 FROM chat_connections c WHERE c.chat_id=w.chat_id AND c.generation=w.generation AND c.state='active'))
          ) ORDER BY due_at,id LIMIT 1`,
                )
                .get(now) as (Window & { publication: WelcomePublication }) | undefined) ?? null
            );
          })
          .immediate(),
      );
    },
    recover() {
      connection.run((db) =>
        db
          .transaction(() => {
            for (const publication of ['greeting', 'invitation'] as const) {
              const { state } = fields[publication];
              const interrupted = db
                .prepare(`SELECT ${columns} FROM greeting_windows WHERE ${state}='dispatching'`)
                .all() as Window[];
              for (const window of interrupted)
                finishResponse(db, window, rateKey(window.id, publication), 'unknown');
              db.prepare(
                `UPDATE greeting_windows SET ${state}='unknown' WHERE ${state}='dispatching'`,
              ).run();
            }
          })
          .immediate(),
      );
    },
    allocate(): number {
      return randomInt(1, 0x80000000);
    },
    start(
      scope: ConnectionScope,
      id: number,
      sendId: number,
      now: number,
      limit: number,
      current: () => boolean,
      invitationRecipients?: readonly UserId[],
    ) {
      const publication = invitationRecipients ? 'invitation' : 'greeting';
      const { state, send } = fields[publication];
      return lifecycle.transaction(scope, (db) => {
        const window = windowRow(db, scope, id);
        if (
          (publication === 'greeting' ? window?.state : window?.invitationState) !== 'waiting' ||
          (invitationRecipients &&
            (!invitationRecipients.length ||
              window?.state === 'waiting' ||
              window?.state === 'dispatching')) ||
          !current() ||
          !responseSlotAvailable(db, scope, limit, now)
        )
          return false;
        const reserved = db
          .prepare(
            `UPDATE OR IGNORE greeting_windows SET ${state}='dispatching',${send}=? WHERE id=?
            AND NOT EXISTS(SELECT 1 FROM greeting_windows WHERE send_id=? OR invitation_send_id=?)`,
          )
          .run(sendId, id, sendId, sendId);
        if (reserved.changes !== 1) return false;
        if (invitationRecipients)
          db.prepare(
            `UPDATE greeting_members SET invited=1 WHERE window_id=?
            AND user_id IN (SELECT value FROM json_each(?))`,
          ).run(id, JSON.stringify(invitationRecipients));
        startResponse(db, scope, rateKey(id, publication), now);
        return true;
      });
    },
    confirm(
      scope: ConnectionScope,
      id: number,
      sendId: number,
      part: PublishedPart,
      subjects: readonly UserId[],
      publication: WelcomePublication = 'greeting',
    ) {
      const { state, send, message } = fields[publication];
      lifecycle.transaction(scope, (db) => {
        const window = windowRow(db, scope, id);
        requireInput(
          (publication === 'greeting' ? window?.state : window?.invitationState) === 'dispatching',
        );
        const forgotten = db
          .prepare(
            `SELECT 1 FROM personal_deletions
          WHERE chat_id=? AND generation=? AND confirmed_at IS NOT NULL
          AND user_id IN (SELECT value FROM json_each(?))`,
          )
          .get(scope.chatId, scope.generation, JSON.stringify(subjects));
        let messageId: number | null = null;
        if (!forgotten) {
          const result = messages.append({
            chatId: scope.chatId,
            userId: part.userId,
            authorName: part.authorName,
            role: 'assistant',
            messageId: part.messageId,
            timestamp: part.timestamp,
            text: part.text,
          });
          requireInput(result.status === 'inserted');
          db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(result.id);
          messageId = result.id;
        }
        requireInput(
          db
            .prepare(
              `UPDATE greeting_windows SET ${state}='delivered',${message}=?
          WHERE id=? AND ${send}=? AND ${state}='dispatching'`,
            )
            .run(messageId, id, sendId).changes === 1,
        );
        finishResponse(db, scope, rateKey(id, publication), 'delivered');
      });
    },
    settle(
      scope: ConnectionScope,
      id: number,
      sendId: number,
      outcome: Exclude<ResponseRateOutcome, 'delivered'>,
      publication: WelcomePublication = 'greeting',
    ) {
      const { state, send } = fields[publication];
      lifecycle.transaction(scope, (db) => {
        const terminal = outcome === 'failed' ? 'skipped' : 'unknown';
        if (
          db
            .prepare(
              `UPDATE greeting_windows SET ${state}=?
          WHERE id=? AND chat_id=? AND generation=? AND ${state}='dispatching' AND ${send}=?`,
            )
            .run(terminal, id, scope.chatId, scope.generation, sendId).changes
        )
          finishResponse(db, scope, rateKey(id, publication), outcome);
      });
    },
    skip(scope: ConnectionScope, id: number, publication: WelcomePublication = 'greeting') {
      const { state } = fields[publication];
      lifecycle.transaction(scope, (db) =>
        db
          .prepare(
            `UPDATE greeting_windows SET ${state}='skipped'
        WHERE id=? AND chat_id=? AND generation=? AND ${state}='waiting'`,
          )
          .run(id, scope.chatId, scope.generation),
      );
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createGreetingStore>>();
export function registerGreetings(storage: Storage, store: ReturnType<typeof createGreetingStore>) {
  stores.set(storage, store);
}
export function greetingStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
