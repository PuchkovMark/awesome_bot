import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/lifecycle';
import { defaultPersonaId } from '../core/personas/catalog';
import type {
  ContentKind,
  LocalContentKind,
  ContentVersion,
  VersionInput,
  VersionRef,
  GlobalVersionRef,
  VersionLimits,
  AppendVersionResult,
  SelectionResult,
  PersonaSnapshot,
} from '../contracts/versioning';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import { object, requireInput, string, timestamp } from './validation';
import { versionText } from './version-limits';
import { StorageError } from './errors';
const kinds = ['system_prompt', 'persona', 'greeting_template'];
function snapshot(value: unknown, keys: readonly string[]) {
  object(value, keys);
  return { ...value };
}
function kind(value: unknown, local = false): asserts value is ContentKind {
  requireInput(kinds.includes(value as string) && (!local || value !== 'system_prompt'));
}
function positive(value: unknown): asserts value is number {
  requireInput(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}
function reference(input: unknown, scope?: ConnectionScope): VersionRef {
  const r = snapshot(input, ['area', 'kind', 'key', 'version', 'chatId', 'generation']);
  kind(r.kind);
  string(r.key, true);
  positive(r.version);
  if (r.area === 'global') {
    requireInput(!Object.hasOwn(r, 'chatId') && !Object.hasOwn(r, 'generation'));
    return Object.freeze({ area: 'global', kind: r.kind, key: r.key, version: r.version });
  }
  requireInput(r.area === 'local' && scope !== undefined);
  kind(r.kind, true);
  positive(r.generation);
  requireInput(r.chatId === scope.chatId && r.generation === scope.generation);
  return Object.freeze({
    area: 'local',
    kind: r.kind as LocalContentKind,
    key: r.key,
    version: r.version,
    chatId: scope.chatId,
    generation: scope.generation,
  });
}
function same(a: VersionRef | null, b: VersionRef | null): boolean {
  return a === null || b === null
    ? a === b
    : a.area === b.area &&
        a.kind === b.kind &&
        a.key === b.key &&
        a.version === b.version &&
        (a.area !== 'local' ||
          (b.area === 'local' && a.chatId === b.chatId && a.generation === b.generation));
}
function value(
  ref: VersionRef,
  row: { text: string; createdAt: number } | undefined,
): ContentVersion | null {
  if (!row) return null;
  requireInput(typeof row.text === 'string');
  return Object.freeze({ ref, text: row.text, createdAt: row.createdAt });
}
export function createVersionBackend(
  connection: Connection,
  lifecycle: LifecycleBackend,
  limits: VersionLimits,
) {
  function admin<T>(fn: (db: Database) => T): T {
    return connection.run((db) => {
      requireInput(!db.inTransaction);
      return db.transaction(() => fn(db)).immediate();
    });
  }
  function get(db: Database, ref: VersionRef): ContentVersion | null {
    const args =
      ref.area === 'local'
        ? [ref.chatId, ref.generation, ref.kind, ref.key, ref.version]
        : [ref.kind, ref.key, ref.version];
    return value(
      ref,
      db
        .prepare(
          `SELECT text,created_at AS createdAt FROM ${ref.area === 'local' ? 'local' : 'global'}_content_versions WHERE ${ref.area === 'local' ? 'chat_id=? AND generation=? AND ' : ''}kind=? AND entity_key=? AND version=?`,
        )
        .get(...args) as { text: string; createdAt: number } | undefined,
    );
  }
  function append(db: Database, input: VersionInput, scope?: ConnectionScope): AppendVersionResult {
    const row = snapshot(input, ['kind', 'key', 'text', 'createdAt', 'expectedHead']);
    kind(row.kind, scope !== undefined);
    string(row.key, true);
    timestamp(row.createdAt);
    versionText(row.text, limits);
    if (row.expectedHead !== null) positive(row.expectedHead);
    const table = scope ? 'local_content_versions' : 'global_content_versions',
      where = `${scope ? 'chat_id=? AND generation=? AND ' : ''}kind=? AND entity_key=?`,
      params = scope ? [scope.chatId, scope.generation, row.kind, row.key] : [row.kind, row.key];
    const head = db
      .prepare(`SELECT max(version) AS head,count(*) AS count FROM ${table} WHERE ${where}`)
      .get(...params) as { head: number | null; count: number };
    if (head.head !== row.expectedHead) return { status: 'conflict' };
    if (head.count >= limits.maxPerEntity) throw new StorageError('limit_exceeded');
    const version = (head.head ?? 0) + 1;
    if (!Number.isSafeInteger(version)) throw new StorageError('operation_failed');
    db.prepare(
      `INSERT INTO ${table} (${scope ? 'chat_id,generation,' : ''}kind,entity_key,version,text,created_at) VALUES (${scope ? '?,?,' : ''}?,?,?,?,?)`,
    ).run(...params, version, row.text, row.createdAt);
    const ref: VersionRef = scope
      ? Object.freeze({
          area: 'local',
          kind: row.kind as LocalContentKind,
          key: row.key,
          version,
          chatId: scope.chatId,
          generation: scope.generation,
        })
      : Object.freeze({ area: 'global', kind: row.kind, key: row.key, version });
    return { status: 'created', value: value(ref, { text: row.text, createdAt: row.createdAt })! };
  }
  function globalSelected(db: Database): ContentVersion | null {
    const row = db
      .prepare(
        'SELECT v.entity_key AS key,v.version,v.text,v.created_at AS createdAt FROM global_prompt_selection s JOIN global_content_versions v USING(kind,entity_key,version)',
      )
      .get() as { key: string; version: number; text: string; createdAt: number } | undefined;
    return row
      ? value(
          Object.freeze({
            area: 'global',
            kind: 'system_prompt',
            key: row.key,
            version: row.version,
          }),
          row,
        )
      : null;
  }
  function localSelected(
    db: Database,
    scope: ConnectionScope,
    k: LocalContentKind,
  ): ContentVersion | null {
    kind(k, true);
    const row = db
      .prepare(
        `SELECT s.global_key AS globalKey,s.global_version AS globalVersion,s.local_key AS localKey,s.local_version AS localVersion,coalesce(g.text,l.text) AS text,coalesce(g.created_at,l.created_at) AS createdAt
   FROM chat_content_selections s
   LEFT JOIN global_content_versions g ON g.kind=s.kind AND g.entity_key=s.global_key AND g.version=s.global_version
   LEFT JOIN local_content_versions l ON l.chat_id=s.chat_id AND l.generation=s.generation AND l.kind=s.kind AND l.entity_key=s.local_key AND l.version=s.local_version
   WHERE s.chat_id=? AND s.generation=? AND s.kind=?`,
      )
      .get(scope.chatId, scope.generation, k) as
      | {
          globalKey: string | null;
          globalVersion: number | null;
          localKey: string | null;
          localVersion: number | null;
          text: string;
          createdAt: number;
        }
      | undefined;
    if (!row) return null;
    const ref = reference(
      row.globalKey !== null
        ? { area: 'global', kind: k, key: row.globalKey, version: row.globalVersion }
        : {
            area: 'local',
            kind: k,
            key: row.localKey,
            version: row.localVersion,
            chatId: scope.chatId,
            generation: scope.generation,
          },
      scope,
    );
    return value(ref, row);
  }
  function starterPersonaRef(db: Database, id: string): GlobalVersionRef | null {
    const row = db
      .prepare('SELECT entity_key AS key,version FROM starter_persona_versions WHERE persona_id=?')
      .get(id) as { key: string; version: number } | undefined;
    return row ? Object.freeze({ area: 'global', kind: 'persona', ...row }) : null;
  }
  function persona(db: Database, scope: ConnectionScope): PersonaSnapshot | null {
    const selected = localSelected(db, scope, 'persona');
    if (selected) {
      const { ref, text } = selected;
      const starterId =
        ref.area === 'global'
          ? (db
              .prepare(
                'SELECT persona_id FROM starter_persona_versions WHERE entity_key=? AND version=?',
              )
              .pluck()
              .get(ref.key, ref.version) as string | undefined)
          : undefined;
      return Object.freeze({ ref, text, starterId: starterId ?? null });
    }
    const ref = starterPersonaRef(db, defaultPersonaId);
    const fallback = ref && get(db, ref);
    return (
      fallback &&
      Object.freeze({ ref: fallback.ref, text: fallback.text, starterId: defaultPersonaId })
    );
  }
  function select(
    db: Database,
    input: VersionRef | null,
    expectedInput: VersionRef | null,
    scope?: ConnectionScope,
    k: ContentKind = 'system_prompt',
  ): SelectionResult {
    kind(k, scope !== undefined);
    const ref = input === null ? null : reference(input, scope),
      expected = expectedInput === null ? null : reference(expectedInput, scope);
    requireInput((!ref || ref.kind === k) && (!expected || expected.kind === k));
    const current = scope ? localSelected(db, scope, k as LocalContentKind) : globalSelected(db);
    if (!same(current?.ref ?? null, expected)) return { status: 'conflict' };
    if (ref && !get(db, ref)) return { status: 'not_found' };
    if (scope) {
      if (ref)
        db.prepare(
          `INSERT INTO chat_content_selections VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id,generation,kind) DO UPDATE SET global_key=excluded.global_key,global_version=excluded.global_version,local_key=excluded.local_key,local_version=excluded.local_version`,
        ).run(
          scope.chatId,
          scope.generation,
          k,
          ref.area === 'global' ? ref.key : null,
          ref.area === 'global' ? ref.version : null,
          ref.area === 'local' ? ref.key : null,
          ref.area === 'local' ? ref.version : null,
        );
      else
        db.prepare(
          'DELETE FROM chat_content_selections WHERE chat_id=? AND generation=? AND kind=?',
        ).run(scope.chatId, scope.generation, k);
    } else {
      if (ref)
        db.prepare(
          'INSERT INTO global_prompt_selection VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET entity_key=excluded.entity_key,version=excluded.version',
        ).run(k, ref.key, ref.version);
      else db.prepare('DELETE FROM global_prompt_selection').run();
    }
    return { status: 'selected' };
  }
  return {
    persona,
    installStarterPersonas(cards: readonly { id: string; text: string }[], createdAt: number) {
      admin((db) => {
        timestamp(createdAt);
        const linked = db.prepare('SELECT 1 FROM starter_persona_versions WHERE persona_id=?');
        const occupied = db.prepare(
          "SELECT 1 FROM global_content_versions WHERE kind='persona' AND entity_key=? LIMIT 1",
        );
        const link = db.prepare(
          'INSERT INTO starter_persona_versions(persona_id,entity_key,version) VALUES (?,?,?)',
        );
        for (const { id, text } of cards) {
          string(id, true);
          if (linked.get(id)) continue;
          let key = id;
          for (let suffix = 1; occupied.get(key); suffix++)
            key = suffix === 1 ? 'starter-' + id : 'starter-' + id + '-' + suffix;
          const result = append(db, {
            kind: 'persona',
            key,
            text,
            createdAt,
            expectedHead: null,
          });
          if (result.status !== 'created') throw new StorageError('operation_failed');
          link.run(id, key, result.value.ref.version);
        }
      });
    },
    appendGlobal: (input: VersionInput) => admin((db) => append(db, input)),
    getGlobal: (ref: GlobalVersionRef) => admin((db) => get(db, reference(ref))),
    globalSelected: () => admin(globalSelected),
    selectGlobal: (ref: GlobalVersionRef | null, expected: GlobalVersionRef | null) =>
      admin((db) => select(db, ref, expected)),
    appendLocal: (scope: ConnectionScope, input: VersionInput<LocalContentKind>) =>
      lifecycle.transaction(scope, (db) => append(db, input, scope)),
    get: (scope: ConnectionScope, ref: VersionRef) =>
      lifecycle.transaction(scope, (db) => get(db, reference(ref, scope))),
    systemPrompt: (scope: ConnectionScope) => lifecycle.transaction(scope, globalSelected),
    selected: (scope: ConnectionScope, k: LocalContentKind) =>
      lifecycle.transaction(scope, (db) => localSelected(db, scope, k)),
    select: (
      scope: ConnectionScope,
      k: LocalContentKind,
      ref: VersionRef | null,
      expected: VersionRef | null,
    ) => lifecycle.transaction(scope, (db) => select(db, ref, expected, scope, k)),
  };
}
export type VersionBackend = ReturnType<typeof createVersionBackend>;
