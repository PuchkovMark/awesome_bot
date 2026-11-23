import { createPersonalDataStore, registerPersonalData } from './personal-data-store';
import { createTokenBudgetStore, registerTokenBudgets } from './token-budget-store';
import { createHistoryClearStore, registerHistoryClear } from './history-retention-store';
import { requireInput } from './validation';
import { createTraceBackend, registerTraces } from './trace-store';
import { createNoticeBackend, registerNotices } from './notice-store';
import { createQueueBackend } from './queue-store';
import { registerQueue } from './queue-registry';
import { object } from './validation';
import { safeError } from './errors';
import { createVersionBackend } from './version-store';
import { registerVersions } from './version-registry';
import { versionLimits } from './version-limits';
import type { VersionLimits } from '../contracts/versioning';
import { createLifecycleBackend, registerLifecycle } from './lifecycle-store';
import { createDisclosureStore, registerDisclosureStore } from './chat-disclosure-store';
import { createAdminRecoveryStore, registerAdminRecovery } from './admin-recovery-store';
import { createChatControlStore, registerChatControl } from './chat-control-store';
import { createReminderStore, registerReminders } from './reminder-store';
import { createParticipantRegistry, registerParticipantRegistry } from './participant-registry';
import { createScopedStorage } from './scoped-storage';
import { openConnection } from './connection';
import { migrate } from './migrate';
import type { Storage } from './types';

export async function openStorage(
  path: string,
  options: { readonly versioning?: VersionLimits; readonly messageRetentionDays?: number } = {},
): Promise<Storage> {
  let limits: VersionLimits;
  try {
    object(options, ['versioning', 'messageRetentionDays']);
    const snapshot = { ...options };
    limits = versionLimits(snapshot.versioning as VersionLimits | undefined);
    requireInput(
      snapshot.messageRetentionDays === undefined ||
        (Number.isSafeInteger(snapshot.messageRetentionDays) &&
          snapshot.messageRetentionDays > 0 &&
          Number.isSafeInteger(snapshot.messageRetentionDays * 86_400_000)),
    );
  } catch (error) {
    throw safeError(error, 'invalid_input');
  }
  const connection = await openConnection(path, migrate);
  try {
    const backend = createLifecycleBackend(connection);
    const versions = createVersionBackend(connection, backend, limits);
    const traces = createTraceBackend(connection, backend);
    const queue = createQueueBackend(connection, backend, traces, options.messageRetentionDays);
    const storage: Storage = {
      ...createScopedStorage(connection, backend, versions, queue),
      traces: {
        async get(scope, id) {
          return traces.get(scope, id);
        },
        async last(scope) {
          return traces.get(scope);
        },
      },
      async close() {
        connection.close();
      },
    };
    registerPersonalData(storage, createPersonalDataStore(connection, backend));
    registerParticipantRegistry(storage, createParticipantRegistry(connection, backend));
    registerReminders(storage, createReminderStore(connection, backend));
    registerHistoryClear(storage, createHistoryClearStore(connection, backend));
    registerDisclosureStore(storage, createDisclosureStore(connection, backend));
    registerAdminRecovery(storage, createAdminRecoveryStore(connection, backend));
    registerChatControl(storage, createChatControlStore(connection, backend));
    registerTraces(storage, traces);
    registerTokenBudgets(storage, createTokenBudgetStore(connection, backend));
    registerNotices(storage, createNoticeBackend(connection, backend));
    registerQueue(storage, queue);
    registerLifecycle(storage, backend);
    registerVersions(storage, versions);
    return storage;
  } catch (error) {
    connection.close();
    throw error;
  }
}
