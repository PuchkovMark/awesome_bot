import { createAuthorizationService, scopeForService, scopeFor } from './helpers/connection-scope';
import { expect, test } from 'vitest';

import type { AuthorizationContext } from '../src/contracts/index';
import { authConfig, authorizationFixture } from './helpers/authorization-fixture';

test('учитывает событие изменения прав в исходном диалоге и проверяет доказательство в текущей области', async () => {
  const f = await authorizationFixture();
  const { service, storage, owner, member } = f;
  const subject = 'vk:other' as const;
  const other = scopeFor(storage, 'vk:two');
  const incoming = { sourceChatId: member.chatId, messageId: 15, timestamp: 100 };
  const direct = { ...incoming, sourceChatId: owner.userId };
  const current = () => true;
  const remove = { kind: 'remove', userId: subject } as const;
  try {
    const grant = async (scope = member.scope) => ({
      kind: 'grant' as const,
      userId: subject,
      membership: await service.confirmMembership(scope, subject),
    });
    const stale = await grant();
    expect(await service.executeAdminCommand(member, stale, incoming, current)).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    await service.grant(
      owner,
      member.userId,
      await service.confirmMembership(member.scope, member.userId),
    );
    expect(await service.executeAdminCommand(member, stale, incoming, current)).toEqual({
      allowed: false,
      code: 'unconfirmed_member',
    });
    expect(
      await service.executeAdminCommand(member, await grant(other), incoming, current),
    ).toEqual({
      allowed: false,
      code: 'unconfirmed_member',
    });
    expect(await service.executeAdminCommand(member, await grant(), direct, current)).toEqual({
      allowed: false,
      code: 'wrong_scope',
    });
    expect(await service.executeAdminCommand(member, await grant(), incoming, () => false)).toEqual(
      {
        allowed: false,
        code: 'conflict',
      },
    );
    const previous = await storage.authorization.transaction(member.scope, (tx) => tx.revision());
    expect(await service.executeAdminCommand(member, await grant(), incoming, current)).toEqual({
      allowed: true,
      value: { status: 'granted', revision: previous + 1 },
    });
    const otherOwner = service.context({ scope: other, kind: 'owner', userId: owner.userId });
    expect(
      await service.executeAdminCommand(otherOwner, await grant(other), direct, current),
    ).toMatchObject({
      value: { status: 'granted' },
    });
    expect(await service.executeAdminCommand(owner, remove, direct, current)).toEqual({
      allowed: true,
      value: { status: 'removed', revision: previous + 2 },
    });
    expect(await service.executeAdminCommand(member, await grant(), incoming, current)).toEqual({
      allowed: true,
      value: { status: 'duplicate', revision: previous + 2 },
    });
    expect(
      await storage.authorization.transaction(member.scope, (tx) => tx.bases(subject)),
    ).toEqual([]);
    expect(await storage.authorization.transaction(other, (tx) => tx.bases(subject))).toEqual([
      'explicit',
    ]);
  } finally {
    await f.close();
  }
});

