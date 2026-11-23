import {
  createAuthorizationService,
  openStorage,
  scopeFor,
  scopeForService,
} from './helpers/connection-scope';
import { expect, test } from 'vitest';

import { openConnection } from '../src/storage/connection';
import { authConfig } from './helpers/authorization-fixture';
import { storageFixture } from './helpers/storage-fixture';

test('ошибка SQL-аудита откатывает отзыв; после перезапуска очистка сохраняет минимальный след', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  let service = await createAuthorizationService({
    config: authConfig,
    store: storage.authorization,
    now: () => 100,
  });
  try {
    await storage.chats.create(scopeFor(storage, 'vk:one'), {
      responseMode: 'normal',
      enabled: true,
      createdAt: 0,
    });
    await service.applyTrustedInitialAuthorities(scopeForService(service, 'vk:one'), {
      creatorId: 'vk:user',
      inviterId: 'vk:user',
    });
    const owner = service.context({
      scope: scopeForService(service, 'vk:one'),
      userId: 'vk:owner',
      kind: 'owner',
    });
    await service.grant(
      owner,
      'vk:user',
      await service.confirmMembership(scopeForService(service, 'vk:one'), 'vk:user'),
    );
    const inspector = await openConnection(f.path);
    try {
      inspector.run((db) =>
        db.exec(
          "CREATE TRIGGER reject_audit BEFORE INSERT ON bot_admin_revocation_audit BEGIN SELECT RAISE(ABORT,'private SQL text'); END",
        ),
      );
      await expect(service.revoke(owner, 'vk:user', 'private reason')).rejects.toMatchObject({
        code: 'operation_failed',
        message: 'Storage: operation_failed',
      });
      await storage.authorization.transaction(scopeFor(storage, 'vk:one'), (tx) => {
        expect(tx.bases('vk:user')).toHaveLength(3);
        expect(tx.isRevoked('vk:user')).toBe(false);
        expect(tx.audit('vk:user')).toBeNull();
        expect(tx.recoveryBlocked()).toBe(false);
      });
      inspector.run((db) => db.exec('DROP TRIGGER reject_audit'));
    } finally {
      inspector.close();
    }
    await service.revoke(owner, 'vk:user', 'private reason');
    service.dispose();
    await storage.close();
    storage = await openStorage(f.path);
    service = await createAuthorizationService({
      config: authConfig,
      store: storage.authorization,
      now: () => 100 + 90 * 86_400_000,
    });
    const nextOwner = service.context({
      scope: scopeForService(service, 'vk:one'),
      userId: 'vk:owner',
      kind: 'owner',
    });
    expect(await service.audit(nextOwner, 'vk:user')).toMatchObject({
      value: { reason: null, revokedAt: 100, bases: ['creator', 'inviter', 'explicit'] },
    });
    await storage.authorization.transaction(scopeFor(storage, 'vk:one'), (tx) => {
      expect(tx.isRevoked('vk:user')).toBe(true);
      expect(tx.recoveryBlocked()).toBe(true);
    });
    service.dispose();
    expect(
      await service.applyTrustedInitialAuthorities(scopeForService(service, 'vk:one'), {
        creatorId: 'vk:other',
      }),
    ).toEqual({ allowed: false, code: 'invalid_context' });
  } finally {
    service.dispose();
    await storage.close();
    f.cleanup();
  }
});
