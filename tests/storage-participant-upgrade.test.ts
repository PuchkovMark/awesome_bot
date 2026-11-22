import { openStorage, scopeFor } from './helpers/connection-scope.js';
import { expect, test } from 'vitest';

import { openConnection } from '../src/storage/connection.js';
import { migrate } from '../src/storage/migrate.js';
import { migrations } from '../src/storage/migrations/index.js';
import { storageFixture } from './helpers/storage-fixture.js';
import { participantFixture } from './helpers/participant-fixture.js';

const oldMessage = { chatId: 'a:old', userId: 'a:u', messageId: 'one', authorName: 'Имя', role: 'user', text: 'старыйкот', timestamp: 0 } as const;
test('F1.4 → версия 3 сохраняет историю, настройки, FTS, новые данные и прежние миграции', async () => {
  const fixture = storageFixture();
  const seed = await openConnection(fixture.path, (db) => migrate(db, migrations.slice(0, 2)));
  let previous: unknown[];
  try {
    previous = seed.run((db) => {
      db.exec("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('a:old','one','a:u','Имя','user','старыйкот',0)");
      db.exec("INSERT INTO chats(chat_id,title,system_prompt,response_mode,timezone,enabled,created_at) VALUES ('a:old','Изменённое название','Сохранённый промпт','always','UTC',1,0)");
      return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    });
  } finally { seed.close(); }
  try {
    const storage = await openStorage(fixture.path);
    try {
      expect(await storage.messages.list(scopeFor(storage, oldMessage.chatId), { limit: 10 })).toMatchObject([oldMessage]);
      expect(await storage.chats.get(scopeFor(storage, oldMessage.chatId))).toMatchObject({ title: 'Изменённое название', responseMode: 'normal', timezone: 'UTC', enabled: true, createdAt: 0 });
      expect(await storage.messages.append(scopeFor(storage, ({ ...oldMessage, text: 'неподменять' }).chatId), { ...oldMessage, text: 'неподменять' })).toMatchObject({ status: 'duplicate' });
      await storage.messages.append(scopeFor(storage, ({ ...oldMessage, chatId: 'a:before-settings', messageId: 'new' }).chatId), { ...oldMessage, chatId: 'a:before-settings', messageId: 'new' });
      expect(await storage.chats.get(scopeFor(storage, 'a:before-settings'))).toBeNull();
      const inspection = await openConnection(fixture.path);
      try {
        inspection.run((db) => {
          expect(db.prepare('SELECT * FROM schema_migrations WHERE version <= 2 ORDER BY version').all()).toEqual(previous);
          expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }]);
          expect(db.prepare('SELECT * FROM chat_participants').all()).toEqual([]);
          expect(db.prepare('SELECT * FROM participant_profiles').all()).toEqual([]);
          expect(db.prepare('SELECT * FROM profile_facts').all()).toEqual([]);
          expect(db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('старыйкот')).toHaveLength(2);
          expect(db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('неподменять')).toEqual([]);
          const f = participantFixture(db);
          f.participant('a:old', 'a:u'); f.profile('a:old', 'a:u');
          f.fact('a:old', 'a:u', { sourceKind: 'self', sourceUserId: 'a:u', visibility: 'bot', reliability: 'unverified', value: 'Сохранённый 🐈' });
          expect(db.pragma('foreign_key_check')).toEqual([]);
        });
      } finally { inspection.close(); }
    } finally { await storage.close(); }
    const reopened = await openStorage(fixture.path);
    try {
      const inspection = await openConnection(fixture.path);
      try {
        inspection.run((db) => {
          const f = participantFixture(db);
          expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
          expect(f.participants('a:old', 'a:u')).toMatchObject([{ joined_at: null, role: 'unknown', status: 'unknown', last_seen_at: null }]);
          expect(f.profiles('a:old', 'a:u')).toMatchObject([{ created_at: 0, updated_at: 0 }]);
          expect(f.facts('a:old', 'a:u')).toMatchObject([{ value: 'Сохранённый 🐈', visibility: 'bot', reliability: 'unverified' }]);
          expect(db.prepare('SELECT * FROM schema_migrations WHERE version <= 2 ORDER BY version').all()).toEqual(previous);
          expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 14 });
          expect(db.pragma('foreign_key_check')).toEqual([]);
        });
      } finally { inspection.close(); }
      expect(await reopened.messages.append(scopeFor(reopened, (oldMessage).chatId), oldMessage)).toMatchObject({ status: 'duplicate' });
    } finally { await reopened.close(); }
  } finally { fixture.cleanup(); }
});
