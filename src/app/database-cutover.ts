import { renameSync } from 'node:fs';
import type { BackupPaths, BackupControl } from '../storage/backup-control';
import { finishSwitch } from '../storage/backup-control';
import {
  BackupFailure,
  checkAge,
  checkDatabase,
  fileIdentity,
  openExisting,
  syncFile,
} from '../storage/database-backup';

export async function switchDatabase(
  paths: BackupPaths,
  control: BackupControl,
  now: () => number,
  checkpoint?: (phase: string) => Promise<void> | void,
) {
  const state = control.state;
  const stamp = state.latest;
  if (!stamp || fileIdentity(paths.database) !== state.live)
    throw new BackupFailure('untrusted_source');
  // The app and all supported administrative writers are excluded until after the directory sync.
  const old = openExisting(paths.database, false);
  try {
    const checkpointResult = old.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (
      checkpointResult[0]?.busy ||
      old.pragma('journal_mode=DELETE', { simple: true }) !== 'delete'
    )
      throw new BackupFailure('backup_busy');
  } finally {
    old.close();
  }
  const staged = openExisting(paths.candidate, false);
  try {
    staged.pragma('journal_mode=DELETE');
    staged.exec('DROP TABLE backup_snapshot');
    checkDatabase(staged);
  } finally {
    staged.close();
  }
  syncFile(paths.candidate);
  state.switchTo = fileIdentity(paths.candidate)!;
  control.persist();
  await checkpoint?.('before_switch');
  checkAge(stamp, now());
  if (fileIdentity(paths.database) !== state.live) throw new BackupFailure('untrusted_source');
  renameSync(paths.candidate, paths.database);
  await checkpoint?.('after_switch');
  finishSwitch(paths, control);
}
