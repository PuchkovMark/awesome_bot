import { randomInt } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';
import { object, requireInput, timestamp } from './validation';

export interface DisclosureInput {
  readonly provider: string;
  readonly dataPolicy: string;
  readonly storagePolicy: string;
  readonly detailsText: string;
  readonly detailsUrl: string;
  readonly ownerContact: string;
  readonly change: 'material' | 'editorial';
}

export type DisclosureVersion = Omit<DisclosureInput, 'change'> & {
  readonly version: number;
  readonly requiredVersion: number;
};

export type DisclosureKind = 'introduction' | 'owner' | 'update';
export type DisclosureReason = 'rights' | 'owner_closed' | 'unavailable' | 'stale_version' | 'unconfirmed';

export interface DisclosurePublication {
  readonly id: number;
  readonly version: number;
  readonly kind: DisclosureKind;
  readonly state: 'pending' | 'sending' | 'unknown' | 'delivered' | 'cancelled';
  readonly reason: DisclosureReason | null;
  readonly text: string | null;
  readonly sendId: number | null;
  readonly attempt: number;
  readonly replayed: number;
  readonly attemptedAt: number | null;
  readonly receipt: string | null;
}

export interface DisclosureGate {
  readonly journal: boolean;
  readonly version: number | null;
  readonly provider: string | null;
}

const versionColumns = 'version, required_version AS requiredVersion, provider, data_policy AS dataPolicy, storage_policy AS storagePolicy, details_text AS detailsText, details_url AS detailsUrl, owner_contact AS ownerContact';
const publicationColumns = 'id, version, kind, state, reason, text, send_id AS sendId, attempt, replayed, attempted_at AS attemptedAt, receipt';

function latest(db: Database) {
  return db.prepare(`SELECT ${versionColumns} FROM disclosure_versions ORDER BY version DESC LIMIT 1`).get() as DisclosureVersion | undefined;
}

function version(db: Database, id: number) {
  return db.prepare(`SELECT ${versionColumns} FROM disclosure_versions WHERE version=?`).get(id) as DisclosureVersion | undefined;
}

function deliveredVersion(db: Database, scope: ConnectionScope) {
  const row = db.prepare(`SELECT version FROM disclosure_publications WHERE chat_id=? AND generation=?
    AND kind IN ('introduction','update') AND state='delivered' ORDER BY version DESC LIMIT 1`)
    .get(scope.chatId, scope.generation) as {version: number} | undefined;
  return row ? version(db, row.version) : undefined;
}

export function readDisclosureGate(db: Database, scope: ConnectionScope): DisclosureGate {
  const current = latest(db);
  const delivered = deliveredVersion(db, scope);
  if (!current || !delivered) return { journal: false, version: null, provider: null };
  const compatible = current.requiredVersion === delivered.requiredVersion;
  return {
    journal: current.storagePolicy === delivered.storagePolicy,
    version: compatible ? delivered.version : null,
    provider: compatible ? delivered.provider : null,
  };
}

function validateDisclosure(input: DisclosureInput) {
  object(input, ['provider','dataPolicy','storagePolicy','detailsText','detailsUrl','ownerContact','change']);
  requireInput(input.change === 'material' || input.change === 'editorial');
  for (const value of [input.provider,input.dataPolicy,input.storagePolicy,input.detailsUrl,input.ownerContact]) {
    requireInput(typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 2048 &&
      !/[\r\n]/u.test(value) && !value.includes('\0'));
  }
  requireInput(typeof input.detailsText === 'string' && input.detailsText.trim().length > 0 &&
    !input.detailsText.includes('\0') && Buffer.byteLength(input.detailsText,'utf8') <= 32_000);
  requireInput(Buffer.byteLength(input.detailsUrl,'utf8') <= 2048 && Buffer.byteLength(input.ownerContact,'utf8') <= 512 &&
    Buffer.byteLength(input.provider,'utf8') <= 128);
  let url: URL;
  try { url = new URL(input.detailsUrl); } catch { requireInput(false); }
  requireInput(url.protocol === 'https:' && !url.username && !url.password);
}

