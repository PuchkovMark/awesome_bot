import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createAuthorizationService, createLifecycleService } from '../src/core/index';
import { adminRecoveryStore } from '../src/storage/admin-recovery-store';
import { openStorage } from '../src/storage/index';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { storageFixture } from './helpers/storage-fixture';

const chat = 'vk:2000000010',
  other = 'vk:2000000011',
  ownerId = 'vk:1',
  userId = 'vk:2';
const config = { ownerId, reasonMaxLength: 500, reasonRetentionDays: 90 } as const;

test('миграция 15 сохраняет настройки и назначения, восстановление и статус переживают перезапуск', async () => {
  const files = storageFixture();
  const db = new Database(files.path);
  try {
    migrate(db, migrations.slice(0, 14));
    db.exec(`UPDATE lifecycle_clock SET value=2;
      INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('${chat}',1,0,'active'),('${other}',2,0,'active');
      INSERT INTO chats(chat_id,timezone,enabled,created_at,response_mode) VALUES ('${chat}','UTC',0,1,'silent'),('${other}','UTC',1,1,'normal');
      INSERT INTO bot_admin_grants VALUES ('${chat}','vk:3','creator',1,NULL),('${other}','vk:4','explicit',1,NULL);`);
  } finally {
    db.close();
  }
  let storage = await openStorage(files.path);
  const lifecycle = () =>
    createLifecycleService({
      storage,
      ownerId,
      source: {
        async observe() {
          return { confidence: 'unavailable', bot: 'unknown' };
        },
      },
    });
  let service = await createAuthorizationService({
    config,
    store: storage.authorization,
    now: () => 100,
  });
  try {
    const scope = lifecycle().current(chat);
    expect(await storage.chats.get(scope)).toMatchObject({
      enabled: false,
      responseMode: 'silent',
      timezone: 'UTC',
    });
    expect(await storage.authorization.transaction(scope, (tx) => tx.bases('vk:3'))).toEqual([
      'creator',
    ]);
    const context = service.context({ scope, userId: ownerId, kind: 'owner' });
    const proof = await service.confirmMembership(scope, userId);
    const fault = new Database(files.path);
    try {
      fault.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON admin_recovery_operations
        BEGIN SELECT RAISE(ABORT,'save failed'); END`);
      await expect(service.recoverAdmin(context, userId, 99, proof, () => true)).rejects.toThrow();
      expect(await storage.authorization.transaction(scope, (tx) => tx.bases(userId))).toEqual([]);
      expect(adminRecoveryStore(storage).status(chat, ownerId)).toEqual([]);
    } finally {
      fault.exec('DROP TRIGGER fail_recovery');
      fault.close();
    }
    const result = await service.recoverAdmin(context, userId, 99, proof, () => true);
    if (!result.allowed) throw new Error(result.code);
    const operation = result.value.operation;
    const claimed = adminRecoveryStore(storage).claim(scope, ownerId, operation.id, 101)!;
    adminRecoveryStore(storage).recordReceipt(scope, claimed, '42');
    service.dispose();
    await storage.close();
    storage = await openStorage(files.path);
    service = await createAuthorizationService({
      config,
      store: storage.authorization,
      now: () => 200,
    });
    adminRecoveryStore(storage).restoreSending(ownerId);
    const resumed = lifecycle().current(chat);
    const replay = await service.recoverAdmin(
      service.context({ scope: resumed, userId: ownerId, kind: 'owner' }),
      userId,
      99,
      null,
      () => true,
    );
    expect(replay).toMatchObject({
      allowed: true,
      value: {
        created: false,
        operation: {
          id: operation.id,
          sendId: operation.sendId,
          receipt: '42',
          attempt: 1,
          attemptedAt: 101,
          state: 'pending_delivery',
          reason: 'interrupted',
        },
      },
    });
    expect(await storage.authorization.transaction(resumed, (tx) => tx.bases(userId))).toEqual([
      'explicit',
    ]);
    const ownerLifecycle = lifecycle();
    const newGeneration = ownerLifecycle.decide(ownerLifecycle.owner(chat, ownerId), 'new');
    expect(newGeneration.generation).not.toBe(resumed.generation);
    expect(adminRecoveryStore(storage).status(chat, ownerId)).toEqual([]);
    const adjacent = lifecycle().current(other);
    expect(await storage.authorization.transaction(adjacent, (tx) => tx.bases('vk:4'))).toEqual([
      'explicit',
    ]);
  } finally {
    service.dispose();
    await storage.close();
    files.cleanup();
  }
});
