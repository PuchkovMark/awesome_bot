import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import type {
  QuestionnaireRevision,
  QuestionnaireRevisionRef,
  QuestionnaireTemplate,
} from '../contracts/questionnaire';
import { questionnaireQuestions } from '../core/questionnaires/legacy-template';
import type { Connection } from './connection';
import { historySourcesVisible } from './history-retention-store';
import type { LifecycleBackend } from './lifecycle-store';
import { createMessageStore } from './messages';
import type { QuestionnaireReply, QuestionnaireReplyResult } from './questionnaire-types';
import type { Storage } from './types';
import { compositeId, requireInput, timestamp } from './validation';

const inScope = 'chat_id=? AND generation=?';
const keyForPrompt = inScope + ' AND receipt=?';
const deactivate = 'UPDATE questionnaire_editor_prompts SET actor_id=NULL,shown_revision=NULL';

export function createQuestionnaireStore(
  connection: Connection,
  lifecycle: LifecycleBackend,
  options: {
    readonly builtIn: QuestionnaireTemplate;
    readonly supports: (chatId: ChatId) => boolean;
    readonly maxBytes: number;
  },
) {
  const messages = createMessageStore(connection);
  const { builtIn, supports, maxBytes } = options;

  function revision(
    scope: ConnectionScope,
    number: number,
    questions: QuestionnaireRevision['questions'],
  ) {
    return Object.freeze({
      ref: Object.freeze({
        chatId: scope.chatId,
        generation: scope.generation,
        key: builtIn.key,
        revision: number,
      }),
      questions,
    });
  }
  function defaultRevision(db: Database, scope: ConnectionScope) {
    const floor = db
      .prepare('SELECT generation FROM questionnaire_default_boundary WHERE singleton=1')
      .pluck()
      .get() as number;
    return scope.generation > floor ? revision(scope, builtIn.revision, builtIn.questions) : null;
  }
  function localRevision(scope: ConnectionScope, row: { revision: number; questions: string }) {
    return revision(
      scope,
      row.revision,
      questionnaireQuestions(JSON.parse(row.questions) as string[]),
    );
  }
  function current(db: Database, scope: ConnectionScope): QuestionnaireRevision | null {
    if (!supports(scope.chatId)) return null;
    const local = db
      .prepare(
        `SELECT revision,questions FROM questionnaire_revisions
      WHERE ${inScope} ORDER BY revision DESC LIMIT 1`,
      )
      .get(scope.chatId, scope.generation) as { revision: number; questions: string } | undefined;
    return local ? localRevision(scope, local) : defaultRevision(db, scope);
  }
  return {
    current(scope: ConnectionScope) {
      return lifecycle.transaction(scope, (db) => current(db, scope));
    },
    get(scope: ConnectionScope, ref: QuestionnaireRevisionRef): QuestionnaireRevision | null {
      return lifecycle.transaction(scope, (db) => {
        if (
          !supports(scope.chatId) ||
          ref.chatId !== scope.chatId ||
          ref.generation !== scope.generation ||
          ref.key !== builtIn.key
        )
          return null;
        if (ref.revision === builtIn.revision) return defaultRevision(db, scope);
        const row = db
          .prepare(
            `SELECT revision,questions FROM questionnaire_revisions
          WHERE ${inScope} AND revision=?`,
          )
          .get(scope.chatId, scope.generation, ref.revision) as
          { revision: number; questions: string } | undefined;
        return row ? localRevision(scope, row) : null;
      });
    },
    hasPrompt(scope: ConnectionScope, receipt: string) {
      return lifecycle.transaction(
        scope,
        (db) =>
          db
            .prepare(`SELECT 1 FROM questionnaire_editor_prompts WHERE ${keyForPrompt}`)
            .get(scope.chatId, scope.generation, receipt) !== undefined,
      );
    },
    ownsPrompt(scope: ConnectionScope, receipt: string, actor: UserId) {
      return lifecycle.transaction(scope, (db) =>
        Boolean(
          db
            .prepare(
              `SELECT 1 FROM questionnaire_editor_prompts WHERE ${keyForPrompt} AND actor_id=?`,
            )
            .get(scope.chatId, scope.generation, receipt, actor),
        ),
      );
    },
    recordPrompt(
      scope: ConnectionScope,
      actor: UserId,
      shown: number,
      part: PublishedPart,
      replacement?: { editor: string; eventId: string; question: string },
    ) {
      compositeId(actor);
      requireInput(supports(scope.chatId) && Number.isSafeInteger(shown) && shown >= 0);
      requireInput(/^[1-9][0-9]*$/u.test(part.messageId) && part.replyToMessageId === undefined);
      return lifecycle.transaction(scope, (db) => {
        let parent: number | null = null;
        let source: number | null = null;
        if (replacement) {
          parent =
            (db
              .prepare(
                `SELECT message_id FROM questionnaire_editor_prompts
            WHERE ${keyForPrompt} AND actor_id=? AND shown_revision=? AND proposal IS NULL`,
              )
              .pluck()
              .get(scope.chatId, scope.generation, replacement.editor, actor, shown) as number) ??
            null;
          source =
            (db
              .prepare(
                'SELECT id FROM messages WHERE chat_id=? AND platform_message_id=? AND user_id=?',
              )
              .pluck()
              .get(scope.chatId, replacement.eventId, actor) as number) ?? null;
          if (
            !parent ||
            !source ||
            !historySourcesVisible(db, scope.chatId, [parent, source]) ||
            current(db, scope)?.ref.revision !== shown
          )
            return false;
        }
        const saved = messages.append({
          chatId: scope.chatId,
          messageId: part.messageId,
          userId: part.userId,
          authorName: part.authorName,
          role: 'assistant',
          text: part.text,
          timestamp: part.timestamp,
        });
        if (saved.status !== 'inserted') return false;
        db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(saved.id);
        db.prepare(
          `INSERT INTO questionnaire_editor_prompts
          (chat_id,generation,receipt,message_id,actor_id,shown_revision,proposal,editor_message_id,proposal_source_id) VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(
          scope.chatId,
          scope.generation,
          part.messageId,
          saved.id,
          actor,
          shown,
          replacement?.question ?? null,
          parent,
          source,
        );
        if (parent) db.prepare(`${deactivate} WHERE message_id=?`).run(parent);
        return true;
      });
    },
    replace(
      scope: ConnectionScope,
      actor: UserId,
      input: QuestionnaireReply,
      now: number,
    ): QuestionnaireReplyResult {
      timestamp(now);
      return lifecycle.transaction(scope, (db) => {
        const key = [scope.chatId, scope.generation, input.receipt];
        const prompt = db
          .prepare(
            `SELECT actor_id AS actor,shown_revision AS shown,proposal,message_id AS id,editor_message_id AS editor,proposal_source_id AS source FROM questionnaire_editor_prompts
          WHERE ${keyForPrompt}`,
          )
          .get(...key) as
          | {
              actor: UserId | null;
              shown: number | null;
              proposal: string | null;
              id: number;
              editor: number | null;
              source: number | null;
            }
          | undefined;
        if (!supports(scope.chatId) || !prompt || prompt.actor !== actor)
          return { status: 'closed' };
        const close = () => db.prepare(`${deactivate} WHERE ${keyForPrompt}`).run(...key);
        const previous = current(db, scope);
        const selected = previous?.ref.revision ?? 0;
        if (selected !== prompt.shown) {
          close();
          return { status: 'stale' };
        }
        if (Buffer.byteLength(input.text) > maxBytes) return { status: 'too_long' };
        if (input.text.includes('\0') || !input.text.isWellFormed()) return { status: 'invalid' };
        let lines: string[];
        if (prompt.proposal !== null) {
          if (
            !prompt.editor ||
            !prompt.source ||
            !historySourcesVisible(db, scope.chatId, [prompt.id, prompt.editor, prompt.source], now)
          ) {
            close();
            return { status: 'closed' };
          }
          const choice = input.text.trim().toLocaleLowerCase('ru');
          if (choice === 'оставить') {
            close();
            return { status: 'kept' };
          }
          if (choice !== 'заменить') return { status: 'choose' };
          lines = [prompt.proposal];
        } else {
          lines = input.text.split(/\r\n|\n|\r/u).filter((line) => line.trim().length > 0);
          if (!lines.length) return { status: 'empty' };
          if (lines.length === 1 && previous && previous.questions.length >= 2)
            return {
              status: 'confirm',
              before: previous.questions.length,
              shown: selected,
              question: lines[0]!,
            };
        }
        db.prepare(
          `INSERT INTO questionnaire_revisions(chat_id,generation,revision,questions,created_at)
          VALUES (?,?,?,?,?)`,
        ).run(
          scope.chatId,
          scope.generation,
          Math.max(builtIn.revision, selected) + 1,
          JSON.stringify(lines),
          now,
        );
        close();
        db.prepare(`${deactivate} WHERE ${inScope} AND proposal IS NOT NULL`).run(
          scope.chatId,
          scope.generation,
        );
        return { status: 'applied', count: lines.length };
      });
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createQuestionnaireStore>>();
export function registerQuestionnaires(
  storage: Storage,
  store: ReturnType<typeof createQuestionnaireStore>,
) {
  stores.set(storage, store);
}
export function questionnaireStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
