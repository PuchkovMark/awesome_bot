import { join } from 'node:path';
import { expect, test } from 'vitest';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { createSnapshot, openExisting, openCandidate } from '../src/storage/database-backup';
import { reconcileConnections } from '../src/storage/database-restore';

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
        expect(
          source.transaction(() =>
            staged.transaction(() => reconcileConnections(staged, source))(),
          )(),
        ).toEqual({ access: 'partial', admitted: 1, closed: 1 });
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
