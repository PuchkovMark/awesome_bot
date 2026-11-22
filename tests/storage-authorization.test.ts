import { openStorage, scopeFor } from './helpers/connection-scope.js';
import { expect, test } from 'vitest';

import type { AuthorizationTransaction } from '../src/storage/index.js';
import { openConnection } from '../src/storage/connection.js';
import { migrate } from '../src/storage/migrate.js';
import { migrations } from '../src/storage/migrations/index.js';
import { participantFixture } from './helpers/participant-fixture.js';
import { storageFixture } from './helpers/storage-fixture.js';

async function memory() {
  const s = await openStorage(':memory:');
  await s.chats.create(scopeFor(s, 'vk:one'), { responseMode: 'normal', enabled: true, createdAt: 0 });
  await s.chats.create(scopeFor(s, 'vk:two'), { responseMode: 'active', enabled: false, createdAt: 0 });
  return s;
}
const grant = { userId: 'vk:user', basis: 'creator', grantedAt: 10, grantedBy: null } as const;
const audit = { userId: 'vk:user', revokedBy: 'vk:owner', revokedAt: 20, bases: ['creator', 'explicit'], reason: 'Причина 🐈' } as const;

test('назначения изолированы, повтор не дублирует, защищённое основание уникально', async () => {
  const s = await memory();
  try {
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => {
      tx.grant(grant); tx.grant(grant); tx.grant({ ...grant, basis: 'explicit' });
      expect(tx.bases('vk:user')).toEqual(['creator', 'explicit']);
      expect(tx.settings()).toEqual({ enabled: true });
    });
    expect(await s.authorization.transaction(scopeFor(s, 'vk:two'), tx => tx.bases('vk:user'))).toEqual([]);
    await expect(s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.grant({ ...grant, userId: 'vk:other' }))).rejects.toMatchObject({ code: 'operation_failed' });
    await expect(s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.grant({ ...grant, userId: 'test:user' }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(s.authorization.transaction(scopeFor(s, 'vk:absent'), tx => tx.grant(grant))).rejects.toMatchObject({ code: 'operation_failed' });
  } finally { await s.close(); }
});

test('ошибка откатывает все записи, контекст транзакции нельзя использовать после выхода', async () => {
  const s = await memory(); let escaped: AuthorizationTransaction | undefined;
  try {
    await expect(s.authorization.transaction(scopeFor(s, 'vk:one'), tx => { tx.grant(grant); throw new Error('секрет SQL'); })).rejects.toMatchObject({ code: 'operation_failed' });
    expect(await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.bases('vk:user'))).toEqual([]);
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => { escaped = tx; });
    expect(() => escaped?.grant(grant)).toThrow('invalid_input');
    await expect(s.authorization.transaction(scopeFor(s, 'vk:one'), tx => { tx.grant(grant); return Promise.resolve(1); })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.bases('vk:user'))).toEqual([]);
  } finally { await s.close(); }
});

test('аудит, отзыв и запрет атомарны, истечение убирает только причину, отмена сохраняет запрет', async () => {
  const s = await memory();
  try {
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => { tx.grant(grant); tx.grant({ ...grant, basis: 'explicit' }); tx.revoke(audit); });
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => {
      expect(tx.bases('vk:user')).toEqual([]); expect(tx.isRevoked('vk:user')).toBe(true);
      expect(tx.recoveryBlocked()).toBe(true); expect(tx.audit('vk:user')).toEqual({ ...audit, chatId: 'vk:one' });
    });
    expect(await s.authorization.pruneReasons(29, 10)).toEqual({ cleared: 0, nextRevokedAt: 20 });
    expect(await s.authorization.pruneReasons(30, 10)).toEqual({ cleared: 1, nextRevokedAt: null });
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => {
      expect(tx.audit('vk:user')).toEqual({ ...audit, chatId: 'vk:one', reason: null });
      tx.restore('vk:user'); expect(tx.audit('vk:user')).toBeNull(); expect(tx.isRevoked('vk:user')).toBe(false);
      expect(tx.recoveryBlocked()).toBe(true); expect(tx.bases('vk:user')).toEqual([]);
    });
    expect(await s.authorization.transaction(scopeFor(s, 'vk:two'), tx => tx.recoveryBlocked())).toBe(false);
  } finally { await s.close(); }
});

test('ошибка вставки аудита не оставляет отдельного отзыва', async () => {
  const s = await memory();
  try {
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.grant(grant));
    await expect(s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.revoke({ ...audit, bases: ['explicit'] }))).rejects.toMatchObject({ code: 'operation_failed' });
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => {
      expect(tx.bases('vk:user')).toEqual(['creator']); expect(tx.isRevoked('vk:user')).toBe(false);
      expect(tx.audit('vk:user')).toBeNull(); expect(tx.recoveryBlocked()).toBe(false);
    });
  } finally { await s.close(); }
});

test('версия 3 → 4 сохраняет данные и метаданные, не создаёт назначений из платформенной роли', async () => {
  const f = storageFixture();
  const seed = await openConnection(f.path, db => migrate(db, migrations.slice(0, 3)));
  const before = seed.run(db => {
    db.exec("INSERT INTO chats VALUES ('vk:one','title','prompt','always','UTC',0,0)");
    db.exec("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:one','1','vk:user','','user','старыйкот',0)");
    const pf = participantFixture(db); pf.participant('vk:one', 'vk:user', { role: 'admin' }); pf.profile('vk:one', 'vk:user'); pf.fact('vk:one', 'vk:user');
    return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  }); seed.close();
  try {
    let s = await openStorage(f.path);
    expect(await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.bases('vk:user'))).toEqual([]);
    expect(await s.chats.get(scopeFor(s, 'vk:one'))).toMatchObject({ responseMode: 'normal', enabled: false });
    await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => { tx.grant(grant); tx.revoke(audit); });
    await s.close(); s = await openStorage(f.path);
    try {
      expect(await s.authorization.transaction(scopeFor(s, 'vk:one'), tx => tx.audit('vk:user'))).toEqual({ ...audit, chatId: 'vk:one' });
      expect(await s.messages.append(scopeFor(s, ({ chatId: 'vk:one', userId: 'vk:user', messageId: '1', authorName: '', role: 'user', text: 'другой', timestamp: 1 }).chatId), { chatId: 'vk:one', userId: 'vk:user', messageId: '1', authorName: '', role: 'user', text: 'другой', timestamp: 1 })).toMatchObject({ status: 'duplicate' });
      const inspect = await openConnection(f.path);
      try { inspect.run(db => {
        expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=3 ORDER BY version').all()).toEqual(before);
        expect(db.prepare('SELECT value FROM profile_facts').all()).toHaveLength(1);
        expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'старыйкот'").all()).toHaveLength(1);
        expect(db.pragma('foreign_key_check')).toEqual([]);
      }); } finally { inspect.close(); }
    } finally { await s.close(); }
  } finally { f.cleanup(); }
});
