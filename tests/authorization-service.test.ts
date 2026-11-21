import { expect, test } from 'vitest';
import { createAuthorizationService } from '../src/core/index.js';
import type { AuthorizationContext } from '../src/contracts/index.js';
import { authConfig, authorizationFixture } from './helpers/authorization-fixture.js';

test('назначения, совмещение оснований и защита от обычного снятия', async () => {
  const f = await authorizationFixture(); const { service: s, storage, owner, member } = f;
  try {
    expect((await s.role(member))).toMatchObject({ allowed: true, value: 'member' });
    expect((await s.role(owner))).toMatchObject({ allowed: true, value: 'owner' });
    expect(await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:user', inviterId: 'vk:user' })).toMatchObject({ allowed: true });
    expect(await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:user', inviterId: 'vk:user' })).toMatchObject({ allowed: true });
    expect(await s.grant(owner, 'vk:user', s.confirmMembership('vk:one', 'vk:user'))).toEqual({ allowed: true, value: 'granted' });
    expect(await s.role(member)).toEqual({ allowed: true, value: 'admin' });
    for (const who of [member, owner]) expect(await s.remove(who, 'vk:user')).toEqual({ allowed: false, code: 'protected' });
    expect(await storage.authorization.transaction('vk:one', tx => tx.bases('vk:user'))).toEqual(['creator', 'explicit', 'inviter']);
    expect(await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:other' })).toEqual({ allowed: false, code: 'conflict' });
    expect(await s.applyTrustedInitialAuthorities('vk:two', { creatorId: null, inviterId: null })).toMatchObject({ allowed: true });
    const other = s.context({ chatId: 'vk:two', userId: 'vk:user' });
    expect(await s.role(other)).toEqual({ allowed: true, value: 'member' });
  } finally { s.dispose(); await storage.close(); }
});

test('снятие прав и выключение после предварительной проверки блокируют запись', async () => {
  const { storage, service: s, owner, member } = await authorizationFixture();
  try {
    const proof = s.confirmMembership('vk:one', 'vk:user');
    expect(await s.grant(member, 'vk:user', proof)).toMatchObject({ allowed: false });
    await s.grant(owner, 'vk:user', proof);
    expect((await s.check(member, 'admin.grant')).allowed).toBe(true);
    await s.remove(owner, 'vk:user');
    expect((await s.grant(member, 'vk:other', s.confirmMembership('vk:one', 'vk:other'))).allowed).toBe(false);
    expect(await storage.authorization.transaction('vk:one', tx => tx.bases('vk:other'))).toEqual([]);
    await s.grant(owner, 'vk:user', proof);
    expect((await s.check(member, 'admin.grant')).allowed).toBe(true);
    await storage.chats.update('vk:one', { enabled: false });
    expect(await s.grant(member, 'vk:other', s.confirmMembership('vk:one', 'vk:other'))).toEqual({ allowed: false, code: 'disabled' });
    expect((await s.grant(owner, 'vk:other', s.confirmMembership('vk:one', 'vk:other'))).allowed).toBe(true);
  } finally { s.dispose(); await storage.close(); }
});

test('личность и принадлежность участника не подменяются данными модели или другого сервиса', async () => {
  const { storage, service: s, owner } = await authorizationFixture();
  try {
    const fake = { ...owner } as AuthorizationContext;
    expect(await s.check(fake, 'admin.grant')).toEqual({ allowed: false, code: 'invalid_context' });
    expect(Object.isFrozen(owner)).toBe(true);
    const other = await createAuthorizationService({ config: authConfig, store: storage.authorization });
    expect(await s.check(other.context({ chatId: 'vk:one', userId: 'vk:owner', kind: 'owner' }), 'admin.grant')).toEqual({ allowed: false, code: 'invalid_context' });
    for (const proof of [{}, null, s.confirmMembership('vk:two', 'vk:user'), s.confirmMembership('vk:one', 'vk:other'), other.confirmMembership('vk:one', 'vk:user')]) {
      expect(await s.grant(owner, 'vk:user', proof)).toEqual({ allowed: false, code: 'unconfirmed_member' });
    }
    expect(await s.grant(owner, 'test:user', {})).toEqual({ allowed: false, code: 'wrong_scope' });
    expect(() => s.context({ chatId: 'vk:one', userId: 'vk:user', kind: 'owner' })).toThrow('invalid_context');
    expect(() => s.context({ chatId: 'test:one', userId: 'vk:user' })).toThrow('invalid_context');
    expect((await s.check(s.context({ chatId: 'test:one', userId: 'vk:owner', kind: 'owner' }), 'diagnostics.read')).allowed).toBe(true);
    expect(await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'test:user' })).toEqual({ allowed: false, code: 'wrong_scope' });
    other.dispose();
  } finally { s.dispose(); await storage.close(); }
});
