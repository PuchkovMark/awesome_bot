import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import {
  finishResponse,
  pruneResponseRate,
  recoverResponseRate,
  responseAlreadyStarted,
  responseSlotAvailable,
  startResponse,
} from '../src/storage/response-rate-store';

test('незавершённая публикация удерживает место за границей окна, неизвестная учитывается с первой попытки', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const scope = { chatId: 'vk:2000000041', generation: 1 } as const;
    db.prepare(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES(?,?,0,'active')",
    ).run(scope.chatId, scope.generation);
    startResponse(db, scope, 'job:1', 1000);
    expect(responseAlreadyStarted(db, scope, 'job:1')).toBe(true);
    expect(responseSlotAvailable(db, scope, 1, 61000)).toBe(false);
    pruneResponseRate(db, 61000);
    expect(responseAlreadyStarted(db, scope, 'job:1')).toBe(true);
    recoverResponseRate(db, 'vk:');
    expect(responseSlotAvailable(db, scope, 1, 60999)).toBe(false);
    expect(responseSlotAvailable(db, scope, 1, 61000)).toBe(true);
    pruneResponseRate(db, 61000);
    expect(responseAlreadyStarted(db, scope, 'job:1')).toBe(false);

    startResponse(db, scope, 'job:2', 62000);
    finishResponse(db, scope, 'job:2', 'failed');
    expect(responseSlotAvailable(db, scope, 1, 62000)).toBe(true);
    startResponse(db, scope, 'job:3', 61000);
    finishResponse(db, scope, 'job:3', 'delivered');
    expect(responseSlotAvailable(db, scope, 1, 121999)).toBe(false);
    expect(responseSlotAvailable(db, scope, 1, 122000)).toBe(true);
    db.prepare('DELETE FROM chat_connections WHERE chat_id=?').run(scope.chatId);
    expect(responseAlreadyStarted(db, scope, 'job:3')).toBe(false);
  } finally {
    db.close();
  }
});
