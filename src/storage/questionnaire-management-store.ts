import type { Database } from 'better-sqlite3';
import type { ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import type { QuestionnaireRevision } from '../contracts/questionnaire';
import { claimControlMessage, readChatControl } from './chat-control-store';
import { lifecycleBackend } from './lifecycle-store';
import { appendMessage } from './messages';
import { profileAdmitted } from './personal-data-store';
import { editQuestionnaireAnswer } from './profile-fact-store';
import { questionnaireMessageSequence } from './questionnaire-access-store';
import { isQuestionnaireMember } from './questionnaire-view-store';
import type { Storage } from './types';
import { requireInput } from './validation';

const subject = 'chat_id=? AND generation=? AND user_id=?';
const promptKey = 'chat_id=? AND generation=? AND receipt=?';

function permitted(db: Database, scope: ConnectionScope, actor: UserId, at: number) {
  const control = readChatControl(db, scope.chatId);
  return (
    scope.chatId !== actor &&
    control.enabled &&
    control.mode !== 'silent' &&
    isQuestionnaireMember(db, scope, actor) &&
    profileAdmitted(db, scope, actor, at, 'write')
  );
}
function completed(db: Database, scope: ConnectionScope, actor: UserId) {
  const row = db
    .prepare(
      `SELECT attempt,template FROM questionnaire_progress WHERE ${subject} AND state='completed'`,
    )
    .get(scope.chatId, scope.generation, actor) as
    { attempt: string; template: string } | undefined;
  return row
    ? { attempt: row.attempt, template: JSON.parse(row.template) as QuestionnaireRevision }
    : null;
}
export function eraseQuestionnaireAttempt(
  db: Database,
  chat: string,
  generation: number,
  user: string,
  attempt: string,
) {
  requireInput(db.inTransaction);
  const args = [chat, generation, user, attempt] as const;
  const key = subject + ' AND attempt=?';
  db.prepare(
    `DELETE FROM profile_facts WHERE ${subject} AND field_key IN
    (SELECT field_key FROM questionnaire_answer_facts WHERE ${key})`,
  ).run(chat, generation, user, ...args);
  db.prepare('DELETE FROM questionnaire_inputs WHERE chat_id=? AND generation=? AND attempt=?').run(
    chat,
    generation,
    attempt,
  );
  // Старые ответы на сообщения бота остаются служебными и после нового заполнения.
  db.prepare(
    `INSERT OR IGNORE INTO questionnaire_management_prompts
    (chat_id,generation,receipt,first_position,last_position,expires_at)
    SELECT chat_id,generation,legacy_access_prompt_id,0,0,0 FROM questionnaire_progress
    WHERE ${key} AND legacy_access_prompt_id IS NOT NULL
    UNION ALL SELECT chat_id,generation,prompt_message_id,0,0,0 FROM questionnaire_presentations
    WHERE ${key} AND prompt_message_id IS NOT NULL`,
  ).run(...args, ...args);
  db.prepare('DELETE FROM questionnaire_progress WHERE ' + key).run(...args);
}
export function questionnaireManagementStore(storage: Storage) {
  const lifecycle = lifecycleBackend(storage);
  return {
    open(scope: ConnectionScope, actor: UserId, sequence: number, at: number, now: number) {
      return lifecycle.transaction(scope, (db) => {
        if (
          !permitted(db, scope, actor, at) ||
          !permitted(db, scope, actor, now) ||
          !claimControlMessage(db, scope.chatId, actor, sequence)
        )
          return undefined;
        return completed(db, scope, actor);
      });
    },
    current(scope: ConnectionScope, actor: UserId, attempt: string, now: number) {
      return lifecycle.transaction(
        scope,
        (db) =>
          permitted(db, scope, actor, now) && completed(db, scope, actor)?.attempt === attempt,
      );
    },
    remember(
      scope: ConnectionScope,
      actor: UserId,
      attempt: string,
      part: PublishedPart,
      first: number,
      last: number,
      now: number,
      action: 'edit' | 'delete' = 'edit',
    ) {
      const receipt = questionnaireMessageSequence(part.messageId);
      requireInput(receipt !== null);
      return lifecycle.transaction(scope, (db) => {
        if (!permitted(db, scope, actor, now) || completed(db, scope, actor)?.attempt !== attempt)
          return false;
        const inserted = db
          .prepare(
            `INSERT INTO questionnaire_management_prompts
          (chat_id,generation,receipt,user_id,attempt,first_position,last_position,expires_at,action)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
          )
          .run(
            scope.chatId,
            scope.generation,
            receipt,
            actor,
            attempt,
            first,
            last,
            now + (action === 'edit' ? 86400000 : 900000),
            action,
          );
        if (!inserted.changes) return false;
        const saved = appendMessage(db, {
          ...part,
          chatId: scope.chatId,
          role: 'assistant',
          senderBot: true,
        });
        requireInput(saved.status === 'inserted');
        db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(saved.id);
        return true;
      });
    },
    hasPrompt(scope: ConnectionScope, id: string) {
      const receipt = questionnaireMessageSequence(id);
      return (
        receipt !== null &&
        lifecycle.transaction(
          scope,
          (db) =>
            !!db
              .prepare('SELECT 1 FROM questionnaire_management_prompts WHERE ' + promptKey)
              .get(scope.chatId, scope.generation, receipt),
        )
      );
    },
    reply(
      scope: ConnectionScope,
      actor: UserId,
      receipt: number,
      sequence: number,
      text: string,
      at: number,
      now: number,
    ) {
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare('SELECT * FROM questionnaire_management_prompts WHERE ' + promptKey)
          .get(scope.chatId, scope.generation, receipt) as
          | {
              user_id: string | null;
              attempt: string | null;
              first_position: number;
              last_position: number;
              expires_at: number;
              action: 'edit' | 'delete';
            }
          | undefined;
        if (
          !row ||
          row.user_id !== actor ||
          sequence <= receipt ||
          !permitted(db, scope, actor, at) ||
          !permitted(db, scope, actor, now) ||
          !claimControlMessage(db, scope.chatId, actor, sequence)
        )
          return null;
        const form = completed(db, scope, actor);
        if (!form || form.attempt !== row.attempt || now >= row.expires_at || at >= row.expires_at)
          return row.action === 'edit'
            ? 'Срок списка истёк. Отправьте /анкета изменить ещё раз.'
            : 'Срок подтверждения истёк. Анкета сохранена.';
        if (row.action === 'delete') {
          const choice = text.trim().toLowerCase();
          if (choice === 'оставить') {
            db.prepare(
              'UPDATE questionnaire_management_prompts SET user_id=NULL,attempt=NULL,expires_at=0 WHERE ' +
                promptKey,
            ).run(scope.chatId, scope.generation, receipt);
            return 'Анкета сохранена.';
          }
          if (choice !== 'удалить') return 'Ответьте на запрос словом «Удалить» или «Оставить».';
          db.prepare('INSERT INTO questionnaire_removals VALUES(?,?,?,?,?,?)').run(
            scope.chatId,
            scope.generation,
            actor,
            form.attempt,
            now,
            sequence,
          );
          eraseQuestionnaireAttempt(db, scope.chatId, scope.generation, actor, form.attempt);
          return 'Анкета удалена. Заполнить её заново — /анкета.';
        }
        const match = /^([1-9]\d*)\s+([\s\S]+)$/u.exec(text.trim());
        const position = Number(match?.[1]);
        const value = match?.[2]?.trim();
        if (
          !value ||
          position < row.first_position ||
          position > row.last_position ||
          !form.template.questions.some((q) => q.position === position)
        )
          return 'Ответьте на сообщение с нужным вопросом его номером и новым ответом, например «2 Казань».';
        return editQuestionnaireAnswer(
          db,
          scope,
          actor,
          form.attempt,
          form.template,
          position,
          value,
          { scope, messageId: String(sequence), at },
          now,
        )
          ? `Ответ на вопрос № ${position} сохранён.`
          : null;
      });
    },
  };
}
