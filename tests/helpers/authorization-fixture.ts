import { openStorage, createAuthorizationService, scopeFor, scopeForService } from './connection-scope';


import type { AuthorizationOptions } from '../../src/core/index';

export const authConfig = { ownerId: 'vk:owner', reasonMaxLength: 500, reasonRetentionDays: 90 } as const;
export async function authorizationFixture(options: Partial<AuthorizationOptions> = {}) {
  const storage = await openStorage(':memory:');
  for (const chatId of ['vk:one', 'vk:two', 'test:one'] as const) {
    await storage.chats.create(scopeFor(storage, chatId), { responseMode: 'normal', enabled: true, createdAt: 0 });
  }
  const service = await createAuthorizationService({ config: authConfig, store: storage.authorization, now: () => 100, ...options });
  const owner = service.context({ scope: scopeForService(service, 'vk:one'), userId: 'vk:owner', kind: 'owner' });
  const member = service.context({ scope: scopeForService(service, 'vk:one'), userId: 'vk:user' });
  return { storage, service, owner, member, async close() { service.dispose(); await storage.close(); } };
}
