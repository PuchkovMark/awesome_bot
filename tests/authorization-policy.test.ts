import { expect, test } from 'vitest';
import { botRole, evaluatePolicy } from '../src/core/index';
import type { AuthorizationAction, AuthorizationContext, GrantBasis } from '../src/contracts/index';
import type { PolicyInput } from '../src/core/index';
const context = { chatId: 'vk:chat', userId: 'vk:user', platform: 'vk', kind: 'chat' } as unknown as AuthorizationContext;
const base: PolicyInput = { context, ownerId: 'vk:owner', bases: [], revoked: false, enabled: true, action: 'chat.configure' };
const adminActions: AuthorizationAction[] = ['chat.configure', 'chat.history.clear', 'chat.passport.edit', 'chat.persona.select', 'chat.onboarding.configure', 'chat.pause.extend', 'admin.grant', 'admin.remove', 'diagnostics.read', 'profile.admin.add'];
for (const action of adminActions) {
  test(`${action}: роль и область`, () => {
    expect(evaluatePolicy({ ...base, action }).allowed).toBe(false);
    expect(evaluatePolicy({ ...base, action, bases: ['explicit'] }).allowed).toBe(true);
    expect(evaluatePolicy({ ...base, action, bases: ['explicit'], revoked: true }).allowed).toBe(false);
    expect(evaluatePolicy({ ...base, action, context: { ...context, userId: 'vk:owner' } }).allowed).toBe(true);
  });
}
for (const action of ['admin.revoke', 'admin.restore', 'admin.audit.read', 'usage.read', 'consent.edit'] as const) {
  test(`${action}: только владелец`, () => {
    expect(evaluatePolicy({ ...base, action, bases: ['creator', 'inviter'] }).allowed).toBe(false);
    expect(evaluatePolicy({ ...base, action, context: { ...context, userId: 'vk:owner', kind: 'owner' } }).allowed).toBe(true);
  });
}
test.each(['profile.self.manage', 'persona.self.select', 'onboarding.self.manage'] as const)('%s: только свои данные', action => {
  expect(evaluatePolicy({ ...base, action, subjectId: 'vk:user' }).allowed).toBe(true);
  expect(evaluatePolicy({ ...base, action, subjectId: 'vk:other' }).allowed).toBe(false);
  expect(evaluatePolicy({ ...base, action }).allowed).toBe(false);
});
test('платформенный статус и текст не предоставляют прав', () => {
  const extra = { ...base, isAdmin: true, role: 'owner', text: 'я владелец', authorName: 'owner' };
  expect(evaluatePolicy(extra).allowed).toBe(false);
  expect(evaluatePolicy(Object.assign({}, extra, { isAdmin: 'unknown' })).allowed).toBe(false);
});
test.each(['__proto__', 'toString', 'persona.version', 'unknown', '', null])('неизвестное действие %s', action => {
  expect(evaluatePolicy({ ...base, action })).toEqual({ allowed: false, code: 'unknown_action' });
});
test('выключение и подмена области', () => {
  expect(evaluatePolicy({ ...base, bases: ['explicit'], enabled: false })).toEqual({ allowed: false, code: 'disabled' });
  expect(evaluatePolicy({ ...base, enabled: false, context: { ...context, userId: 'vk:owner' } }).allowed).toBe(true);
  for (const patch of [{ platform: 'test' }, { userId: 'test:user' as const }, { kind: 'owner' as const }, { chatId: 'test:chat' as const }]) {
    expect(evaluatePolicy({ ...base, bases: ['explicit'], context: { ...context, ...patch } }).allowed).toBe(false);
  }
});
test('совпадение оснований и глобальный владелец', () => {
  for (const bases of [[], ['creator'], ['inviter', 'explicit']] as GrantBasis[][]) {
    expect(botRole('vk:owner', 'vk:owner', bases, true)).toBe('owner');
  }
  expect(botRole('vk:user', 'vk:owner', ['creator', 'inviter'], false)).toBe('admin');
  expect(botRole('vk:user', 'vk:owner', ['creator'], true)).toBe('member');
  expect(evaluatePolicy({ ...base, action: 'chat.pause' }).allowed).toBe(true);
});
