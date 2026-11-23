import type { ConnectionScope, UserId } from '../contracts/index';
import type { Database } from 'better-sqlite3';
import type { QuestionnaireRevision } from '../contracts/questionnaire';
import type { LifecycleBackend } from './lifecycle-store';
import type {
  FactSourceKind,
  FactVisibility,
  OwnProfileFact,
  ProfileFactChange,
  ProfileFactInput,
  ProfileFactWriteResult,
} from './participant-types';
import { historyBounds } from './history-retention-store';
import { interestKey, ownInterestRestriction, selectOwnProfile } from './profile-fact-selection';
import { questionnaireFieldPrefix } from './questionnaire-types';
import type {
  ProfileCommandChange,
  ProfileCommandEvent,
  ProfileCommandEditResult,
} from './profile-command-types';
import { inferenceAllowed, rememberInferenceRejection } from './profile-inference-rejection';
import { profileAdmitted } from './personal-data-store';
import { compositeId, object, requireInput } from './validation';
import type { Storage } from './types';

function validate(change: ProfileFactChange) {
  if (change?.kind === 'withdraw') {
    object(change, ['kind', 'interest']);
    return { fieldKey: 'interest', interest: interestKey(change.interest), value: '' };
  }
  requireInput(change?.kind === 'set' || change?.kind === 'visibility');
  const { fieldKey } = change;
  requireInput(
    typeof fieldKey === 'string' &&
      fieldKey.trim() === fieldKey &&
      fieldKey !== '' &&
      !fieldKey.includes('\0'),
  );
  if (change.kind === 'set') {
    object(change, ['kind', 'fieldKey', 'value', 'reliability', 'sourceNote']);
    requireInput(typeof change.value === 'string' && !!change.value.trim());
    requireInput(['unknown', 'unverified', 'confirmed'].includes(change.reliability));
    requireInput(change.sourceNote === undefined || typeof change.sourceNote === 'string');
    return {
      fieldKey,
      interest: fieldKey === 'interest' ? interestKey(change.value) : '',
      value: change.value,
    };
  }
  object(change, ['kind', 'fieldKey', 'visibility', 'interest']);
  requireInput(['chat', 'bot', 'unknown'].includes(change.visibility));
  requireInput((fieldKey === 'interest') === (change.interest !== undefined));
  return {
    fieldKey,
    interest: change.interest === undefined ? '' : interestKey(change.interest),
    value: '',
  };
}

function eventKey(messageId: string) {
  return /^[1-9]\d{0,15}$/u.test(messageId) ? '0:' + messageId.padStart(16, '0') : '1:' + messageId;
}

type Origin = {
  readonly messageId: string;
  readonly userId: UserId;
  readonly at: number;
  readonly text: string;
};

