import { expect, test } from 'vitest';
import { createAuthorizationService } from '../src/core/index.js';
import { authConfig, authorizationFixture } from './helpers/authorization-fixture.js';

test('отзыв снимает все основания, сохраняет запрет и не обходится синхронизацией', async () => {
  let time = 100;
  const f = await authorizationFixture({ now: () => time });
  const { service: s, storage, owner, member } = f;
  try {
    await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:user', inviterId: 'vk:user' });
    const proof = s.confirmMembership('vk:one', 'vk:user');
    await s.grant(owner, 'vk:user', proof);
    expect(await s.revoke(member, 'vk:user', 'private')).toEqual({ allowed: false, code: 'wrong_scope' });
    expect(await s.revoke(owner, 'vk:user', 'private')).toEqual({ allowed: true, value: 'revoked' });
    expect(await s.role(member)).toEqual({ allowed: true, value: 'member' });
    expect(await s.grant(owner, 'vk:user', proof)).toEqual({ allowed: false, code: 'revoked' });
    await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:user', inviterId: 'vk:user' });
    expect(await storage.authorization.transaction('vk:one', tx => tx.bases('vk:user'))).toEqual([]);
    time++;
    expect(await s.revoke(owner, 'vk:user', 'replacement')).toEqual({ allowed: true, value: 'existing' });
    expect(await s.audit(owner, 'vk:user')).toMatchObject({ allowed: true, value: { reason: 'private', revokedAt: 100, bases: ['creator', 'inviter', 'explicit'] } });
    expect(await s.audit(member, 'vk:user')).toEqual({ allowed: false, code: 'wrong_scope' });
    expect(await s.restore(member, 'vk:user')).toEqual({ allowed: false, code: 'wrong_scope' });
    expect(await s.restore(owner, 'vk:user')).toMatchObject({ allowed: true });
    expect(await s.audit(owner, 'vk:user')).toEqual({ allowed: true, value: null });
    expect(await storage.authorization.transaction('vk:one', tx => ({ blocked: tx.recoveryBlocked(), revoked: tx.isRevoked('vk:user'), bases: tx.bases('vk:user') }))).toEqual({ blocked: true, revoked: false, bases: [] });
    expect(await s.grant(owner, 'vk:user', proof)).toMatchObject({ allowed: true });
    expect(await s.revoke(owner, 'vk:user', 'reason')).toEqual({ allowed: false, code: 'conflict' });
    expect(JSON.stringify(member)).not.toContain('private');
  } finally { await f.close(); }
});

test('причина обязательна, длина в code points проверяется до записи без обрезки', async () => {
  const f = await authorizationFixture({ config: { ...authConfig, reasonMaxLength: 2 } });
  try {
    const { service: s, owner } = f;
    await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:user' });
    for (const reason of ['', ' \n\t', null, undefined, 123]) expect(await s.revoke(owner, 'vk:user', reason)).toEqual({ allowed: false, code: 'invalid_reason' });
    expect(await s.revoke(owner, 'vk:user', '😀😀😀')).toEqual({ allowed: false, code: 'reason_too_long' });
    expect(await s.audit(owner, 'vk:user')).toEqual({ allowed: true, value: null });
    expect(await s.revoke(owner, 'vk:user', '😀😀')).toMatchObject({ allowed: true });
    expect(await s.audit(owner, 'vk:user')).toMatchObject({ value: { reason: '😀😀' } });
    await s.applyTrustedInitialAuthorities('vk:two', { creatorId: 'vk:owner' });
    const targetOwner = s.context({ chatId: 'vk:two', userId: 'vk:owner', kind: 'owner' });
    await s.revoke(targetOwner, 'vk:owner', 'ok');
    expect(await s.role(targetOwner)).toEqual({ allowed: true, value: 'owner' });
  } finally { await f.close(); }
});

test('срок очищает только причину на границе, таймер освобождается, новый конфиг не воскрешает текст', async () => {
  let time = 100;
  let callback: (() => void) | undefined;
  const scheduled = new Set<() => void>();
  const scheduler = { schedule(delay: number, run: () => void) {
    expect(delay).toBeGreaterThanOrEqual(0); callback = run; scheduled.add(run);
    return () => { scheduled.delete(run); };
  } };
  const f = await authorizationFixture({ now: () => time, scheduler });
  const { service: s, owner, storage } = f;
  try {
    await s.applyTrustedInitialAuthorities('vk:one', { creatorId: 'vk:user' });
    await s.revoke(owner, 'vk:user', 'secret');
    time += 90 * 86_400_000 - 1;
    expect(await s.audit(owner, 'vk:user')).toMatchObject({ value: { reason: 'secret' } });
    expect(scheduled.size).toBe(1);
    time++;
    callback!();
    // Обслуживание использует синхронный SQLite внутри async-границы.
    await s.maintain();
    expect(await s.audit(owner, 'vk:user')).toMatchObject({ value: { reason: null, revokedAt: 100, revokedBy: 'vk:owner', bases: ['creator'] } });
    expect(scheduled.size).toBe(0);
    s.dispose();
    const reopened = await createAuthorizationService({ config: { ...authConfig, reasonRetentionDays: 180 }, store: storage.authorization, now: () => time, scheduler });
    try {
      const context = reopened.context({ chatId: 'vk:one', userId: 'vk:owner', kind: 'owner' });
      expect(await reopened.audit(context, 'vk:user')).toMatchObject({ value: { reason: null } });
      expect(await storage.authorization.transaction('vk:one', tx => tx.recoveryBlocked())).toBe(true);
      await reopened.applyTrustedInitialAuthorities('vk:two', { creatorId: 'vk:other' });
      await reopened.revoke(reopened.context({ chatId: 'vk:two', userId: 'vk:owner', kind: 'owner' }), 'vk:other', 'new');
      expect(scheduled.size).toBe(1);
    } finally { reopened.dispose(); }
    expect(scheduled.size).toBe(0);
  } finally { await f.close(); }
});

test('уменьшение срока применяется при запуске; ошибка обслуживания безопасна и доступна для повтора', async () => {
  let time = 100;
  const f = await authorizationFixture({ now: () => time });
  const { service: s, owner, storage } = f;
  try {
    await s.applyTrustedInitialAuthorities('vk:one', { inviterId: 'vk:user' });
    await s.revoke(owner, 'vk:user', 'private'); s.dispose();
    time += 2 * 86_400_000;
    let broken = false;
    const store = { ...storage.authorization, async pruneReasons(now: number, retention: number) {
      if (broken) throw new Error('private driver error');
      return storage.authorization.pruneReasons(now, retention);
    } };
    const next = await createAuthorizationService({ config: { ...authConfig, reasonRetentionDays: 1 }, store, now: () => time });
    try {
      const context = next.context({ chatId: 'vk:one', userId: 'vk:owner', kind: 'owner' });
      expect(await next.audit(context, 'vk:user')).toMatchObject({ value: { reason: null } });
      broken = true;
      await expect(next.maintain()).rejects.toThrow(/^Authorization: maintenance_failed$/);
      expect(next.maintenanceStatus().error).toBe('maintenance_failed');
      await expect(next.audit(context, 'vk:user')).rejects.toThrow(/^Authorization: maintenance_failed$/);
      broken = false; await next.maintain(); expect(next.maintenanceStatus().error).toBeNull();
    } finally { next.dispose(); }
  } finally { await f.close(); }
});
