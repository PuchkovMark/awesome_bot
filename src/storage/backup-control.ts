import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import {
  BackupFailure,
  backupLifetimeMs,
  checkDatabase,
  fileIdentity,
  openExisting,
  openMaintenanceDatabase,
  snapshotMetadata,
  syncFile,
} from './database-backup';
import type { Snapshot } from './database-backup';
import type { RestoreAdmission } from './database-restore';

type SavedSnapshot = Snapshot & { file: string };
export type Attempt = { action: string; at: number; outcome: string; durationMs?: number };
export type Check = { at: number; durationMs: number; outcome: string; access?: RestoreAdmission };
export interface BackupState {
  database: string;
  installation: string;
  live: string | null;
  switchTo: string | null;
  latest: SavedSnapshot | null;
  publishing: SavedSnapshot | null;
  attempt: Attempt | null;
  verification: Check | null;
}
export function backupPaths(databasePath: string) {
  const root = realpathSync(dirname(databasePath)),
    database = join(root, basename(databasePath));
  const service = join(root, '.awesome-bot-maintenance'),
    directory = join(root, 'backups');
  if (
    basename(root) === 'backups' ||
    basename(root) === '.awesome-bot-maintenance' ||
    [directory, service].includes(database)
  )
    throw new BackupFailure('unsafe_file');
  return {
    root,
    database,
    directory,
    service,
    guard: join(service, 'lock.sqlite'),
    control: join(service, 'state.sqlite'),
    latest: join(directory, 'latest.sqlite'),
    incoming: join(directory, '.incoming.sqlite'),
    candidate: join(service, 'candidate.sqlite'),
    authority: join(service, 'authority.sqlite'),
  };
}
export type BackupPaths = ReturnType<typeof backupPaths>;

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0) throw new BackupFailure('unsafe_directory');
}

export function lockDatabase(p: BackupPaths, mode: 'shared' | 'maintenance' | 'exclusive') {
  privateDirectory(p.service);
  fileIdentity(p.guard);
  const db = openMaintenanceDatabase(p.guard, { timeout: 0 });
  try {
    db.exec(
      mode === 'shared' ? 'BEGIN' : mode === 'maintenance' ? 'BEGIN IMMEDIATE' : 'BEGIN EXCLUSIVE',
    );
    db.prepare('SELECT count(*) FROM sqlite_schema').get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openControl(p: BackupPaths) {
  fileIdentity(p.control);
  const db = openMaintenanceDatabase(p.control);
  try {
    db.pragma('synchronous=FULL');
    db.exec(
      'CREATE TABLE IF NOT EXISTS backup_control(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL) STRICT',
    );
    const existing = db.prepare('SELECT state FROM backup_control WHERE id=1').pluck().get() as
      string | undefined;
    if (!existing && fileIdentity(p.latest)) throw new BackupFailure('installation_unknown');
    const state: BackupState = existing
      ? JSON.parse(existing)
      : {
          database: basename(p.database),
          installation: randomUUID(),
          live: null,
          switchTo: null,
          latest: null,
          publishing: null,
          attempt: null,
          verification: null,
        };
    if (state.database !== basename(p.database)) throw new BackupFailure('different_database');
    const persist = () =>
      db
        .prepare(
          'INSERT INTO backup_control VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state',
        )
        .run(JSON.stringify(state));
    if (!existing) persist();
    return { state, persist, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
export type BackupControl = ReturnType<typeof openControl>;

export function removeOwnedFile(path: string) {
  if (fileIdentity(path)) unlinkSync(path);
}

export function cleanStaging(p: BackupPaths) {
  for (const path of [p.incoming, p.candidate, p.authority])
    for (const suffix of ['-shm', '-wal', '-journal', '']) removeOwnedFile(path + suffix);
}

export function inspectSnapshot(path: string, expected: SavedSnapshot) {
  if (fileIdentity(path) !== expected.file) throw new BackupFailure('snapshot_replaced');
  const db = openExisting(path);
  try {
    const actual = snapshotMetadata(db);
    if (
      !actual ||
      actual.id !== expected.id ||
      actual.installation !== expected.installation ||
      actual.createdAt !== expected.createdAt
    )
      throw new BackupFailure('invalid_snapshot');
    checkDatabase(db);
    return actual;
  } finally {
    db.close();
  }
}

// Intent is durable before rename. Exactly the old or the new inode must be installed.
export function finishSwitch(p: BackupPaths, control: BackupControl) {
  const s = control.state;
  if (!s.switchTo) return;
  const actual = fileIdentity(p.database);
  if (actual === s.switchTo) {
    const db = openExisting(p.database);
    try {
      checkDatabase(db);
      if (snapshotMetadata(db)) throw new BackupFailure('untrusted_source');
    } finally {
      db.close();
    }
    syncFile(p.root);
    syncFile(p.service);
    s.live = actual;
    if (s.attempt) s.attempt.outcome = 'restored';
  } else if (actual !== s.live) throw new BackupFailure('untrusted_source');
  else if (s.attempt) s.attempt.outcome = 'interrupted';
  s.switchTo = null;
  control.persist();
}

export function finishPublication(p: BackupPaths, control: BackupControl, now: number) {
  const s = control.state;
  if (!s.publishing) return;
  if (fileIdentity(p.latest) === s.publishing.file) {
    if (now - s.publishing.createdAt >= backupLifetimeMs) {
      removeOwnedFile(p.latest);
      syncFile(p.directory);
      s.latest = null;
      s.publishing = null;
      if (s.attempt) s.attempt.outcome = 'snapshot_expired';
      control.persist();
      return;
    }
    inspectSnapshot(p.latest, s.publishing);
    syncFile(p.directory);
    s.latest = s.publishing;
    if (s.attempt) s.attempt.outcome = 'created';
  } else if (s.attempt) s.attempt.outcome = 'interrupted';
  s.publishing = null;
  control.persist();
}

export function expireLatest(paths: BackupPaths, control: BackupControl, now: number) {
  const state = control.state,
    latest = state.latest;
  if (!latest || now - latest.createdAt < backupLifetimeMs) return;
  const file = fileIdentity(paths.latest);
  if (file) {
    if (file !== latest.file) {
      // A moved snapshot keeps its original timestamp. Protect unrelated files at the reserved path.
      const db = openExisting(paths.latest);
      try {
        const actual = snapshotMetadata(db);
        if (actual?.id !== latest.id || actual.installation !== latest.installation)
          throw new BackupFailure('snapshot_replaced');
      } finally {
        db.close();
      }
    }
    removeOwnedFile(paths.latest);
    syncFile(paths.directory);
  }
  state.latest = null;
  control.persist();
}

export function cleanupExpiredOnStartup(paths: BackupPaths, now: number) {
  let lock;
  try {
    lock = lockDatabase(paths, 'maintenance');
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_BUSY') return;
    throw error;
  }
  try {
    const control = openControl(paths);
    try {
      finishPublication(paths, control, now);
      cleanStaging(paths);
      expireLatest(paths, control, now);
    } finally {
      control.close();
    }
  } finally {
    lock.close();
  }
}