function ensureProfile(
  db: Database,
  chatId: ConnectionScope['chatId'],
  userId: UserId,
  seenAt: number,
  now: number,
) {
  db.prepare(
    `INSERT INTO chat_participants(chat_id,user_id,role,status,last_seen_at)
    VALUES(?,?,'unknown','unknown',?) ON CONFLICT DO NOTHING`,
  ).run(chatId, userId, seenAt);
  db.prepare(
    `INSERT INTO participant_profiles(chat_id,user_id,created_at,updated_at)
    VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,
  ).run(chatId, userId, now, now);
}

export function recordQuestionnaireFacts(
  db: Database,
  scope: ConnectionScope,
  attempt: string,
  template: QuestionnaireRevision,
  source: Origin,
  answers: Readonly<Record<string, string>>,
  now: number,
) {
  requireInput(db.inTransaction);
  const { chatId, generation } = scope;
  const { userId, messageId, at } = source;
  const { key, revision } = template.ref;
  if (!Object.keys(answers).length) return;
  ensureProfile(db, chatId, userId, at, now);
  const fact = db.prepare(
    `INSERT INTO profile_facts(chat_id,user_id,field_key,value,source_kind,source_user_id,
    source_message_id,reliability,visibility,created_at,updated_at,generation,source_at,event_key)
    VALUES(?,?,?,?,'self',?,?,'confirmed',?,?,?,?,?,?)`,
  );
  const bind = db.prepare('INSERT INTO questionnaire_answer_facts VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const { position, text } of template.questions) {
    if (!Object.hasOwn(answers, position)) continue;
    const fieldKey = questionnaireFieldPrefix + JSON.stringify([key, revision, position]);
    const { lastInsertRowid } = fact.run(
      chatId,
      userId,
      fieldKey,
      answers[position],
      userId,
      messageId,
      chatId === userId ? 'bot' : 'chat',
      now,
      now,
      generation,
      at,
      questionnaireFieldPrefix + attempt,
    );
    bind.run(
      chatId,
      generation,
      userId,
      attempt,
      key,
      revision,
      position,
      text,
      fieldKey,
      lastInsertRowid,
    );
  }
  db.prepare(
    'UPDATE participant_profiles SET updated_at=max(updated_at,?) WHERE chat_id=? AND user_id=?',
  ).run(now, chatId, userId);
}

function origin(
  db: Database,
  scope: ConnectionScope,
  messageId: number,
  inferred: boolean,
  now: number,
): Origin | undefined {
  const bounds = historyBounds(db, scope.chatId, now);
  return db
    .prepare(
      `SELECT platform_message_id AS messageId, user_id AS userId, timestamp AS at, text
    FROM personal_visible_messages WHERE chat_id=? AND id=? AND id>? AND timestamp>?
      AND role='user' AND sender_bot=0 AND (?=0 OR purpose='conversation')`,
    )
    .get(
      scope.chatId,
      messageId,
      bounds.clearedThrough,
      bounds.expiredThrough,
      Number(inferred),
    ) as Origin | undefined;
}

function writePrivateFact(
  db: Database,
  scope: ConnectionScope,
  actor: UserId,
  fact: OwnProfileFact,
  change: ProfileCommandChange,
  event: ProfileCommandEvent,
  now: number,
): ProfileCommandEditResult {
  requireInput(event.scope.chatId === actor && db.inTransaction);
  if (change.kind === 'reject') {
    if (fact.sourceKind !== 'inferred') return 'not_inferred';
    db.prepare('INSERT INTO profile_fact_rejections(fact_id,rejected_at) VALUES(?,?)').run(
      fact.factId,
      now,
    );
    rememberInferenceRejection(db, scope, actor, fact, now);
    return 'applied';
  }

  const nextInterest =
    change.kind === 'correct' && fact.fieldKey === 'interest'
      ? interestKey(change.value)
      : fact.interest;
  const moves = nextInterest !== fact.interest;
  if (
    moves &&
    selectOwnProfile(db, scope, actor, now).some(
      (row) => row.fieldKey === 'interest' && row.interest === nextInterest,
    )
  )
    return 'conflict';
  const insert = db.prepare(`INSERT INTO profile_facts(
    chat_id,user_id,field_key,value,source_kind,source_user_id,source_message_id,source_note,
    reliability,visibility,created_at,updated_at,generation,source_at,event_key,interest_key,change_kind
  ) VALUES (?,?,?,?,'self',?,NULL,NULL,?,?,?,?,?,?,?,?,?)`);
  const eventKey =
    '2:profile:' +
    String(event.scope.generation).padStart(16, '0') +
    ':' +
    event.messageId.padStart(16, '0');
  const newest = db
    .prepare(
      `SELECT max(source_at) FROM profile_facts
    WHERE chat_id=? AND generation=? AND user_id=? AND field_key=? AND interest_key IN (?,?)`,
    )
    .pluck()
    .get(scope.chatId, scope.generation, actor, fact.fieldKey, fact.interest, nextInterest) as
    number | null;
  // Даже при одинаковой отметке UTC действие должно идти после показанного состояния.
  const sourceAt = newest === null ? now : Math.max(now, newest + 1);
  const write = (
    kind: 'set' | 'visibility' | 'withdraw',
    interest: string,
    value: string,
    visibility: FactVisibility,
  ) =>
    insert.run(
      scope.chatId,
      actor,
      fact.fieldKey,
      value,
      actor,
      kind === 'set' ? 'confirmed' : 'unknown',
      visibility,
      now,
      now,
      scope.generation,
      sourceAt,
      eventKey,
      interest,
      kind,
    );
  if (change.kind === 'hide') write('visibility', fact.interest, '', 'bot');
  else {
    if (moves) {
      const destination = ownInterestRestriction(db, scope, actor, nextInterest, now);
      const visibility =
        fact.visibility === 'unknown' || destination === 'unknown'
          ? 'unknown'
          : fact.visibility === 'bot' || destination === 'bot'
            ? 'bot'
            : 'chat';
      write('withdraw', fact.interest, '', fact.visibility);
      write('visibility', nextInterest, '', visibility);
    }
    write('set', nextInterest, change.value, fact.visibility);
  }
  db.prepare(
    'UPDATE participant_profiles SET updated_at=max(updated_at,?) WHERE chat_id=? AND user_id=?',
  ).run(now, scope.chatId, actor);
  return 'applied';
}

export function createProfileFactStore(lifecycle: LifecycleBackend) {
  function record(
    scope: ConnectionScope,
    actorId: UserId,
    sourceKind: FactSourceKind,
    input: ProfileFactInput,
    automatic = false,
  ): ProfileFactWriteResult {
    object(input, ['subjectId', 'messageId', 'change']);
    const { subjectId, messageId, change } = input;
    compositeId(subjectId);
    compositeId(actorId);
    const platform = scope.chatId.split(':')[0];
    requireInput(subjectId.split(':')[0] === platform && actorId.split(':')[0] === platform);
    requireInput(Number.isSafeInteger(messageId) && messageId > 0);
    const slot = validate(change);
    if (slot.fieldKey.startsWith(questionnaireFieldPrefix)) return 'blocked';
    if (sourceKind === 'admin' ? actorId === subjectId : actorId !== subjectId) return 'blocked';
    if (sourceKind !== 'self' && change.kind !== 'set') return 'blocked';
    return lifecycle.transaction(scope, (db) => {
      const now = Date.now();
      const source = origin(db, scope, messageId, sourceKind === 'inferred', now);
      if (
        !source ||
        source.userId !== actorId ||
        !profileAdmitted(db, scope, subjectId, source.at, 'write') ||
        (actorId !== subjectId && !profileAdmitted(db, scope, actorId, source.at, 'write')) ||
        !db.prepare('SELECT 1 FROM chats WHERE chat_id=? AND enabled=1').get(scope.chatId)
      )
        return 'blocked';

      if (
        sourceKind === 'inferred' &&
        !inferenceAllowed(db, scope, subjectId, source, slot, automatic)
      )
        return 'blocked';

      const participant = db
        .prepare('SELECT status FROM chat_participants WHERE chat_id=? AND user_id=?')
        .get(scope.chatId, subjectId) as { status: string } | undefined;
      if (
        (sourceKind === 'admin' && participant?.status !== 'present') ||
        (participant && !['present', 'unknown'].includes(participant.status))
      )
        return 'blocked';

      ensureProfile(db, scope.chatId, subjectId, source.at, now);

      const write = db
        .prepare(
          `INSERT INTO profile_facts(
        chat_id,user_id,field_key,value,source_kind,source_user_id,source_message_id,source_note,
        reliability,visibility,created_at,updated_at,generation,source_at,event_key,interest_key,change_kind
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        )
        .run(
          scope.chatId,
          subjectId,
          slot.fieldKey,
          slot.value,
          sourceKind,
          source.userId,
          source.messageId,
          change.kind === 'set' ? (change.sourceNote ?? null) : null,
          change.kind === 'set' ? change.reliability : 'unknown',
          change.kind === 'visibility' ? change.visibility : 'chat',
          now,
          now,
          scope.generation,
          source.at,
          eventKey(source.messageId),
          slot.interest,
          change.kind,
        );
      if (!write.changes) return 'duplicate';
      db.prepare(
        `UPDATE participant_profiles SET updated_at=max(updated_at,?)
        WHERE chat_id=? AND user_id=?`,
      ).run(now, scope.chatId, subjectId);
      return 'recorded';
    });
  }
  return { record, writePrivateFact };
}

/** Вход извлечения F5.7 с повторной проверкой исходной реплики в SQLite. */
const inference = new WeakMap<
  Storage,
  (scope: ConnectionScope, input: ProfileFactInput, mode?: 'automatic') => ProfileFactWriteResult
>();
export function registerProfileInference(
  storage: Storage,
  facts: ReturnType<typeof createProfileFactStore>,
) {
  inference.set(storage, (scope, input, mode) =>
    facts.record(scope, input.subjectId, 'inferred', input, mode === 'automatic'),
  );
}
export function profileInference(storage: Storage) {
  const record = inference.get(storage);
  requireInput(record !== undefined);
  return record;
}
