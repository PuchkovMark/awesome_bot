import { asyncStore } from './legacy-types.js';
import { createScopedStorage } from './scoped-storage.js';
import { createLifecycleBackend, registerLifecycle } from './lifecycle-store.js';
import { createAuthorizationStore } from './authorization-store.js';
import { createChatStore } from './chats.js';
import { openConnection } from './connection.js';
import { createMessageStore } from './messages.js';
import { migrate } from './migrate.js';
import type { Storage } from './types.js';

export async function openStorage(path: string): Promise<Storage> {
  const connection = await openConnection(path, migrate);
  try {
    const backend=createLifecycleBackend(connection);
    const auth=createAuthorizationStore(connection);
    const storage: Storage = {
      scoped: createScopedStorage(connection,backend),
      authorization: {
        async transaction(chatId,callback) {return auth.transaction(chatId,callback);},
        async pruneReasons(now,retentionMs) {return auth.pruneReasons(now,retentionMs);},
      },
      messages: asyncStore(createMessageStore(connection)),
      chats: asyncStore(createChatStore(connection)),
      async close() { connection.close(); },
    };
    registerLifecycle(storage,backend);
    return storage;
  } catch (error) { connection.close(); throw error; }
}
