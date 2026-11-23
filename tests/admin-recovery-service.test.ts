import { expect, test } from 'vitest';
import { createAuthorizationService, createLifecycleService } from '../src/core/index';
import { adminRecoveryStore } from '../src/storage/admin-recovery-store';
import { openStorage } from '../src/storage/index';

const chat = 'vk:2000000010',
  ownerId = 'vk:1',
  subject = 'vk:73';
const config = { ownerId, reasonMaxLength: 500, reasonRetentionDays: 90 } as const;

test('владелец восстанавливает управление при выключенном боте, а устаревшее доказательство и отзыв не обходят проверку', async () => {
  const storage = await openStorage(':memory:');
  const lifecycle = createLifecycleService({
    storage,
    ownerId,
    source: {
      async observe() {
        return { confidence: 'confirmed', bot: 'present', creatorId: 'vk:6' };
      },
    },
  });
  const auth = await createAuthorizationService({ config, store: storage.authorization });
  try {
    const scope = (await lifecycle.verify(chat)).scope!;
    await storage.chats.create(scope, { responseMode: 'silent', enabled: false, createdAt: 1 });
    const owner = auth.context({ scope, userId: ownerId, kind: 'owner' });
    const member = auth.context({ scope, userId: 'vk:6' });
    const proof = await auth.confirmMembership(scope, subject);
    expect(await auth.recoverAdmin(member, subject, 1, proof, () => true)).toMatchObject({
      allowed: false,
    });
    const blocked = await auth.confirmMembership(scope, 'vk:6');
    expect(await auth.revoke(owner, 'vk:6', 'Синтетический отзыв')).toMatchObject({
      allowed: true,
    });
    expect(await auth.recoverAdmin(owner, 'vk:6', 2, blocked, () => true)).toMatchObject({
      allowed: false,
      code: 'revoked',
    });
    expect(await auth.recoverAdmin(owner, subject, 3, proof, () => true)).toMatchObject({
      allowed: false,
      code: 'unconfirmed_member',
    });
    const current = await auth.confirmMembership(scope, subject);
    const results = await Promise.all([
      auth.recoverAdmin(owner, subject, 4, current, () => true),
      auth.recoverAdmin(owner, subject, 4, current, () => true),
    ]);
    expect(results).toMatchObject([
      { allowed: true, value: { created: true } },
      { allowed: true, value: { created: false } },
    ]);
    expect(adminRecoveryStore(storage).status(chat, ownerId)).toHaveLength(1);
    expect(
      await storage.authorization.transaction(scope, (tx) => ({
        bases: tx.bases(subject),
        blocked: tx.recoveryBlocked(),
      })),
    ).toEqual({ bases: ['explicit'], blocked: true });
  } finally {
    auth.dispose();
    await storage.close();
  }
});

test('защищённый администратор остаётся назначен после выхода, а опоздавшая сверка не отменяет выход', async () => {
  const storage = await openStorage(':memory:');
  const lifecycle = createLifecycleService({
    storage,
    ownerId,
    source: {
      async observe() {
        return { confidence: 'confirmed', bot: 'present', creatorId: subject, inviterId: subject };
      },
    },
  });
  try {
    const scope = (await lifecycle.verify(chat)).scope!;
    await storage.chats.create(scope, { responseMode: 'normal', enabled: true, createdAt: 1 });
    const store = adminRecoveryStore(storage);
    expect(store.list('vk', () => true)).toMatchObject([{ state: 'unknown' }]);
    const read = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const pending = lifecycle.refreshAdministration(lifecycle.admissionScope(chat), async () => {
      entered.resolve();
      await read.promise;
      return {
        observation: {
          confidence: 'confirmed',
          bot: 'present',
          members: { complete: false, ids: [subject] },
        },
        communityAdmin: true,
      };
    });
    await entered.promise;
    expect(
      lifecycle.observeAdminMembership(
        lifecycle.admissionScope(chat),
        subject,
        false,
        11,
        Date.now(),
      ),
    ).toBe(true);
    read.resolve();
    expect(await pending).toBe(false);
    expect(store.list('vk', () => true)).toMatchObject([{ state: 'missing' }]);
    expect(await storage.authorization.transaction(scope, (tx) => tx.bases(subject))).toEqual([
      'creator',
      'inviter',
    ]);
    expect(
      lifecycle.observeAdminMembership(
        lifecycle.admissionScope(chat),
        subject,
        true,
        10,
        Date.now(),
      ),
    ).toBe(false);
    await lifecycle.refreshAdministration(lifecycle.admissionScope(chat), async () => ({
      observation: {
        confidence: 'confirmed',
        bot: 'present',
        members: { complete: false, ids: [subject] },
      },
      communityAdmin: true,
    }));
    expect(store.list('vk', () => true)).toMatchObject([{ state: 'missing' }]);
    expect(
      lifecycle.observeAdminMembership(
        lifecycle.admissionScope(chat),
        subject,
        true,
        12,
        Date.now(),
      ),
    ).toBe(true);
    expect(store.list('vk', () => true)).toMatchObject([{ state: 'available' }]);
  } finally {
    await storage.close();
  }
});
