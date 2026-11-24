import { join } from 'node:path';
import { expect, test } from 'vitest';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { createSnapshot, openExisting, openCandidate } from '../src/storage/database-backup';
import { reconcileConnections } from '../src/storage/database-restore';
import { profileFixture, alice, set } from './helpers/profile-fact-fixture';
import { reconcileRestore } from '../src/storage/backup-history';
import { personalDataStore } from '../src/storage/personal-data-store';

test('сброшенное поколение исключено, отзыв действует, вторая беседа сохраняет историю', async () => {
  const f = storageFixture(),
    storage = await openStorage(f.path);
  try {
    const first = scopeFor(storage, 'vk:a'),
      keep = scopeFor(storage, 'vk:b');
    for (const scope of [first, keep]) {
      await storage.chats.create(scope, { createdAt: 1, enabled: true, responseMode: 'normal' });
      await storage.messages.append(scope, {
        chatId: scope.chatId,
        messageId: '1',
        userId: 'vk:u',
        authorName: '',
        role: 'user',
        text: scope.chatId,
        timestamp: 1,
      });
    }
    const writer = openExisting(f.path, false);
    writer
      .prepare(
        "INSERT INTO bot_admin_grants(chat_id,user_id,basis,granted_at,granted_by) VALUES('vk:b','vk:u','explicit',1,'vk:o')",
      )
      .run();
    writer
      .prepare(
        "INSERT INTO paused_reset_requests(code,owner_id,event_id,chat_id,generation,revision,send_id,state,receipt,expires_at) VALUES('old','vk:o',7,?, ?,0,9,'ready',10,900010)",
      )
      .run(first.chatId, first.generation);
    writer.close();
    const source = openExisting(f.path);
    const saved = join(f.directory, 'saved'),
      temp = join(f.directory, 'candidate');
    try {
      await createSnapshot(source, saved, 'one', 10);
      await openCandidate(saved, temp, 'one', 11);
      lifecycleBackend(storage).ownerDecision(lifecycleBackend(storage).begin(first.chatId), 'new');
      const admin = openExisting(f.path, false);
      admin.exec(
        "DELETE FROM bot_admin_grants WHERE chat_id='vk:b'; INSERT INTO bot_admin_revocations VALUES('vk:b','vk:u','vk:o',12); INSERT INTO bot_admin_controls VALUES('vk:b',1)",
      );
      admin.close();
      const staged = openExisting(temp, false);
      try {
        const reconcile = source.transaction(() =>
          staged.transaction(() => reconcileConnections(staged, source))(),
        );
        expect(reconcile()).toEqual({ access: 'partial', admitted: 1, closed: 1 });
        expect(
          staged.prepare("SELECT state FROM paused_reset_requests WHERE code='old'").pluck().get(),
        ).toBe('closed');
        expect(reconcile()).toEqual({ access: 'partial', admitted: 1, closed: 1 });
        expect(staged.prepare('SELECT text FROM messages').pluck().all()).toEqual(['vk:b']);
        expect(staged.prepare('SELECT count(*) FROM bot_admin_grants').pluck().get()).toBe(0);
        expect(staged.prepare('SELECT user_id FROM active_admin_denials').pluck().all()).toEqual([
          'vk:u',
        ]);
        expect(
          staged.prepare('SELECT value FROM lifecycle_clock').pluck().get(),
        ).toBeGreaterThanOrEqual(
          source.prepare('SELECT value FROM lifecycle_clock').pluck().get() as number,
        );
        const ownCopy = openExisting(saved);
        try {
          expect(() =>
            ownCopy.transaction(() =>
              staged.transaction(() => reconcileConnections(staged, ownCopy))(),
            )(),
          ).toThrow('untrusted_source');
        } finally {
          ownCopy.close();
        }
      } finally {
        staged.close();
      }
    } finally {
      source.close();
    }
  } finally {
    await storage.close();
    f.cleanup();
  }
});

