import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { openConnection } from '../src/storage/connection';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { storageFixture } from './helpers/storage-fixture';

const insert =
  "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:1','1','vk:2','Имя','user','старый',0)";

test.each([58, 59])(
  'миграция 60 сохраняет старое задание схемы %s и не считает готовую часть отказом',
  (version) => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys=ON');
      migrate(db, migrations.slice(0, version));
      db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:41',1,0,'active');
      INSERT INTO personal_reminders(id,chat_id,generation,origin_at,text,due_at,timezone,next_at,state)
        VALUES (12,'vk:41',1,0,'взять билет',60000,'UTC',60000,'pending');
      INSERT INTO personal_reminder_inputs VALUES ('vk:41',1,'5','vk:41',1,12);
      INSERT INTO personal_reminder_parts(reminder_id,stage,part,send_id,text)
        VALUES (12,'confirmation',0,8,'Назначено');`);
      const history = db.prepare('SELECT * FROM schema_migrations WHERE version<=?');
      const previous = history.all(version);
      migrate(db);
      expect(history.all(version)).toEqual(previous);
      expect(
        db.prepare('SELECT id,due_at,text,schedule_key,hint_claimed FROM personal_reminders').get(),
      ).toEqual({
        id: 12,
        due_at: 60000,
        text: 'взять билет',
        schedule_key: null,
        hint_claimed: 0,
      });
      expect(
        db.prepare('SELECT send_id,state,definite_failure FROM personal_reminder_parts').get(),
      ).toEqual({
        send_id: 8,
        state: 'ready',
        definite_failure: 0,
      });
      expect(
        db.prepare('SELECT reminder_id,repeated_request FROM personal_reminder_inputs').get(),
      ).toEqual({
        reminder_id: 12,
        repeated_request: 0,
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  },
);

test('миграция 13 сохраняет поколения и связывает отметки с конкретным чатом и поколением', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 12));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:1',1,0,'active'),('vk:2',2,0,'uncertain')",
    );
    const history = db.prepare('SELECT * FROM schema_migrations').all();
    const connections = db
      .prepare(
        "SELECT *,NULL AS pause_reason,0 AS erased_author_number,state='active' AS established FROM chat_connections",
      )
      .all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=12').all()).toEqual(history);
    expect(db.prepare('SELECT * FROM chat_connections').all()).toEqual(connections);
    const add = db.prepare('INSERT INTO connection_membership_signals VALUES (?,?,?)');
    add.run('vk:1', 1, '8');
    add.run('vk:2', 2, '8');
    expect(() => add.run('vk:1', 2, '9')).toThrow();
    db.prepare('DELETE FROM chat_connections WHERE chat_id=?').run('vk:1');
    expect(db.prepare('SELECT * FROM connection_membership_signals').all()).toEqual([
      { chat_id: 'vk:2', generation: 2, signal_key: '8' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('переход первой схемы ко второй, история и повторный запуск', () => {
  const fixture = storageFixture();
  let db = new Database(fixture.path);
  try {
    migrate(db, migrations.slice(0, 1));
    db.exec(insert);
    db.exec(
      "INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES ('vk:1','mention','Europe/Moscow',0,0)",
    );
    db.close();
    db = new Database(fixture.path);
    migrate(db);
    expect(
      db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('старый'),
    ).toHaveLength(1);
    expect(db.prepare('SELECT enabled FROM chats').get()).toEqual({ enabled: 0 });
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(before);
    expect(db.prepare('PRAGMA index_info(messages_chat_time)').all()).toMatchObject([
      { name: 'chat_id' },
      { name: 'timestamp' },
      { name: 'id' },
    ]);
  } finally {
    db.close();
    fixture.cleanup();
  }
});
for (const sql of [
  `UPDATE schema_migrations SET version = ${migrations.length + 1} WHERE version = ${migrations.length}`,
  'DELETE FROM schema_migrations WHERE version = 1',
  "UPDATE schema_migrations SET name = 'changed' WHERE version = 1",
  "UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1",
]) {
  test(`отказ для изменённой истории: ${sql}`, () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(insert);
      db.exec(sql);
      const before = db.serialize();
      expect(() => migrate(db)).toThrow('schema_incompatible');
      expect(db.serialize()).toEqual(before);
    } finally {
      db.close();
    }
  });
}
test.each(['legacy', 'sqliteXlegacy'])('посторонняя БД с таблицей %s не меняется', (table) => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ${table}(secret TEXT)`);
    const before = db.serialize();
    expect(() => migrate(db)).toThrow('schema_incompatible');
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
test('откат всего недостающего набора и сохранность предыдущей схемы', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrations.slice(0, 1));
    db.exec(insert);
    const before = db.serialize();
    expect(() =>
      migrate(db, [
        ...migrations,
        {
          version: migrations.length + 1,
          name: 'broken',
          sql: 'CREATE TABLE partial(x); SECRET SQL;',
        },
      ]),
    ).toThrow('migration_failed');
    expect(db.serialize()).toEqual(before);
    expect(db.prepare('SELECT text FROM messages').get()).toEqual({ text: 'старый' });
  } finally {
    db.close();
  }
});
test('первичная ошибка также откатывает метаданные', () => {
  const db = new Database(':memory:');
  try {
    expect(() =>
      migrate(db, [{ version: 1, name: 'broken', sql: 'CREATE TABLE partial(x); BROKEN' }]),
    ).toThrow('migration_failed');
    expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([]);
  } finally {
    db.close();
  }
});
test('недоступный FTS-модуль: отказ миграции и закрытие соединения', async () => {
  let reference: Database.Database | undefined;
  await expect(
    openConnection(':memory:', (db) => {
      reference = db;
      migrate(db, [
        { version: 1, name: 'missing-fts', sql: 'CREATE VIRTUAL TABLE f USING missing_fts5(text)' },
      ]);
    }),
  ).rejects.toMatchObject({ code: 'migration_failed' });
  expect(reference?.open).toBe(false);
});

