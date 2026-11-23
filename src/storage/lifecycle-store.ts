import type { Database } from 'better-sqlite3';
import type {
  ChatId,
  ConnectionScope,
  KnownBoolean,
  LifecycleObservation,
  UserId,
} from '../contracts/index';
import type { Connection } from './connection';
import { advanceClock } from './lifecycle-clock';
import { StorageError } from './errors';
import { compositeId, requireInput, timestamp } from './validation';
import { setAdminPresence } from './admin-recovery-store';

interface State {
  chatId: ChatId;
  generation: number;
  revision: number;
  state: 'active' | 'uncertain';
  creatorId: string | null;
  inviterId: string | null;
}
interface Expected {
  chatId: ChatId;
  generation: number | null;
  revision: number | null;
  clock: number;
}
export interface Verification {
  readonly expected: Expected;
}
export interface AdministrationInvite {
  readonly actorId: UserId;
  readonly messageId: number;
  readonly timestamp: number;
}
export function installAuthorities(db: Database, chatId: ChatId, grantedAt = Date.now()) {
  timestamp(grantedAt);
  for (const [basis, column] of [
    ['creator', 'creator_id'],
    ['inviter', 'inviter_id'],
  ] as const) {
    db.prepare(
      `INSERT INTO bot_admin_grants(chat_id,user_id,basis,granted_at,granted_by)
      SELECT c.chat_id,c.${column},?,?,NULL FROM chat_connections c JOIN chats s USING(chat_id)
      WHERE c.chat_id=? AND c.state='active' AND c.${basis}_applied=0 AND c.${column} IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM bot_admin_revocations r WHERE r.chat_id=c.chat_id AND r.user_id=c.${column})
      ON CONFLICT DO NOTHING`,
    ).run(basis, grantedAt, chatId);
    db.prepare(
      `UPDATE chat_connections SET ${basis}_applied=1 WHERE chat_id=? AND state='active' AND EXISTS(SELECT 1 FROM chats WHERE chat_id=?)`,
    ).run(chatId, chatId);
  }
}
export function createLifecycleBackend(connection: Connection) {
  const scopes = new WeakMap<object, number | null>();
  const checks = new WeakSet<object>();
  function read(db: Database, chatId: ChatId): State | null {
    return (
      (db
        .prepare(
          'SELECT chat_id AS chatId,generation,revision,state,creator_id AS creatorId,inviter_id AS inviterId FROM chat_connections WHERE chat_id=?',
        )
        .get(chatId) as State | undefined) ?? null
    );
  }
  function clock(db: Database) {
    return (
      db.prepare('SELECT value FROM lifecycle_clock WHERE singleton=1').get() as { value: number }
    ).value;
  }
  function matches(db: Database, expected: Expected) {
    const state = read(db, expected.chatId);
    return expected.generation === null
      ? state === null && clock(db) === expected.clock
      : state?.generation === expected.generation && state.revision === expected.revision;
  }
  function issue(state: State, pinRevision = false): ConnectionScope {
    const scope = Object.freeze({
      chatId: state.chatId,
      generation: state.generation,
    }) as ConnectionScope;
    scopes.set(scope, pinRevision ? state.revision : null);
    return scope;
  }
  function bump(db: Database, chatId: ChatId) {
    const result = db
      .prepare(
        'UPDATE chat_connections SET revision=revision+1 WHERE chat_id=? AND revision<9007199254740991',
      )
      .run(chatId);
    if (result.changes !== 1) throw new StorageError('operation_failed');
  }
  function create(db: Database, chatId: ChatId, state: State['state']) {
    const generation = advanceClock(db);
    db.prepare(
      'INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES (?,?,0,?)',
    ).run(chatId, generation, state);
  }
  function markUncertain(db: Database, chatId: ChatId, state: State | null) {
    if (!state) {
      create(db, chatId, 'uncertain');
      return;
    }
    bump(db, chatId);
    db.prepare('DELETE FROM admin_presence WHERE chat_id=?').run(chatId);
    db.prepare('UPDATE admin_observations SET community_admin=NULL WHERE chat_id=?').run(chatId);
    db.prepare(
      `UPDATE admin_recovery_operations SET state='pending_delivery',reason='interrupted'
      WHERE chat_id=? AND state='sending'`,
    ).run(chatId);
    if (state.state === 'active') {
      db.prepare("UPDATE chat_connections SET state='uncertain' WHERE chat_id=?").run(chatId);
    }
  }
  function assertScope(db: Database, scope: ConnectionScope) {
    requireInput(typeof scope === 'object' && scope !== null && scopes.has(scope));
    const state = read(db, scope.chatId);
    if (!state || state.generation !== scope.generation) throw new StorageError('stale_scope');
    if (state.state !== 'active') throw new StorageError('uncertain_connection');
    const revision = scopes.get(scope);
    if (revision !== null && revision !== state.revision) throw new StorageError('stale_scope');
    return state;
  }
  function remove(db: Database, chatId: ChatId): void {
    const lease = db
      .prepare(
        'SELECT token,expires_at AS expires,safety_ms AS safety FROM queue_lease WHERE singleton=1',
      )
      .get() as { token: string | null; expires: number; safety: number };
    const guarded = lease.token !== null && lease.expires > Date.now();
    if (guarded && lease.expires - Date.now() <= lease.safety)
      throw new StorageError('queue_lost_ownership');
    for (const table of [
      'response_traces',
      'notice_periods',
      'queue_jobs',
      'queue_turns',
      'chat_content_selections',
      'local_content_versions',
      'profile_facts',
      'participant_profiles',
      'chat_participants',
      'bot_admin_revocation_audit',
      'bot_admin_revocations',
      'bot_admin_grants',
      'bot_admin_controls',
      'messages',
      'chats',
      'chat_connections',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE chat_id=?`).run(chatId);
    }
    if (guarded && lease.expires <= Date.now()) throw new StorageError('queue_lost_ownership');
    advanceClock(db);
  }
  return {
    assertScope,
    pauseActivePlatform(db: Database, platform: string) {
      requireInput(db.inTransaction && /^[a-z][a-z0-9_-]*$/u.test(platform));
      const prefix = platform + ':';
      const where = "state='active' AND substr(chat_id,1,?)=?";
      if (
        db
          .prepare(
            `SELECT 1 FROM chat_connections WHERE ${where} AND revision=9007199254740991 LIMIT 1`,
          )
          .get(prefix.length, prefix)
      )
        throw new StorageError('operation_failed');
      db.prepare(
        `DELETE FROM admin_presence WHERE chat_id IN (SELECT chat_id FROM chat_connections WHERE ${where})`,
      ).run(prefix.length, prefix);
      db.prepare(
        `UPDATE admin_observations SET community_admin=NULL
        WHERE chat_id IN (SELECT chat_id FROM chat_connections WHERE ${where})`,
      ).run(prefix.length, prefix);
      db.prepare(
        `UPDATE chat_connections SET state='uncertain',revision=revision+1 WHERE ${where}`,
      ).run(prefix.length, prefix);
    },
    activeChatIds(platform: string): readonly ChatId[] {
      return connection.run((db) => {
        const prefix = `${platform}:`;
        const rows = db
          .prepare(
            "SELECT chat_id AS chatId FROM chat_connections WHERE state='active' AND substr(chat_id,1,?)=?",
          )
          .all(prefix.length, prefix) as { chatId: ChatId }[];
        return rows.map((row) => row.chatId);
      });
    },
    restore(expected: { readonly chatId: ChatId; readonly generation: number }): ConnectionScope {
      return connection.run((db) => {
        compositeId(expected.chatId);
        const state = read(db, expected.chatId);
        if (!state || state.generation !== expected.generation)
          throw new StorageError('stale_scope');
        if (state.state !== 'active') throw new StorageError('uncertain_connection');
        return issue(state);
      });
    },
    transaction<T>(scope: ConnectionScope, fn: (db: Database) => T): T {
      return connection.run((db) =>
        db
          .transaction(() => {
            assertScope(db, scope);
            const result = fn(db);
            assertScope(db, scope);
            return result;
          })
          .immediate(),
      );
    },
    begin(chatId: ChatId): Verification {
      return connection.run((db) => {
        compositeId(chatId);
        const state = read(db, chatId);
        const proof = Object.freeze({
          expected: Object.freeze({
            chatId,
            generation: state?.generation ?? null,
            revision: state?.revision ?? null,
            clock: clock(db),
          }),
        });
        checks.add(proof);
        return proof;
      });
    },
    current(chatId: ChatId, pinRevision = false): ConnectionScope {
      return connection.run((db) => {
        compositeId(chatId);
        const state = read(db, chatId);
        if (!state) throw new StorageError('stale_scope');
        if (state.state !== 'active') throw new StorageError('uncertain_connection');
        return issue(state, pinRevision);
      });
    },
    applyConnectionSignal(
      proof: Verification,
      key: string | undefined,
      invite?: AdministrationInvite,
    ) {
      return connection.run((db) => {
        requireInput(!db.inTransaction);
        return db
          .transaction(() => {
            requireInput(checks.has(proof));
            checks.delete(proof);
            if (!matches(db, proof.expected)) return { status: 'stale' as const };
            const { chatId } = proof.expected;
            const state = read(db, chatId);
            if (
              state &&
              key !== undefined &&
              db
                .prepare(
                  'SELECT 1 FROM connection_membership_signals WHERE chat_id=? AND generation=? AND signal_key=?',
                )
                .get(chatId, state.generation, key)
            )
              return { status: 'duplicate' as const };

            if (!state || state.state === 'active' || key !== undefined)
              markUncertain(db, chatId, state);
            if (key !== undefined) {
              const connection = read(db, chatId)!;
              db.prepare(
                'INSERT INTO connection_membership_signals(chat_id,generation,signal_key) VALUES (?,?,?)',
              ).run(chatId, connection.generation, key);
              if (invite && key === String(invite.messageId)) {
                db.prepare(
                  `INSERT INTO admin_observations(chat_id,generation,invite_id,invite_actor,invite_at,invite_revision)
                VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id,generation) DO UPDATE SET invite_id=excluded.invite_id,
                invite_actor=excluded.invite_actor,invite_at=excluded.invite_at,invite_revision=excluded.invite_revision,invite_selected=0
                WHERE (invite_id IS NULL OR invite_id<excluded.invite_id)
                  AND (opened_at IS NULL OR excluded.invite_at >= ((opened_at+999)/1000)*1000)`,
                ).run(
                  chatId,
                  connection.generation,
                  invite.messageId,
                  invite.actorId,
                  invite.timestamp,
                  connection.revision,
                );
              }
            }
            return { status: 'paused' as const };
          })
          .immediate();
      });
    },
    administrationInputs(scope: ConnectionScope) {
      return this.transaction(scope, (db) => {
        const invite = db
          .prepare(
            `SELECT invite_id AS messageId,invite_actor AS actorId,invite_at AS timestamp
          FROM admin_observations JOIN chat_connections USING(chat_id,generation)
          WHERE chat_id=? AND generation=? AND invite_selected=1 AND inviter_id IS NULL`,
          )
          .get(scope.chatId, scope.generation) as AdministrationInvite | undefined;
        const admins = db
          .prepare(
            'SELECT DISTINCT user_id AS userId FROM bot_admin_grants WHERE chat_id=? ORDER BY user_id',
          )
          .all(scope.chatId) as { userId: UserId }[];
        return { invite, admins: admins.map((row) => row.userId) };
      });
    },
    observeAdminMembership(
      scope: ConnectionScope,
      userId: UserId,
      present: boolean,
      messageId: number,
      at: number,
    ) {
      compositeId(userId);
      timestamp(at);
      requireInput(
        userId.split(':')[0] === scope.chatId.split(':')[0] &&
          Number.isSafeInteger(messageId) &&
          messageId > 0,
      );
      return connection.run((db) =>
        db
          .transaction(() => {
            const state = assertScope(db, scope);
            const previous = db
              .prepare(
                `SELECT last_membership_id AS last,opened_at AS opened
          FROM admin_observations WHERE chat_id=? AND generation=?`,
              )
              .get(scope.chatId, scope.generation) as
              { last: number; opened: number | null } | undefined;
            if (
              previous &&
              (messageId <= previous.last ||
                (previous.opened !== null && at < Math.ceil(previous.opened / 1000) * 1000))
            )
              return false;
            const member = db
              .prepare(
                'SELECT event_id AS id FROM admin_presence WHERE chat_id=? AND generation=? AND user_id=?',
              )
              .get(scope.chatId, scope.generation, userId) as { id: number | null } | undefined;
            if (member?.id != null && member.id >= messageId) return false;
            if (
              db
                .prepare('SELECT 1 FROM bot_admin_grants WHERE chat_id=? AND user_id=?')
                .get(scope.chatId, userId)
            ) {
              setAdminPresence(db, scope, userId, present, messageId);
              if (!present)
                db.prepare(
                  "DELETE FROM bot_admin_grants WHERE chat_id=? AND user_id=? AND basis='explicit'",
                ).run(scope.chatId, userId);
            }
            bump(db, state.chatId);
            return true;
          })
          .immediate(),
      );
    },
    applyAdministration(
      proof: Verification,
      observation: LifecycleObservation,
      communityAdmin: KnownBoolean,
    ) {
      return connection.run((db) =>
        db
          .transaction(() => {
            requireInput(checks.has(proof));
            checks.delete(proof);
            if (!matches(db, proof.expected)) return false;
            const state = read(db, proof.expected.chatId);
            if (state?.state !== 'active') return false;
            const { chatId, generation } = state;
            if (observation.confidence === 'uncertain') {
              markUncertain(db, chatId, state);
              return true;
            }
            db.prepare(
              `INSERT INTO admin_observations(chat_id,generation,community_admin) VALUES (?,?,?)
          ON CONFLICT(chat_id,generation) DO UPDATE SET community_admin=excluded.community_admin`,
            ).run(
              chatId,
              generation,
              typeof communityAdmin === 'boolean' ? Number(communityAdmin) : null,
            );
            if (observation.confidence !== 'confirmed' || observation.bot !== 'present')
              return false;
            let changed = false;
            const recoveryBlocked =
              !!db.prepare('SELECT 1 FROM bot_admin_controls WHERE chat_id=?').get(chatId) &&
              !db
                .prepare(
                  `SELECT 1 FROM admin_presence p JOIN bot_admin_grants g USING(chat_id,user_id)
            WHERE p.chat_id=? AND p.generation=? AND p.present=1`,
                )
                .get(chatId, generation);
            if (observation.creatorId && observation.creatorId !== state.creatorId) {
              db.prepare("DELETE FROM bot_admin_grants WHERE chat_id=? AND basis='creator'").run(
                chatId,
              );
              db.prepare(
                'UPDATE chat_connections SET creator_id=?,creator_applied=? WHERE chat_id=?',
              ).run(observation.creatorId, Number(recoveryBlocked), chatId);
              changed = true;
            }
            if (observation.inviterId && state.inviterId === null) {
              db.prepare(
                'UPDATE chat_connections SET inviter_id=?,inviter_applied=? WHERE chat_id=?',
              ).run(observation.inviterId, Number(recoveryBlocked), chatId);
              changed = true;
            }
            if (changed) installAuthorities(db, chatId);
            for (const userId of observation.members?.ids ?? []) {
              if (
                db
                  .prepare('SELECT 1 FROM bot_admin_grants WHERE chat_id=? AND user_id=?')
                  .get(chatId, userId) &&
                !db
                  .prepare(
                    'SELECT 1 FROM admin_presence WHERE chat_id=? AND generation=? AND user_id=?',
                  )
                  .get(chatId, generation, userId)
              ) {
                changed = setAdminPresence(db, state, userId, true) || changed;
              }
            }
            if (changed) bump(db, chatId);
            return changed;
          })
          .immediate(),
      );
    },
    apply(proof: Verification, observation: LifecycleObservation) {
      return connection.run((db) => {
        requireInput(!db.inTransaction);
        return db
          .transaction(() => {
            requireInput(checks.has(proof));
            checks.delete(proof);
            if (!matches(db, proof.expected)) return { status: 'stale' as const };
            const { chatId } = proof.expected;
            requireInput(
              ['confirmed', 'uncertain', 'unavailable'].includes(observation.confidence),
            );
            requireInput(['present', 'absent', 'unknown'].includes(observation.bot));
            for (const userId of [
              observation.creatorId,
              observation.inviterId,
              ...(observation.members?.ids ?? []),
              ...(observation.departedIds ?? []),
            ]) {
              if (userId == null) continue;
              compositeId(userId);
              requireInput(userId.split(':')[0] === chatId.split(':')[0]);
            }
            if (observation.creatorChanged !== undefined)
              requireInput(typeof observation.creatorChanged === 'boolean');
            if (observation.members)
              requireInput(
                typeof observation.members.complete === 'boolean' &&
                  Array.isArray(observation.members.ids),
              );
            let state = read(db, chatId);
            if (observation.confidence !== 'confirmed' || observation.bot === 'unknown') {
              markUncertain(db, chatId, state);
              return { status: 'uncertain' as const };
            }
            if (state?.state === 'uncertain') return { status: 'uncertain' as const };
            if (observation.bot === 'absent') {
              if (state) remove(db, chatId);
              return { status: 'applied' as const };
            }
            if (!state) create(db, chatId, 'active');
            else bump(db, chatId);
            state = read(db, chatId)!;
            for (const userId of observation.departedIds ?? [])
              db.prepare(
                "DELETE FROM bot_admin_grants WHERE chat_id=? AND user_id=? AND basis='explicit'",
              ).run(chatId, userId);
            if (observation.members?.complete) {
              const present = new Set(observation.members.ids);
              const explicit = db
                .prepare(
                  "SELECT user_id AS userId FROM bot_admin_grants WHERE chat_id=? AND basis='explicit'",
                )
                .all(chatId) as { userId: import('../contracts/index').UserId }[];
              for (const member of explicit)
                if (!present.has(member.userId))
                  db.prepare(
                    "DELETE FROM bot_admin_grants WHERE chat_id=? AND user_id=? AND basis='explicit'",
                  ).run(chatId, member.userId);
            }
            if (observation.creatorId != null || observation.creatorChanged) {
              const next = observation.creatorId ?? null;
              db.prepare(
                "DELETE FROM bot_admin_grants WHERE chat_id=? AND basis='creator' AND (? IS NULL OR user_id<>?)",
              ).run(chatId, next, next);
              if (state.creatorId !== next)
                db.prepare(
                  'UPDATE chat_connections SET creator_id=?,creator_applied=0 WHERE chat_id=?',
                ).run(next, chatId);
            }
            if (state.inviterId === null && observation.inviterId != null)
              db.prepare(
                'UPDATE chat_connections SET inviter_id=?,inviter_applied=0 WHERE chat_id=?',
              ).run(observation.inviterId, chatId);
            installAuthorities(db, chatId);
            return { status: 'applied' as const, scope: issue(state) };
          })
          .immediate();
      });
    },
    ownerDecision(proof: Verification, decision: 'continue' | 'new'): ConnectionScope {
      return connection.run((db) => {
        requireInput(!db.inTransaction);
        return db
          .transaction(() => {
            requireInput(checks.has(proof));
            checks.delete(proof);
            if (!matches(db, proof.expected)) throw new StorageError('stale_scope');
            const { chatId } = proof.expected;
            const state = read(db, chatId);
            if (decision === 'new') {
              const invite =
                state &&
                (db
                  .prepare(
                    `SELECT invite_id AS messageId,invite_actor AS actorId,invite_at AS timestamp
            FROM admin_observations WHERE chat_id=? AND generation=? AND invite_revision=? AND invite_selected=0`,
                  )
                  .get(chatId, state.generation, state.revision) as
                  AdministrationInvite | null | undefined);
              if (state) remove(db, chatId);
              create(db, chatId, 'active');
              db.prepare(
                `INSERT INTO admin_observations(chat_id,generation,opened_at,last_membership_id,invite_id,invite_actor,invite_at,invite_selected)
            VALUES (?,?,?,?,?,?,?,?)`,
              ).run(
                chatId,
                read(db, chatId)!.generation,
                Date.now(),
                invite?.messageId ?? 0,
                invite?.messageId ?? null,
                invite?.actorId ?? null,
                invite?.timestamp ?? null,
                Number(Boolean(invite)),
              );
            } else {
              requireInput(decision === 'continue' && state !== null);
              const initial =
                state.revision === 0 &&
                !db.prepare('SELECT 1 FROM chats WHERE chat_id=?').get(chatId);
              bump(db, chatId);
              db.prepare("UPDATE chat_connections SET state='active' WHERE chat_id=?").run(chatId);
              db.prepare(
                `INSERT INTO admin_observations(chat_id,generation,opened_at) VALUES (?,?,?)
            ON CONFLICT(chat_id,generation) DO UPDATE SET opened_at=excluded.opened_at`,
              ).run(chatId, state.generation, Date.now());
              if (initial)
                db.prepare(
                  `UPDATE admin_observations SET invite_selected=1,last_membership_id=invite_id
            WHERE chat_id=? AND invite_id IS NOT NULL AND invite_revision=?`,
                ).run(chatId, state.revision);
              db.prepare(
                `UPDATE admin_observations SET invite_revision=NULL WHERE chat_id=? AND invite_selected=0`,
              ).run(chatId);
            }
            return issue(read(db, chatId)!);
          })
          .immediate();
      });
    },
    ownerDelete(proof: Verification, generation: number) {
      return connection.run((db) =>
        db
          .transaction(() => {
            requireInput(checks.has(proof));
            checks.delete(proof);
            if (proof.expected.generation !== generation || !matches(db, proof.expected))
              throw new StorageError('stale_scope');
            remove(db, proof.expected.chatId);
          })
          .immediate(),
      );
    },
    revision(scope: ConnectionScope): number {
      return this.transaction(scope, (db) => read(db, scope.chatId)!.revision);
    },
    bump,
  };
}
export type LifecycleBackend = ReturnType<typeof createLifecycleBackend>;
const backends = new WeakMap<object, LifecycleBackend>();
export function registerLifecycle(storage: object, backend: LifecycleBackend) {
  backends.set(storage, backend);
}
export function lifecycleBackend(storage: object): LifecycleBackend {
  const backend = backends.get(storage);
  if (!backend) throw new StorageError('invalid_input');
  return backend;
}
