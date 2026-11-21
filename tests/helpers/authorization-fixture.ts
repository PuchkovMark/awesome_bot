import { openStorage } from '../../src/storage/index.js';
import { createAuthorizationService } from '../../src/core/index.js';
import type { AuthorizationOptions } from '../../src/core/index.js';

export const authConfig = { ownerId: 'vk:owner', reasonMaxLength: 500, reasonRetentionDays: 90 } as const;
export async function authorizationFixture(options: Partial<AuthorizationOptions> = {}) {
  const storage = await openStorage(':memory:');
  for (const chatId of ['vk:one', 'vk:two', 'test:one'] as const) {
    await storage.chats.create(chatId, { responseMode: 'mention', enabled: true, createdAt: 0 });
  }
  const service = createAuthorizationService({ config: authConfig, store: storage.authorization, now: () => 100, ...options });
  const owner = service.context({ chatId: 'vk:one', userId: 'vk:owner', kind: 'owner' });
  const member = service.context({ chatId: 'vk:one', userId: 'vk:user' });
  return { storage, service, owner, member };
}
