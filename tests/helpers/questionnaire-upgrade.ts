import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrate';
import { migrations } from '../../src/storage/migrations/index';

export function seedBeforeQuestionnaires(path: string, chats: readonly string[]) {
  const db = new Database(path);
  try {
    db.pragma('foreign_keys=ON');
    migrate(
      db,
      migrations.filter(({ version }) => version < 35),
    );
    const insert = db.prepare(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES(?,?,0,'active')",
    );
    for (const [index, chat] of chats.entries()) insert.run(chat, index + 1);
    db.prepare('UPDATE lifecycle_clock SET value=? WHERE singleton=1').run(chats.length);
  } finally {
    db.close();
  }
}
