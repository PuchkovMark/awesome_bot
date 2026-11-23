import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { responseRateConfig } from '../src/core/chat-limits/response-rate-config.js';
import { migrate } from '../src/storage/migrate.js';
import { activeMentionFlood, admitMention, pruneMentionFlood } from '../src/storage/mention-flood-store.js';

test('повтор, рестарт и смена настройки сохраняют границу и идентичность активного всплеска', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const scope = {chatId:'vk:2000000041',generation:1} as const;
    db.prepare("INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES(?,?,0,'active')").run(scope.chatId,scope.generation);
    const initial = responseRateConfig({floodThreshold:2});
    expect(admitMention(db,scope,1,initial,1000)).toEqual({active:false,opened:false});
    expect(admitMention(db,scope,2,initial,11000)).toEqual({active:false,opened:false});
    expect(admitMention(db,scope,3,initial,12000)).toEqual({active:true,opened:true});
    expect(admitMention(db,scope,3,initial,13000)).toEqual({active:true,opened:false});
    const changed = responseRateConfig({floodThreshold:1,floodWindowMs:5000});
    expect(admitMention(db,scope,4,changed,17000)).toEqual({active:true,opened:false});
    expect(activeMentionFlood(db,scope,26999)).toBe(3);
    expect(activeMentionFlood(db,scope,27000)).toBeNull();
    pruneMentionFlood(db,27000,changed.floodWindowMs);
    expect(admitMention(db,scope,5,changed,27000)).toEqual({active:true,opened:true});
    expect(activeMentionFlood(db,scope,27000)).toBe(5);
    expect(activeMentionFlood(db,scope,32000)).toBeNull();
    db.prepare('DELETE FROM chat_connections WHERE chat_id=?').run(scope.chatId);
    expect(activeMentionFlood(db,scope,27000)).toBeNull();
    expect(db.prepare('SELECT count(*) FROM mention_flood_inputs').pluck().get()).toBe(0);
  } finally { db.close(); }
});