test('очистка без личного удаления, свежий срок и личное удаление применяются до поиска и выгрузки', async () => {
  const f = storageFixture(),
    app = await openStorage(f.path),
    now = Date.now(),
    day = 86_400_000;
  try {
    const a = scopeFor(app, 'vk:a'),
      b = scopeFor(app, 'vk:b');
    for (const scope of [a, b])
      await app.chats.create(scope, { createdAt: now, enabled: true, responseMode: 'normal' });
    const input = (
      chatId: typeof a.chatId,
      messageId: string,
      text: string,
      timestamp = now,
      userId: 'vk:1' | 'vk:2' = 'vk:1',
    ) => ({ chatId, messageId, userId, authorName: '', text, role: 'user' as const, timestamp });
    await app.messages.append(a, input(a.chatId, '1', 'очищено'));
    await app.messages.append(b, input(b.chatId, '2', 'удалено'));
    await app.messages.append(b, input(b.chatId, '3', 'доступно', now, 'vk:2'));
    await app.messages.append(b, input(b.chatId, '4', 'просрочено', now - 12 * day, 'vk:2'));
    const latest = openExisting(f.path);
    const snapshot = join(f.directory, 'saved'),
      candidate = join(f.directory, 'candidate');
    try {
      await createSnapshot(latest, snapshot, 'local', now);
      const after = await app.messages.append(a, input(a.chatId, '5', 'после снимка'));
      const control = openExisting(f.path, false);
      control
        .prepare(
          'INSERT INTO history_retention_boundaries(chat_id,generation,cleared_through) VALUES (?,?,?)',
        )
        .run(a.chatId, a.generation, after.id);
      control.prepare('INSERT OR REPLACE INTO history_retention_policy VALUES (1,?)').run(10 * day);
      control.close();
      const pd = personalDataStore(app);
      const request = pd.requestDeletion(b, 'vk:1', 'operation', now);
      expect(pd.confirmDeletion(b, 'vk:1', request.code, now + 1)).toBe(true);
      await openCandidate(snapshot, candidate, 'local', now + 2);
      const staged = openExisting(candidate, false);
      try {
        for (let attempt = 0; attempt < 2; attempt++)
          expect(reconcileRestore(staged, latest, now + 2, 30 * day).access).toBe('full');
      } finally {
        staged.close();
      }
      const restored = await openStorage(candidate);
      try {
        const ca = scopeFor(restored, 'vk:a'),
          cb = scopeFor(restored, 'vk:b');
        expect(await restored.contextMessages.search(ca, 'очищено', 4, 256)).toEqual([]);
        expect(await restored.contextMessages.search(cb, 'удалено', 4, 256)).toEqual([]);
        expect(await restored.messages.list(cb, { limit: 10 })).toMatchObject([
          { text: 'доступно' },
        ]);
        expect(personalDataStore(restored).export(cb, 'vk:1', now + 2).messages).toEqual([]);
        const fresh = await restored.messages.append(ca, input(ca.chatId, '6', 'новое', now + 3));
        expect(fresh.id).toBeGreaterThan(after.id);
        expect(await restored.contextMessages.search(ca, 'новое', 4, 256)).toHaveLength(1);
      } finally {
        await restored.close();
      }
    } finally {
      latest.close();
    }
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('личное ограничение видимости обычного поля после снимка переживает восстановление', async () => {
  const f = await profileFixture(),
    newer = openExisting(f.path),
    now = Date.now();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const original = await f.message(scope, alice, '101', now);
    expect(await f.change(scope, alice, alice, original, set('city', 'Пермь'))).toMatchObject({
      value: 'recorded',
    });
    const saved = f.path + '.backup',
      candidate = f.path + '.stage';
    await createSnapshot(newer, saved, 'one', now);
    const update = await f.message(scope, alice, '102', now + 1);
    expect(
      await f.change(scope, alice, alice, update, {
        kind: 'visibility',
        fieldKey: 'city',
        visibility: 'bot',
      }),
    ).toMatchObject({ value: 'recorded' });
    await openCandidate(saved, candidate, 'one', now + 2);
    const staged = openExisting(candidate, false);
    try {
      expect(reconcileRestore(staged, newer, now + 2, 30 * 86400000).access).toBe('full');
    } finally {
      staged.close();
    }
    const app = await openStorage(candidate);
    try {
      const subject = scopeFor(app, scope.chatId);
      expect(
        await app.authorization.transaction(subject, (tx) => tx.readOwnProfile(alice, now + 2)),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: 'Пермь', visibility: 'bot' })]),
      );
    } finally {
      await app.close();
    }
  } finally {
    newer.close();
    await f.close();
  }
});
