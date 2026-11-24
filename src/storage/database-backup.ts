import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { closeSync, fsyncSync, lstatSync, openSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { migrations } from './migrations/index';
import { verifyMigrationHistory } from './migrate';
import { openStorage } from './storage';

export const backupLifetimeMs = 30 * 86_400_000;
export type Snapshot = { id: string; installation: string; createdAt: number };

export class BackupFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function fileIdentity(path: string): string | undefined {
  const s = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!s) return undefined;
  if (!s.isFile() || s.nlink !== 1n) throw new BackupFailure('unsafe_file');
  return [s.dev, s.ino, s.birthtimeNs].join(':');
}

export function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const loadNativeDriver = createRequire(import.meta.url);

// These administrative operations are synchronous. Keep native loading at the first actual open.
export function openMaintenanceDatabase(path: string, options: Database.Options = {}) {
  const Driver = loadNativeDriver('better-sqlite3') as typeof Database;
  return new Driver(path, options);
}

export function openExisting(path: string, readonly = true) {
  if (!fileIdentity(path)) throw new BackupFailure('database_missing');
  if (!statSync(path).size) throw new BackupFailure('database_empty');
  const db = openMaintenanceDatabase(path, { readonly, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function checkDatabase(db: Database.Database) {
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  )
    throw new BackupFailure('database_corrupt');
  try {
    if (!verifyMigrationHistory(db, migrations)) throw new BackupFailure('schema_incompatible');
  } catch {
    throw new BackupFailure('schema_incompatible');
  }
}

export function snapshotMetadata(db: Database.Database): Snapshot | undefined {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='backup_snapshot'").get()
  )
    return undefined;
  const rows = db
    .prepare('SELECT id,installation,created_at AS createdAt FROM backup_snapshot')
    .all() as Snapshot[];
  const stamp = rows[0];
  if (
    rows.length !== 1 ||
    !stamp ||
    typeof stamp.id !== 'string' ||
    !stamp.id ||
    typeof stamp.installation !== 'string' ||
    !stamp.installation ||
    !Number.isSafeInteger(stamp.createdAt) ||
    stamp.createdAt < 0
  )
    throw new BackupFailure('invalid_snapshot');
  return stamp;
}

// Reserve the destination before calling SQLite. The backup API otherwise overwrites an existing file.
export async function copyDatabase(source: Database.Database, target: string) {
  closeSync(openSync(target, 'wx', 0o600));
  await source.backup(target);
}

export async function createSnapshot(
  source: Database.Database,
  target: string,
  installation: string,
  now: number,
): Promise<Snapshot> {
  if (!source.readonly || snapshotMetadata(source)) throw new BackupFailure('untrusted_source');
  await copyDatabase(source, target);
  const db = openExisting(target, false);
  try {
    checkDatabase(db);
    const stamp = { id: randomUUID(), installation, createdAt: now };
    db.pragma('journal_mode=DELETE');
    db.exec(
      'CREATE TABLE backup_snapshot(id TEXT NOT NULL, installation TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT',
    );
    db.prepare('INSERT INTO backup_snapshot VALUES (@id,@installation,@createdAt)').run(stamp);
    return stamp;
  } finally {
    db.close();
  }
}

export function checkAge(stamp: Snapshot, now: number) {
  if (stamp.createdAt > now || now - stamp.createdAt >= backupLifetimeMs)
    throw new BackupFailure('snapshot_expired');
}

export async function openCandidate(
  snapshotPath: string,
  target: string,
  installation: string,
  now: number,
) {
  const source = openExisting(snapshotPath);
  try {
    const stamp = snapshotMetadata(source);
    if (!stamp || stamp.installation !== installation) throw new BackupFailure('foreign_snapshot');
    checkAge(stamp, now);
    checkDatabase(source);
    await copyDatabase(source, target);
  } finally {
    source.close();
  }
  // Migrate and exercise the normal application store only on the disposable candidate.
  const storage = await openStorage(target);
  await storage.close();
}
