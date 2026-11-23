import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';

test('FTS синхронизирует вставку, обновление и удаление', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const find = (word: string) =>
      db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(word);
    db.exec(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:1','1','vk:2','','user','кошка',0)",
    );
    expect(find('кошка')).toHaveLength(1);
    db.exec("UPDATE messages SET text = 'собака'");
    expect(find('кошка')).toEqual([]);
    expect(find('собака')).toHaveLength(1);
    db.exec('DELETE FROM messages');
    expect(find('собака')).toEqual([]);
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
  } finally {
    db.close();
  }
});