test('миграция готовых анкет сохраняет старые квитанции и отдельные решения о представлении', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 49));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:group',1,1,'active')",
    );
    for (const [i, access] of ['open', 'closed', null].entries()) {
      const user = 'vk:' + i,
        attempt = 'form-' + i;
      db.prepare(
        "INSERT INTO questionnaire_progress(chat_id,generation,user_id,attempt,presentation,template,state) VALUES('vk:group',1,?,?,?,'{}','completed')",
      ).run(user, attempt, attempt);
      db.prepare("INSERT INTO questionnaire_access VALUES('vk:group',1,?,?,?,?,?,?,?)").run(
        user,
        attempt,
        100 + i,
        200 + i,
        1000,
        access,
        access ? 300 + i : null,
      );
      db.prepare("INSERT INTO questionnaire_presentations VALUES('vk:group',1,?,?,?,?,?,?)").run(
        user,
        attempt,
        400 + i,
        i < 2 ? 500 + i : null,
        ['delivered', 'declined', 'waiting'][i],
        i === 0 ? 2 : 0,
      );
    }
    migrate(db);
    expect(
      db
        .prepare(
          'SELECT response_message_id,legacy_access_prompt_id FROM questionnaire_progress ORDER BY user_id',
        )
        .raw()
        .all(),
    ).toEqual([
      [100, 200],
      [101, 201],
      [102, 202],
    ]);
    expect(
      db
        .prepare('SELECT state,confirmed_parts FROM questionnaire_presentations ORDER BY user_id')
        .raw()
        .all(),
    ).toEqual([
      ['delivered', 2],
      ['declined', 0],
      ['waiting', 0],
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('обновление закрывает старые редакторы вопросов и правил, сохраняя подтверждение очистки', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 53));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:41',1,1,'active')",
    );
    const log = db.prepare(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:41',?,'vk:-314','','assistant','Служебный ответ',1)",
    );
    for (const id of ['1', '2', '3', '4']) log.run(id);
    db.exec(`INSERT INTO questionnaire_editor_prompts VALUES('vk:41',1,'1',1,'vk:73',1);
      INSERT INTO chat_passport_prompts VALUES('vk:41',1,'2',2,'rules','vk:73','edit',1,900000),
      ('vk:41',1,'3',3,'rules','vk:73','clear',1,900000),('vk:41',1,'4',4,'topic','vk:73','edit',1,900000)`);
    migrate(db, migrations.slice(0, 54));
    expect(
      db.prepare('SELECT actor_id FROM questionnaire_editor_prompts').pluck().get(),
    ).toBeNull();
    expect(
      db.prepare('SELECT action FROM chat_passport_prompts ORDER BY message_id').pluck().all(),
    ).toEqual([null, 'clear', 'edit']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('миграция 056 закрывает автоматическую правку четырёх разделов и сохраняет явные приглашения', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 55));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:41',1,1,'active')",
    );
    const log = db.prepare(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:41',?,'vk:-314','','assistant','Просмотр раздела',1)",
    );
    const prompt = db.prepare(
      "INSERT INTO chat_passport_prompts VALUES('vk:41',1,?,?,?,'vk:73',?,1,900000)",
    );
    const sectionText = db.prepare(
      "INSERT INTO chat_passport_sections VALUES('vk:41',1,?,'Текст раздела',1)",
    );
    for (const section of ['rules', 'traditions', 'events', 'topic', 'glossary']) {
      sectionText.run(section);
      for (const action of ['edit', 'clear']) {
        const receipt = section + action;
        prompt.run(receipt, log.run(receipt).lastInsertRowid, section, action);
      }
    }
    migrate(db);
    expect(
      db
        .prepare(
          'SELECT receipt FROM chat_passport_prompts WHERE actor_id IS NULL ORDER BY receipt',
        )
        .pluck()
        .all(),
    ).toEqual(['eventsedit', 'glossaryedit', 'topicedit', 'traditionsedit']);
    expect(
      db
        .prepare(
          "SELECT count(*) FROM chat_passport_prompts WHERE actor_id='vk:73' AND revision=1 AND expires_at=900000 AND (action='clear' OR (section='rules' AND action='edit'))",
        )
        .pluck()
        .get(),
    ).toBe(6);
    expect(
      db
        .prepare(
          "SELECT count(*) FROM chat_passport_sections WHERE revision=1 AND text='Текст раздела'",
        )
        .pluck()
        .get(),
    ).toBe(5);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('миграция 058 переносит только открытые споры и привязывает отметки к поколению', () => {
  const files = storageFixture();
  let db = new Database(files.path);
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 57));
    db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state)
      VALUES ('vk:1',1,1,'active'),('vk:2',2,1,'active');
      INSERT INTO personal_deletions(code,chat_id,generation,user_id,request_event,requested_at,confirmed_at,cutoff_id)
      VALUES ('a','vk:1',1,'vk:11','1',0,1,2),('b','vk:2',2,'vk:12','2',0,1,3);
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      VALUES ('vk:1','5','vk:3','','user','спор',0),('vk:1','6','vk:11','','user','удалено',0),
             ('vk:2','5','vk:3','','user','спор',0),('vk:1','7','vk:3','','user','видно',0);
      INSERT INTO personal_hidden_messages VALUES (1,'a',1),(2,'a',0),(3,'b',1);
      INSERT INTO history_deleted_inputs VALUES ('vk:1',1,'6');`);
    const visible = () => db.prepare('SELECT id FROM personal_visible_messages').pluck().all();
    expect(visible()).toEqual([4]);
    migrate(db);
    const cases = () =>
      db.prepare('SELECT * FROM personal_dispute_cases ORDER BY code').raw().all();
    expect(cases()).toEqual([
      ['a', '5', 'legacy_open'],
      ['b', '5', 'legacy_open'],
    ]);
    expect(visible()).toEqual([4]);
    expect(db.prepare('SELECT * FROM personal_dispute_reports').all()).toEqual([]);
    const receive = db.prepare('INSERT INTO personal_dispute_reports VALUES(?,8,?,?)');
    receive.run('vk:11', 'a', '5');
    expect(() => receive.run('vk:11', 'b', '5')).toThrow();
    receive.run('vk:12', 'b', '5');
    db.exec('DELETE FROM messages WHERE id IN (1,2)');
    db.close();
    db = new Database(files.path);
    db.pragma('foreign_keys=ON');
    migrate(db);
    expect(cases()).toHaveLength(2);
    expect(db.prepare('SELECT platform_message_id FROM history_deleted_inputs').pluck().get()).toBe(
      '6',
    );
    db.prepare('DELETE FROM chat_connections WHERE chat_id=?').run('vk:1');
    expect(cases()).toEqual([['b', '5', 'legacy_open']]);
    expect(db.prepare('SELECT code FROM personal_dispute_reports').pluck().all()).toEqual(['b']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    files.cleanup();
  }
});
