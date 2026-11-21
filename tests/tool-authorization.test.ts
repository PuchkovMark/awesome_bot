import { scopeFor, scopeForService } from './helpers/connection-scope.js';
import { expect, test } from 'vitest';
import type { ToolContext, UserId, AuthorizationContext } from '../src/contracts/index.js';
import { toolAuthorization } from '../src/tools/index.js';
import { FakeAdapter } from './helpers/fake-adapters.js';
import { authorizationFixture } from './helpers/authorization-fixture.js';

// Только тестовый инструмент. Ни isAdmin, ни параметры модели не являются источником роли/области.
async function fixture() {
  const f = await authorizationFixture(); const s = f.service;
  await f.storage.scoped.chats.create(scopeFor(f.storage, 'test-a:one'), { responseMode: 'mention', enabled: true, createdAt: 0 });
  const owner = s.context({ scope: scopeForService(s, 'test-a:one'), userId: 'vk:owner', kind: 'owner' });
  const authorization = s.context({ scope: scopeForService(s, 'test-a:one'), userId: 'test-a:admin' });
  const context: ToolContext = { chatId: 'test-a:one', platform: 'test-a', userId: 'test-a:admin', isAdmin: true, adapter: new FakeAdapter('test-a'), authorization };
  const membership = await s.confirmMembership(scopeForService(s, 'test-a:one'), 'test-a:new');
  const execute = async (parameters: { userId: UserId }, ctx: ToolContext) => {
    const validated = toolAuthorization(ctx);
    return validated.allowed ? s.grant(validated.value, parameters.userId, membership) : validated;
  };
  const bases = () => f.storage.scoped.authorization.transaction(scopeFor(f.storage, 'test-a:one'), tx => tx.bases('test-a:new'));
  return { ...f, s, owner, context, authorization, execute, bases };
}

test('прямой вызов инструмента проверяет права независимо от предварительного допуска', async () => {
  const f = await fixture();
  try {
    expect(await f.execute({ userId: 'test-a:new' }, f.context)).toEqual({ allowed: false, code: 'forbidden' });
    expect(await f.bases()).toEqual([]);
    await f.s.grant(f.owner, 'test-a:admin', await f.s.confirmMembership(scopeForService(f.s, 'test-a:one'), 'test-a:admin'));
    expect(await f.execute({ userId: 'test-a:new' }, f.context)).toMatchObject({ allowed: true });
    expect(await f.bases()).toEqual(['explicit']);
  } finally { await f.close(); }
});

test('снятие и отзыв после допуска запрещают побочный эффект в БД', async () => {
  const f = await fixture();
  try {
    await f.s.grant(f.owner, 'test-a:admin', await f.s.confirmMembership(scopeForService(f.s, 'test-a:one'), 'test-a:admin'));
    expect((await f.s.check(f.authorization, 'admin.grant')).allowed).toBe(true);
    await f.s.remove(f.owner, 'test-a:admin');
    expect((await f.execute({ userId: 'test-a:new' }, f.context)).allowed).toBe(false);
    await f.s.applyTrustedInitialAuthorities(scopeForService(f.s, 'test-a:one'), { creatorId: 'test-a:admin' });
    expect((await f.s.check(f.authorization, 'admin.grant')).allowed).toBe(true);
    await f.s.revoke(f.owner, 'test-a:admin', 'reason');
    expect((await f.execute({ userId: 'test-a:new' }, f.context)).allowed).toBe(false);
    expect(await f.bases()).toEqual([]);
  } finally { await f.close(); }
});

test('подделки и несогласованная область инструмента не изменяют данные', async () => {
  const f = await fixture();
  try {
    await f.s.grant(f.owner, 'test-a:admin', await f.s.confirmMembership(scopeForService(f.s, 'test-a:one'), 'test-a:admin'));
    const { authorization, ...missing } = f.context;
    const forged = { ...authorization } as AuthorizationContext;
    const other = await authorizationFixture();
    try {
      const contexts: ToolContext[] = [missing,
        { ...f.context, authorization: forged },
        { ...f.context, authorization: other.service.context({ scope: scopeForService(other.service, 'test-a:one'), userId: 'test-a:admin' }) },
        { ...f.context, userId: 'test-a:other' }, { ...f.context, chatId: 'test-a:two' },
        { ...f.context, platform: 'test-b' }, { ...f.context, adapter: new FakeAdapter('test-b') },
        { ...f.context, authorization: f.owner },
      ];
      for (const context of contexts) expect((await f.execute({ userId: 'test-a:new' }, context)).allowed).toBe(false);
      expect((await f.execute({ userId: 'test-b:new' }, f.context)).allowed).toBe(false);
      expect(await f.bases()).toEqual([]);
    } finally { await other.close(); }
  } finally { await f.close(); }
});
