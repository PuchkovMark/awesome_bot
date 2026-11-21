import type { Database } from 'better-sqlite3';
import { openConnection } from '../../src/storage/connection.js';
import { migrate } from '../../src/storage/migrate.js';

// Только технические проверки схемы; не прикладной репозиторий профилей.
export function participantFixture(db: Database) {
  function participant(chatId: string, userId: string, patch: Record<string, unknown> = {}) {
    db.prepare(`INSERT INTO chat_participants(chat_id,user_id,joined_at,role,role_observed_at,status,status_observed_at,last_seen_at)
      VALUES (@chatId,@userId,@joinedAt,@role,@roleObservedAt,@status,@statusObservedAt,@lastSeenAt)`)
      .run({ chatId, userId, joinedAt: null, role: 'unknown', roleObservedAt: null, status: 'unknown', statusObservedAt: null, lastSeenAt: null, ...patch });
  }
  function profile(chatId: string, userId: string, patch: Record<string, unknown> = {}) {
    db.prepare('INSERT INTO participant_profiles(chat_id,user_id,created_at,updated_at) VALUES (@chatId,@userId,@createdAt,@updatedAt)')
      .run({ chatId, userId, createdAt: 0, updatedAt: 0, ...patch });
  }
  function fact(chatId: string, userId: string, patch: Record<string, unknown> = {}) {
    return db.prepare(`INSERT INTO profile_facts(chat_id,user_id,field_key,value,source_kind,source_user_id,source_message_id,source_note,reliability,visibility,created_at,updated_at)
      VALUES (@chatId,@userId,@fieldKey,@value,@sourceKind,@sourceUserId,@sourceMessageId,@sourceNote,@reliability,@visibility,@createdAt,@updatedAt)`)
      .run({ chatId, userId, fieldKey: 'synthetic', value: 'Тест', sourceKind: 'inferred', sourceUserId: null, sourceMessageId: null, sourceNote: null, reliability: 'unknown', visibility: 'unknown', createdAt: 0, updatedAt: 0, ...patch });
  }
  return {
    participant, profile, fact,
    chat(chatId: string) { db.prepare("INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES (?,?,'Europe/Moscow',0,0)").run(chatId, (db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as {v:number}).v>=8?'normal':'mention'); },
    participants(chatId: string, userId: string) { return db.prepare('SELECT * FROM chat_participants WHERE chat_id = ? AND user_id = ?').all(chatId, userId); },
    profiles(chatId: string, userId: string) { return db.prepare('SELECT * FROM participant_profiles WHERE chat_id = ? AND user_id = ?').all(chatId, userId); },
    facts(chatId: string, userId: string) { return db.prepare('SELECT * FROM profile_facts WHERE chat_id = ? AND user_id = ? ORDER BY id').all(chatId, userId); },
  };
}
export async function withParticipantDatabase(run: (db: Database, fixture: ReturnType<typeof participantFixture>) => void) {
  const connection = await openConnection(':memory:', migrate);
  try { connection.run((db) => run(db, participantFixture(db))); }
  finally { connection.close(); }
}