test('назначения, совмещение оснований и защита от обычного снятия', async () => {
  const f = await authorizationFixture();
  const { service: s, storage, owner, member } = f;
  try {
    expect(await s.role(member)).toMatchObject({ allowed: true, value: 'member' });
    expect(await s.role(owner)).toMatchObject({ allowed: true, value: 'owner' });
    expect(
      await s.applyTrustedInitialAuthorities(scopeForService(s, 'vk:one'), {
        creatorId: 'vk:user',
        inviterId: 'vk:user',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      await s.applyTrustedInitialAuthorities(scopeForService(s, 'vk:one'), {
        creatorId: 'vk:user',
        inviterId: 'vk:user',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      await s.grant(
        owner,
        'vk:user',
        await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:user'),
      ),
    ).toEqual({ allowed: true, value: 'granted' });
    expect(await s.role(member)).toEqual({ allowed: true, value: 'admin' });
    for (const who of [member, owner])
      expect(await s.remove(who, 'vk:user')).toEqual({ allowed: false, code: 'protected' });
    expect(
      await storage.authorization.transaction(scopeFor(storage, 'vk:one'), (tx) =>
        tx.bases('vk:user'),
      ),
    ).toEqual(['creator', 'explicit', 'inviter']);
    expect(
      await s.applyTrustedInitialAuthorities(scopeForService(s, 'vk:one'), {
        creatorId: 'vk:other',
      }),
    ).toEqual({ allowed: false, code: 'conflict' });
    expect(
      await s.applyTrustedInitialAuthorities(scopeForService(s, 'vk:two'), {
        creatorId: null,
        inviterId: null,
      }),
    ).toMatchObject({ allowed: true });
    const other = s.context({ scope: scopeForService(s, 'vk:two'), userId: 'vk:user' });
    expect(await s.role(other)).toEqual({ allowed: true, value: 'member' });
  } finally {
    s.dispose();
    await storage.close();
  }
});

test('снятие прав и выключение после предварительной проверки блокируют запись', async () => {
  const { storage, service: s, owner, member } = await authorizationFixture();
  try {
    const proof = await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:user');
    expect(await s.grant(member, 'vk:user', proof)).toMatchObject({ allowed: false });
    await s.grant(
      owner,
      'vk:user',
      await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:user'),
    );
    expect((await s.check(member, 'admin.grant')).allowed).toBe(true);
    await s.remove(owner, 'vk:user');
    expect(
      (
        await s.grant(
          member,
          'vk:other',
          await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:other'),
        )
      ).allowed,
    ).toBe(false);
    expect(
      await storage.authorization.transaction(scopeFor(storage, 'vk:one'), (tx) =>
        tx.bases('vk:other'),
      ),
    ).toEqual([]);
    await s.grant(
      owner,
      'vk:user',
      await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:user'),
    );
    expect((await s.check(member, 'admin.grant')).allowed).toBe(true);
    await storage.chats.update(scopeFor(storage, 'vk:one'), { enabled: false });
    expect(
      await s.grant(
        member,
        'vk:other',
        await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:other'),
      ),
    ).toEqual({ allowed: false, code: 'disabled' });
    expect(
      (
        await s.grant(
          owner,
          'vk:other',
          await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:other'),
        )
      ).allowed,
    ).toBe(true);
  } finally {
    s.dispose();
    await storage.close();
  }
});

test('личность и принадлежность участника не подменяются данными модели или другого сервиса', async () => {
  const { storage, service: s, owner } = await authorizationFixture();
  try {
    const fake = { ...owner } as AuthorizationContext;
    expect(await s.check(fake, 'admin.grant')).toEqual({ allowed: false, code: 'invalid_context' });
    expect(Object.isFrozen(owner)).toBe(true);
    const other = await createAuthorizationService({
      config: authConfig,
      store: storage.authorization,
    });
    expect(
      await s.check(
        other.context({
          scope: scopeForService(other, 'vk:one'),
          userId: 'vk:owner',
          kind: 'owner',
        }),
        'admin.grant',
      ),
    ).toEqual({ allowed: false, code: 'invalid_context' });
    for (const proof of [
      {},
      null,
      await s.confirmMembership(scopeForService(s, 'vk:two'), 'vk:user'),
      await s.confirmMembership(scopeForService(s, 'vk:one'), 'vk:other'),
      await other.confirmMembership(scopeForService(other, 'vk:one'), 'vk:user'),
    ]) {
      expect(await s.grant(owner, 'vk:user', proof)).toEqual({
        allowed: false,
        code: 'unconfirmed_member',
      });
    }
    expect(await s.grant(owner, 'test:user', {})).toEqual({ allowed: false, code: 'wrong_scope' });
    expect(() =>
      s.context({ scope: scopeForService(s, 'vk:one'), userId: 'vk:user', kind: 'owner' }),
    ).toThrow('invalid_context');
    expect(() => s.context({ scope: scopeForService(s, 'test:one'), userId: 'vk:user' })).toThrow(
      'invalid_context',
    );
    expect(
      (
        await s.check(
          s.context({ scope: scopeForService(s, 'test:one'), userId: 'vk:owner', kind: 'owner' }),
          'diagnostics.read',
        )
      ).allowed,
    ).toBe(true);
    expect(
      await s.applyTrustedInitialAuthorities(scopeForService(s, 'vk:one'), {
        creatorId: 'test:user',
      }),
    ).toEqual({ allowed: false, code: 'wrong_scope' });
    other.dispose();
  } finally {
    s.dispose();
    await storage.close();
  }
});
