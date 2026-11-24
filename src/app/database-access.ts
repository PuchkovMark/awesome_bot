import { basename } from 'node:path';
import { statSync } from 'node:fs';
import {
  backupPaths,
  cleanupExpiredOnStartup,
  finishSwitch,
  lockDatabase,
  openControl,
} from '../storage/backup-control';
import type { BackupPaths, BackupState } from '../storage/backup-control';
import {
  BackupFailure,
  backupLifetimeMs,
  fileIdentity,
  openExisting,
  openMaintenanceDatabase,
  snapshotMetadata,
} from '../storage/database-backup';
import { openStorage } from '../storage/index';

function readBinding(p: BackupPaths) {
  if (!fileIdentity(p.control)) {
    if (fileIdentity(p.latest)) throw new BackupFailure('installation_unknown');
    return undefined;
  }
  const db = openMaintenanceDatabase(p.control, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='backup_control'").get()) {
      if (fileIdentity(p.latest)) throw new BackupFailure('installation_unknown');
      return undefined;
    }
    const row = db.prepare('SELECT state FROM backup_control WHERE id=1').pluck().get() as
      string | undefined;
    const state = row ? (JSON.parse(row) as BackupState) : undefined;
    return state?.database === basename(p.database) ? state : undefined;
  } finally {
    db.close();
  }
}

export async function openApplicationStorage(
  path: string,
  options?: Parameters<typeof openStorage>[1],
) {
  const p = backupPaths(path);
  let guard = lockDatabase(p, 'shared');
  try {
    let binding = readBinding(p);
    if (binding?.switchTo) {
      guard.close();
      guard = lockDatabase(p, 'exclusive');
      const c = openControl(p);
      try {
        finishSwitch(p, c);
      } finally {
        c.close();
      }
      guard.close();
      guard = lockDatabase(p, 'shared');
      binding = readBinding(p);
    }
    const now = Date.now();
    if (
      binding?.publishing ||
      (binding?.latest && now - binding.latest.createdAt >= backupLifetimeMs)
    )
      cleanupExpiredOnStartup(p, now);
    const actual = fileIdentity(p.database);
    if (binding?.live && binding.live !== actual) throw new BackupFailure('untrusted_source');
    if (actual && statSync(p.database).size > 0) {
      const db = openExisting(p.database);
      try {
        if (snapshotMetadata(db)) throw new BackupFailure('untrusted_source');
      } finally {
        db.close();
      }
    }
    const storage = await openStorage(p.database, options);
    const close = storage.close.bind(storage);
    // Keep the original storage object: internal registries bind capabilities to its identity.
    storage.close = async () => {
      try {
        await close();
      } finally {
        if (guard.open) guard.close();
      }
    };
    return storage;
  } catch (error) {
    if (guard.open) guard.close();
    throw error;
  }
}
