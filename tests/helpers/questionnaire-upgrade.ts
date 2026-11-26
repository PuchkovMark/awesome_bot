import Database from 'better-sqlite3';
import { migrate } from '../../src/storage/migrate';
import { migrations } from '../../src/storage/migrations/index';
import type { ConnectionScope, UserId } from '../../src/contracts/index';
import { privateQuestionnaire } from '../../src/core/questionnaires/private-template';
import { recordQuestionnaireFacts } from '../../src/storage/profile-fact-store';

export function seedBeforeQuestionnaires(
  path: string,
  chats: readonly string[],
  invitations = false,
) {
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
    if (invitations)
      db.exec(`INSERT INTO chat_controls(chat_id,generation,invitation_enabled_at)
        SELECT chat_id,generation,1 FROM chat_connections`);
    db.prepare('UPDATE lifecycle_clock SET value=? WHERE singleton=1').run(chats.length);
  } finally {
    db.close();
  }
}

export function seedLegacyPrivateForm(
  db: Database.Database,
  scope: ConnectionScope,
  now: number,
  answers?: Record<string, string>,
  sourceId?: number,
) {
  const userId = scope.chatId as UserId;
  const attempt = 'legacy-private-' + userId;
  const { key, revision, questions } = privateQuestionnaire;
  const template = { ref: { ...scope, key, revision }, questions };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO questionnaire_progress(chat_id,generation,user_id,attempt,presentation,template,state,shown_at,source_id)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      scope.chatId,
      scope.generation,
      userId,
      attempt,
      attempt,
      JSON.stringify(template),
      answers ? 'completed' : sourceId ? 'processing' : 'active',
      now,
      sourceId ?? null,
    );
    if (answers)
      recordQuestionnaireFacts(
        db,
        scope,
        attempt,
        template,
        {
          userId,
          messageId: '1',
          at: now,
          text: Object.values(answers).join(' '),
        },
        answers,
        now,
      );
    if (sourceId) {
      db.prepare('INSERT INTO questionnaire_inputs VALUES(?,?,?,?)').run(
        sourceId,
        scope.chatId,
        scope.generation,
        attempt,
      );
      db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(sourceId);
    }
  })();
}

export function seedLegacyQuestionnaireRestriction(
  db: Database.Database,
  scope: ConnectionScope,
  user: UserId,
  position: number,
  now: number,
  visibility: 'bot' | 'unknown' = 'bot',
) {
  db.prepare(
    `INSERT INTO profile_facts(
    chat_id,user_id,field_key,value,source_kind,source_user_id,reliability,visibility,
    created_at,updated_at,generation,source_at,event_key,change_kind
  ) SELECT chat_id,user_id,field_key,'','self',user_id,'unknown',?,?,?,?,?,'2:profile:legacy','visibility'
   FROM questionnaire_answer_facts WHERE (chat_id,generation,user_id,position)=(?,?,?,?)`,
  ).run(
    visibility,
    now,
    now,
    scope.generation,
    now,
    scope.chatId,
    scope.generation,
    user,
    position,
  );
}
