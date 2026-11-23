import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import {
  legacyChatPromptFixture,
  legacyPrompt,
  sharedPrompt,
} from './helpers/legacy-chat-prompt-fixture';
import { storageFixture } from './helpers/storage-fixture';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { createContextPreparation } from '../src/core/prepare-context';
import { contextCapabilities } from './helpers/context';
const columns = (db: Database.Database) =>
  (db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((v) => v.name);
test('новая БД не содержит индивидуального столбца; повторная миграция идемпотентна', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    expect(columns(db)).toEqual([
      'chat_id',
      'title',
      'timezone',
      'enabled',
      'created_at',
      'response_mode',
    ]);
    const saved = db.serialize();
    migrate(db);
    expect(db.serialize()).toEqual(saved);
  } finally {
    db.close();
  }
});
test('upgrade 10 → 11 сохраняет остальные таблицы, настройки, FTS и checksums', async () => {
  const f = storageFixture();
  const db = new Database(f.path);
  try {
    legacyChatPromptFixture(db);
    expect(db.prepare("SELECT system_prompt FROM chats WHERE chat_id='vk:old'").get()).toEqual({
      system_prompt: legacyPrompt,
    });
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' AND name NOT IN ('chats','schema_migrations') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((v) => v.name);
    const projections = tables.map((t) =>
      (db.pragma(`table_info(${t})`) as { name: string }[]).map((column) => column.name).join(','),
    );
    const snapshots = tables.map((t, i) =>
      db.prepare('SELECT ' + projections[i] + ' FROM ' + t).all(),
    );
    const settings = db
      .prepare(
        'SELECT chat_id,title,response_mode,timezone,enabled,created_at FROM chats ORDER BY chat_id',
      )
      .all();
    const checksums = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    migrate(db);
    expect(columns(db)).not.toContain('system_prompt');
    tables.forEach((t, i) =>
      expect(db.prepare('SELECT ' + projections[i] + ' FROM ' + t).all()).toEqual(snapshots[i]),
    );
    expect(
      db
        .prepare(
          'SELECT chat_id,title,response_mode,timezone,enabled,created_at FROM chats ORDER BY chat_id',
        )
        .all(),
    ).toEqual(settings);
    expect(
      db.prepare('SELECT * FROM schema_migrations WHERE version<=10 ORDER BY version').all(),
    ).toEqual(checksums);
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'кот'").all(),
    ).toEqual([{ rowid: 1 }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
    const s = await openStorage(f.path);
    try {
      const scope = scopeFor(s, 'vk:old');
      const prep = createContextPreparation({
        storage: s,
        config: { modelContextTokens: 16000 },
        sessionId: () => 'synthetic',
        capabilities: async () => contextCapabilities(scope.chatId),
      });
      const result = await prep.prepare({
        scope,
        messageId: 1,
        route: { kind: 'name', mode: 'normal', isGroupChat: true },
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      if (result.kind !== 'ready') throw Error(result.kind);
      expect(result.input.system.startsWith(sharedPrompt)).toBe(true);
      expect(JSON.stringify(result.input)).not.toContain(legacyPrompt);
      expect(await s.contextState.systemPrompt(scope)).toEqual(
        await s.versions.systemPrompt(scope),
      );
    } finally {
      await s.close();
    }
  } finally {
    if (db.open) db.close();
    f.cleanup();
  }
});
test('ошибка после удаления откатывает весь неприменённый набор вместе со столбцом', () => {
  const db = new Database(':memory:');
  try {
    legacyChatPromptFixture(db);
    const before = db.serialize();
    expect(() =>
      migrate(db, [
        ...migrations,
        {
          version: migrations.length + 1,
          name: 'synthetic-failure',
          sql: 'CREATE TABLE partial(x); INVALID SQL;',
        },
      ]),
    ).toThrow('migration_failed');
    expect(db.serialize()).toEqual(before);
    expect(columns(db)).toContain('system_prompt');
    expect(db.prepare("SELECT system_prompt FROM chats WHERE chat_id='vk:old'").get()).toEqual({
      system_prompt: legacyPrompt,
    });
    expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({
      version: 10,
    });
  } finally {
    db.close();
  }
});
