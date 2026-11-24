import { renameSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  BackupFailure,
  backupLifetimeMs,
  checkAge,
  checkDatabase,
  copyDatabase,
  createSnapshot,
  fileIdentity,
  openCandidate,
  openExisting,
  snapshotMetadata,
  syncFile,
} from '../storage/database-backup';
import {
  backupPaths,
  cleanStaging,
  finishPublication,
  finishSwitch,
  inspectSnapshot,
  lockDatabase,
  openControl,
  privateDirectory,
  removeOwnedFile,
} from '../storage/backup-control';
import type { BackupControl, BackupPaths } from '../storage/backup-control';
import { reconcileRestore } from '../storage/backup-history';
import { verifyMigrationHistory } from '../storage/migrate';
import { migrations } from '../storage/migrations/index';
import { openStorage } from '../storage/storage';

export type BackupAction = 'create' | 'verify' | 'status';
type BackupConfig = { databasePath: string; messageRetentionDays: number };
type Hooks = { now?: () => number; checkpoint?: (phase: string) => Promise<void> | void };

function errorCode(error: unknown) {
  if (error instanceof BackupFailure) return error.code;
  const code = (error as { code?: string })?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'backup_busy';
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return 'database_corrupt';
  return 'backup_failed';
}

function expireLatest(p: BackupPaths, c: BackupControl, at: number) {
  const s = c.state;
  if (!s.latest || at - s.latest.createdAt < backupLifetimeMs) return;
  if (fileIdentity(p.latest) === s.latest.file) {
    removeOwnedFile(p.latest);
    syncFile(p.directory);
  }
  s.latest = null;
  c.persist();
}

function trustedSource(p: BackupPaths, c: BackupControl, initialize: boolean) {
  const identity = fileIdentity(p.database);
  if (!identity) throw new BackupFailure('database_missing');
  if (
    c.state.live !== identity &&
    !(initialize && c.state.live === null && c.state.latest === null)
  )
    throw new BackupFailure('untrusted_source');
  const db = openExisting(p.database);
  try {
    if (snapshotMetadata(db)) throw new BackupFailure('untrusted_source');
    checkDatabase(db);
    if (c.state.live === null) {
      c.state.live = identity;
      c.persist();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function rehearse(
  p: BackupPaths,
  c: BackupControl,
  snapshot: string,
  config: BackupConfig,
  now: () => number,
  hooks: Hooks,
) {
  const start = performance.now(),
    at = now();
  try {
    await openCandidate(snapshot, p.candidate, c.state.installation, at);
    let source = trustedSource(p, c, false);
    try {
      if (verifyMigrationHistory(source, migrations) !== migrations.length) {
        await copyDatabase(source, p.authority);
        source.close();
        await (await openStorage(p.authority)).close();
        source = openExisting(p.authority);
      }
      const staged = openExisting(p.candidate, false);
      const access = (() => {
        try {
          return reconcileRestore(staged, source, at, config.messageRetentionDays * 86_400_000);
        } finally {
          staged.close();
        }
      })();
      if (fileIdentity(p.database) !== c.state.live) throw new BackupFailure('untrusted_source');
      await (await openStorage(p.candidate)).close();
      const check = openExisting(p.candidate);
      try {
        checkDatabase(check);
      } finally {
        check.close();
      }
      await hooks.checkpoint?.('verified');
      if (access.access === 'denied') throw new BackupFailure('access_denied');
      c.state.verification = {
        at,
        durationMs: Math.round(performance.now() - start),
        outcome: 'verified',
        access,
      };
      c.persist();
      return access;
    } finally {
      if (source.open) source.close();
    }
  } catch (error) {
    c.state.verification = {
      at,
      durationMs: Math.round(performance.now() - start),
      outcome: errorCode(error),
    };
    c.persist();
    throw error;
  }
}

export async function runBackup(config: BackupConfig, action: BackupAction, hooks: Hooks = {}) {
  const now = hooks.now ?? Date.now,
    started = performance.now();
  try {
    const p = backupPaths(config.databasePath);
    const guard = lockDatabase(p, 'maintenance');
    try {
      privateDirectory(p.directory);
      const c = openControl(p),
        s = c.state;
      try {
        finishSwitch(p, c);
        finishPublication(p, c);
        if (s.attempt?.outcome === 'running') {
          s.attempt.outcome = 'interrupted';
          c.persist();
        }
        cleanStaging(p);
        expireLatest(p, c, now());
        if (action !== 'status') {
          s.attempt = { action, at: now(), outcome: 'running' };
          c.persist();
        }
        let outcome = 'status';
        if (action === 'create') {
          const source = trustedSource(p, c, true);
          try {
            let sameDay = false;
            if (
              s.latest &&
              Math.floor(s.latest.createdAt / 86_400_000) === Math.floor(now() / 86_400_000)
            ) {
              try {
                inspectSnapshot(p.latest, s.latest);
                checkAge(s.latest, now());
                sameDay = true;
              } catch {
                sameDay = false;
              }
            }
            if (sameDay) outcome = 'already_created_today';
            else {
              const stamp = await createSnapshot(source, p.incoming, s.installation, now());
              await hooks.checkpoint?.('copied');
              await rehearse(p, c, p.incoming, config, now, hooks);
              checkAge(stamp, now());
              syncFile(p.incoming);
              s.publishing = { ...stamp, file: fileIdentity(p.incoming)! };
              c.persist();
              await hooks.checkpoint?.('before_publish');
              renameSync(p.incoming, p.latest);
              await hooks.checkpoint?.('after_publish');
              finishPublication(p, c);
              outcome = 'created';
            }
          } finally {
            source.close();
          }
        } else if (action === 'verify') {
          if (!s.latest) throw new BackupFailure('snapshot_missing');
          inspectSnapshot(p.latest, s.latest);
          checkAge(s.latest, now());
          await rehearse(p, c, p.latest, config, now, hooks);
          outcome = 'verified';
        } else if (s.latest) inspectSnapshot(p.latest, s.latest);
        if (action !== 'status' && s.attempt) {
          s.attempt.outcome = outcome;
          s.attempt.durationMs = Math.round(performance.now() - started);
          c.persist();
        }
        return {
          ok: true,
          outcome,
          latestAt: s.latest?.createdAt ?? null,
          attempt: s.attempt,
          verification: s.verification,
        };
      } catch (error) {
        const reason = errorCode(error);
        if (action !== 'status' && s.attempt) {
          s.attempt.outcome = reason;
          s.attempt.durationMs = Math.round(performance.now() - started);
          c.persist();
        }
        return {
          ok: false,
          outcome: reason,
          latestAt: s.latest?.createdAt ?? null,
          attempt: s.attempt,
          verification: s.verification,
        };
      } finally {
        try {
          cleanStaging(p);
          expireLatest(p, c, now());
        } finally {
          c.close();
        }
      }
    } finally {
      guard.close();
    }
  } catch (error) {
    return { ok: false, outcome: errorCode(error) };
  }
}
