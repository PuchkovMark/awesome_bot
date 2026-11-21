import { createAuthorizationStore } from './authorization-store.js';
import { createChatStore } from './chats.js';
import { openConnection } from './connection.js';
import { createMessageStore } from './messages.js';
import { migrate } from './migrate.js';
import type { Storage } from './types.js';

export async function openStorage(path: string): Promise<Storage> {
  const connection = await openConnection(path, migrate);
  try {
    return {
      authorization: createAuthorizationStore(connection),
      messages: createMessageStore(connection),
      chats: createChatStore(connection),
      async close() { connection.close(); },
    };
  } catch (error) { connection.close(); throw error; }
}
