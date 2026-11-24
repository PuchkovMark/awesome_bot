import { renameSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  BackupFailure,
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
  expireLatest,
} from '../storage/backup-control';
import type { BackupControl, BackupPaths } from '../storage/backup-control';
import { reconcileRestore } from '../storage/backup-history';
import { verifyMigrationHistory } from '../storage/migrate';
import { migrations } from '../storage/migrations/index';
import { openStorage } from '../storage/storage';
import { switchDatabase } from './database-cutover';

export type BackupAction = 'create' | 'verify' | 'status' | 'restore';
type BackupConfig = { databasePath: string; messageRetentionDays: number };
type Hooks = { now?: () => number; checkpoint?: (phase: string) => Promise<void> | void };

function errorCode(error: unknown) {
  if (error instanceof BackupFailure) return error.code;
  const code = (error as { code?: string })?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'backup_busy';
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return 'database_corrupt';
  return 'backup_failed';
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

interface Operation {
  paths: BackupPaths;
  control: BackupControl;
  config: BackupConfig;
  now: () => number;
  hooks: Hooks;
}

async function updateDailySnapshot({ paths, control, config, now, hooks }: Operation) {
  const state = control.state,
    source = trustedSource(paths, control, true);
  try {
    const previous = state.latest;
    if (
      previous &&
      Math.floor(previous.createdAt / 86_400_000) === Math.floor(now() / 86_400_000)
    ) {
      try {
        inspectSnapshot(paths.latest, previous);
        checkAge(previous, now());
        return 'already_created_today';
      } catch {
        // A damaged file from this date must be replaced with a verified snapshot.
      }
    }
    const stamp = await createSnapshot(source, paths.incoming, state.installation, now());
    await hooks.checkpoint?.('copied');
    await rehearse(paths, control, paths.incoming, config, now, hooks);
    syncFile(paths.incoming);
    state.publishing = { ...stamp, file: fileIdentity(paths.incoming)! };
    control.persist();
    await hooks.checkpoint?.('before_publish');
    checkAge(stamp, now());
    renameSync(paths.incoming, paths.latest);
    await hooks.checkpoint?.('after_publish');
    finishPublication(paths, control, now());
    return 'created';
  } finally {
    source.close();
  }
}

async function perform(action: BackupAction, operation: Operation) {
  const { paths, control, config, now, hooks } = operation;
  const latest = control.state.latest;
  if (action === 'create') return updateDailySnapshot(operation);
  if (latest) inspectSnapshot(paths.latest, latest);
  if (action === 'status') return 'status';
  if (!latest) throw new BackupFailure('snapshot_missing');
  checkAge(latest, now());
  await rehearse(paths, control, paths.latest, config, now, hooks);
  checkAge(latest, now());
  if (action === 'verify') return 'verified';
  await switchDatabase(paths, control, now, hooks.checkpoint);
  return 'restored';
}

async function runOperation(action: BackupAction, operation: Operation) {
  const { paths, control, now } = operation;
  const state = control.state,
    at = now(),
    started = performance.now();
  finishSwitch(paths, control);
  finishPublication(paths, control, at);
  if (state.attempt?.outcome === 'running') {
    state.attempt.outcome = 'interrupted';
    control.persist();
  }
  cleanStaging(paths);
  expireLatest(paths, control, at);
  if (action !== 'status') {
    state.attempt = { action, at, outcome: 'running' };
    control.persist();
  }
  let ok = true,
    outcome: string;
  try {
    outcome = await perform(action, operation);
  } catch (error) {
    ok = false;
    outcome = errorCode(error);
    if (action === 'verify' || action === 'restore')
      state.verification = { at, durationMs: Math.round(performance.now() - started), outcome };
  } finally {
    cleanStaging(paths);
    expireLatest(paths, control, now());
  }
  if (action !== 'status' && state.attempt) {
    state.attempt.outcome = outcome;
    state.attempt.durationMs = Math.round(performance.now() - started);
    control.persist();
  }
  return {
    ok,
    outcome,
    latestAt: state.latest?.createdAt ?? null,
    attempt: state.attempt,
    verification: state.verification,
  };
}

export async function runBackup(config: BackupConfig, action: BackupAction, hooks: Hooks = {}) {
  try {
    const paths = backupPaths(config.databasePath);
    const guard = lockDatabase(paths, action === 'restore' ? 'exclusive' : 'maintenance');
    try {
      privateDirectory(paths.directory);
      const control = openControl(paths);
      try {
        return await runOperation(action, {
          paths,
          control,
          config,
          hooks,
          now: hooks.now ?? Date.now,
        });
      } finally {
        control.close();
      }
    } finally {
      guard.close();
    }
  } catch (error) {
    return { ok: false, outcome: errorCode(error) };
  }
}