export function createDisclosureStore(connection: Connection, lifecycle: LifecycleBackend) {
  function readPublication(db: Database, scope: ConnectionScope, id: number) {
    return db.prepare(`SELECT ${publicationColumns} FROM disclosure_publications WHERE chat_id=? AND generation=? AND id=?`)
      .get(scope.chatId, scope.generation, id) as DisclosurePublication | undefined;
  }

  return {
    register(input: DisclosureInput, now: number) {
      validateDisclosure(input);
      timestamp(now);
      return connection.run(db => db.transaction(() => {
        const previous = latest(db);
        const fields = ['provider','dataPolicy','storagePolicy','detailsText','detailsUrl','ownerContact'] as const;
        const material = input.change === 'material';
        if (previous && (previous.version === previous.requiredVersion) === material &&
          fields.every(field => input[field] === previous[field])) return previous.version;
        if (input.change === 'editorial') {
          requireInput(previous && previous.provider === input.provider && previous.dataPolicy === input.dataPolicy && previous.storagePolicy === input.storagePolicy);
        }
        const id = (previous?.version ?? 0) + 1;
        requireInput(Number.isSafeInteger(id));
        db.prepare(`INSERT INTO disclosure_versions VALUES (?,?,?,?,?,?,?,?,?)`).run(id,
          input.change === 'editorial' ? previous!.requiredVersion : id,
          input.provider,input.dataPolicy,input.storagePolicy,input.detailsText,input.detailsUrl,input.ownerContact,now);
        return id;
      }).immediate());
    },
    latest() { return connection.run(latest); },
    version(id: number) { return connection.run(db => version(db, id)); },
    gate(scope: ConnectionScope) { return lifecycle.transaction(scope, db => readDisclosureGate(db, scope)); },
    publications(scope: ConnectionScope) {
      return lifecycle.transaction(scope, db => db.prepare(`SELECT ${publicationColumns} FROM disclosure_publications
        WHERE chat_id=? AND generation=? ORDER BY id`).all(scope.chatId,scope.generation) as DisclosurePublication[]);
    },
    ensure(scope: ConnectionScope, kind: DisclosureKind, id: number) {
      return lifecycle.transaction(scope, db => {
        const selected = version(db,id);
        requireInput(selected);
        const slot = kind === 'update' ? selected.requiredVersion : 0;
        db.prepare(`INSERT INTO disclosure_publications(chat_id,generation,version,kind,slot,state)
          VALUES (?,?,?,?,?,'pending') ON CONFLICT(generation,kind,slot) DO NOTHING`)
          .run(scope.chatId,scope.generation,id,kind,slot);
        if (kind === 'introduction') db.prepare(`UPDATE disclosure_publications SET version=?
          WHERE chat_id=? AND generation=? AND kind='introduction' AND state='pending' AND send_id IS NULL`)
          .run(id,scope.chatId,scope.generation);
        return db.prepare(`SELECT ${publicationColumns} FROM disclosure_publications
          WHERE chat_id=? AND generation=? AND kind=? AND slot=?`).get(scope.chatId,scope.generation,kind,slot) as DisclosurePublication;
      });
    },
    wait(scope: ConnectionScope, id: number, reason: DisclosureReason) {
      lifecycle.transaction(scope, db => db.prepare(`UPDATE disclosure_publications SET reason=?
        WHERE chat_id=? AND generation=? AND id=? AND state='pending'`).run(reason,scope.chatId,scope.generation,id));
    },
    cancel(scope: ConnectionScope, id: number, reason: DisclosureReason) {
      lifecycle.transaction(scope, db => db.prepare(`UPDATE disclosure_publications SET state='cancelled',reason=?
        WHERE chat_id=? AND generation=? AND id=? AND state='pending'`).run(reason,scope.chatId,scope.generation,id));
    },
    claim(scope: ConnectionScope, id: number, text: string, now: number, replayWindowMs = 0) {
      timestamp(now);
      timestamp(replayWindowMs);
      requireInput(typeof text === 'string' && text.trim().length > 0);
      return lifecycle.transaction(scope, db => {
        const row = readPublication(db,scope,id);
        if (!row) return null;
        const replay = row.kind === 'introduction' && row.state === 'unknown' && row.replayed === 0 &&
          row.attemptedAt !== null && now >= row.attemptedAt && now - row.attemptedAt < replayWindowMs;
        if (row.state !== 'pending' && !replay) return null;
        db.prepare(`UPDATE disclosure_publications SET state='sending',reason=NULL,text=coalesce(text,?),
          send_id=coalesce(send_id,?),attempt=attempt+1,attempted_at=coalesce(attempted_at,?),replayed=? WHERE id=?`)
          .run(text,randomInt(1,0x80000000),now,Number(replay),id);
        const replayUntil = replay ? row.attemptedAt! + replayWindowMs : undefined;
        return {...readPublication(db,scope,id)!,replay,replayUntil};
      });
    },
    finish(scope: ConnectionScope, claim: DisclosurePublication & {readonly replay:boolean}, outcome: 'delivered' | 'pending' | 'unknown',
      now: number, reason: DisclosureReason | null, receipt: string | null) {
      timestamp(now);
      requireInput(outcome !== 'delivered' || Boolean(receipt));
      return lifecycle.transaction(scope, db => {
        const row = readPublication(db,scope,claim.id);
        if (row?.state !== 'sending' || row.attempt !== claim.attempt) return false;
        const state = outcome === 'pending' && claim.replay ? 'unknown' : outcome;
        db.prepare(`UPDATE disclosure_publications SET state=?, reason=?, receipt=?, delivered_at=?,
          text=CASE WHEN ?='pending' THEN NULL ELSE text END, send_id=CASE WHEN ?='pending' THEN NULL ELSE send_id END,
          attempted_at=CASE WHEN ?='pending' THEN NULL ELSE attempted_at END
          WHERE id=?`).run(state,reason,receipt,state === 'delivered' ? now : null,state,state,state,claim.id);
        return true;
      });
    },
    confirm(scope: ConnectionScope, id: number, receipt: string, now: number) {
      timestamp(now);
      requireInput(Boolean(receipt));
      return lifecycle.transaction(scope, db => db.prepare(`UPDATE disclosure_publications
        SET state='delivered',reason=NULL,receipt=?,delivered_at=?
        WHERE chat_id=? AND generation=? AND id=? AND state='unknown' AND kind<>'owner'`)
        .run(receipt,now,scope.chatId,scope.generation,id).changes === 1);
    },
    recover(scope: ConnectionScope) {
      lifecycle.transaction(scope,db => db.prepare(`UPDATE disclosure_publications SET state='unknown',reason='unconfirmed'
        WHERE chat_id=? AND generation=? AND state='sending'`).run(scope.chatId,scope.generation));
    },
    diagnostics() {
      return connection.run(db => db.prepare(`SELECT p.kind,p.state,COUNT(DISTINCT p.generation) AS connections
        FROM disclosure_publications p WHERE p.kind<>'update' OR p.version=(
          SELECT MAX(q.version) FROM disclosure_publications q WHERE q.generation=p.generation AND q.kind='update'
        ) GROUP BY p.kind,p.state ORDER BY p.kind,p.state`).all());
    },
    status(chatId: ConnectionScope['chatId']) {
      return connection.run(db => {
        const connection = db.prepare('SELECT generation,state FROM chat_connections WHERE chat_id=?').get(chatId);
        const publications = db.prepare(`SELECT kind,state,reason,version FROM disclosure_publications
          WHERE chat_id=? ORDER BY id`).all(chatId);
        return {connection:connection ?? null,publications};
      });
    },
  };
}

type DisclosureStore = ReturnType<typeof createDisclosureStore>;
const stores = new WeakMap<Storage, DisclosureStore>();

export function registerDisclosureStore(storage: Storage, store: DisclosureStore) { stores.set(storage, store); }

export function disclosureStore(storage: Storage): DisclosureStore {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
