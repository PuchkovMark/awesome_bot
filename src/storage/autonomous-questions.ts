import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope } from '../contracts/index';
import {
  meetingAnswer,
  meetingChanged,
  meetingQuestion,
  sensitiveDialogue,
} from '../core/message-router/autonomous-rules';
import { historyBounds, historySourcesVisible } from './history-retention-store';
import type { InitiativeDenial } from './queue-types';
import { inQuietHours, readChatControl } from './chat-control-store';

const waitMs = 120_000;
const lifeMs = 300_000;
const dayMs = 86_400_000;

export function waitForQuestion(
  db: Database,
  scope: ConnectionScope,
  messageId: number,
  at: number,
  revision: number,
  controlRevision: number,
  disclosureVersion: number | null,
) {
  db.prepare(
    `INSERT INTO autonomous_questions
    (message_id,chat_id,generation,eligible_at,expires_at,revision,control_revision,disclosure_version)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  ).run(
    messageId,
    scope.chatId,
    scope.generation,
    at + waitMs,
    at + lifeMs,
    revision,
    controlRevision,
    disclosureVersion,
  );
}

interface WaitingQuestion {
  readonly messageId: number;
  readonly chatId: ChatId;
  readonly generation: number;
  readonly expiresAt: number;
  readonly revision: number;
  readonly controlRevision: number;
  readonly disclosureVersion: number | null;
}

export function dueQuestions(db: Database, now: number, platform?: string) {
  db.prepare(
    `DELETE FROM autonomous_questions AS q WHERE eligible_at<=? AND expires_at<=?
    AND NOT EXISTS (
      SELECT 1 FROM chat_connections c WHERE c.chat_id=q.chat_id AND c.generation=q.generation AND c.state='active'
    )`,
  ).run(now, now);
  const prefix = platform ? platform + ':' : null;
  return db
    .prepare(
      `SELECT q.message_id AS messageId,q.chat_id AS chatId,q.generation,q.expires_at AS expiresAt,
    q.revision,q.control_revision AS controlRevision,q.disclosure_version AS disclosureVersion
    FROM autonomous_questions q JOIN chat_connections c USING(chat_id,generation)
    WHERE q.eligible_at<=? AND c.state='active' AND (? IS NULL OR substr(q.chat_id,1,length(?))=?)
    ORDER BY q.eligible_at,q.message_id LIMIT 32`,
    )
    .all(now, prefix, prefix, prefix) as WaitingQuestion[];
}

export function removeWaitingQuestion(db: Database, id: number) {
  db.prepare('DELETE FROM autonomous_questions WHERE message_id=?').run(id);
}

function questionReceivedAnswer(db: Database, chatId: ChatId, messageId: number, now: number) {
  const bounds = historyBounds(db, chatId, now);
  return !!db
    .prepare(
      `SELECT 1 FROM messages
    WHERE chat_id=? AND id>? AND timestamp>? AND role='user' AND sender_bot IS NOT 1 LIMIT 1`,
    )
    .get(chatId, Math.max(messageId, bounds.clearedThrough), bounds.expiredThrough);
}

export function questionEvidence(
  db: Database,
  chatId: ChatId,
  messageId: number,
  now: number,
): { readonly id: number } | { readonly denial: InitiativeDenial } {
  if (!historySourcesVisible(db, chatId, [messageId], now)) return { denial: 'initiative_source' };
  if (questionReceivedAnswer(db, chatId, messageId, now)) return { denial: 'initiative_answered' };
  const origin = db
    .prepare('SELECT text,timestamp FROM messages WHERE chat_id=? AND id=?')
    .get(chatId, messageId) as { text: string; timestamp: number } | undefined;
  const question = origin && meetingQuestion(origin.text);
  if (!origin || !question) return { denial: 'initiative_source' };
  const bounds = historyBounds(db, chatId, now);
  const candidates = db
    .prepare(
      `SELECT id,text FROM messages
    WHERE chat_id=? AND id>? AND id<? AND timestamp>? AND timestamp<=? AND role='user' AND sender_bot=0
    AND purpose='conversation' AND length(text)<=1024 ORDER BY id DESC LIMIT 257`,
    )
    .all(
      chatId,
      bounds.clearedThrough,
      messageId,
      Math.max(origin.timestamp - dayMs, bounds.expiredThrough),
      origin.timestamp,
    ) as { id: number; text: string }[];
  if (candidates.length > 256) return { denial: 'initiative_source' };
  let evidence: { id: number; answer: string } | undefined;
  for (const candidate of candidates) {
    if (meetingChanged(question, candidate.text)) return { denial: 'initiative_source' };
    const answer = meetingAnswer(question, candidate.text);
    if (!answer) continue;
    if (evidence && evidence.answer !== answer) return { denial: 'initiative_source' };
    evidence ??= { id: candidate.id, answer };
  }
  return evidence ? { id: evidence.id } : { denial: 'initiative_source' };
}

export function initiativeDenial(
  db: Database,
  chatId: ChatId,
  messageId: number,
  evidenceId: number | undefined,
  delayed: boolean,
  now: number,
): InitiativeDenial | undefined {
  const state = readChatControl(db, chatId);
  if (!state.enabled || state.mode !== 'active') return 'initiative_mode';
  if (state.autonomousDisabled || (state.pausedUntil !== null && now < state.pausedUntil))
    return 'initiative_pause';
  if (inQuietHours(state, now)) return 'initiative_quiet_hours';
  if (!historySourcesVisible(db, chatId, [messageId], now)) return 'initiative_source';
  if (delayed) {
    if (evidenceId === undefined || !historySourcesVisible(db, chatId, [evidenceId], now))
      return 'initiative_source';
    if (questionReceivedAnswer(db, chatId, messageId, now)) return 'initiative_answered';
  }
  const origin = db
    .prepare('SELECT timestamp FROM messages WHERE chat_id=? AND id=?')
    .get(chatId, messageId) as { timestamp: number } | undefined;
  if (!origin) return 'initiative_source';
  const bounds = historyBounds(db, chatId, now);
  const since = Math.max(Math.min(now, origin.timestamp) - waitMs, bounds.expiredThrough);
  if (
    db
      .prepare(
        `SELECT 1 FROM messages WHERE chat_id=? AND sender_bot=1
      AND timestamp>? AND timestamp<=? AND id>? LIMIT 1`,
      )
      .get(chatId, since, now, bounds.clearedThrough)
  )
    return 'initiative_other_bot';
  const recent = db
    .prepare(
      `SELECT substr(text,1,4096) AS text,length(text)>4096 AS clipped FROM messages
    WHERE chat_id=? AND timestamp>? AND timestamp<=? AND id>? AND purpose='conversation'
    ORDER BY timestamp DESC,id DESC LIMIT 33`,
    )
    .all(chatId, since, now, bounds.clearedThrough) as { text: string; clipped: number }[];
  return recent.length > 32 ||
    recent.some(({ text, clipped }) => clipped === 1 || sensitiveDialogue(text))
    ? 'initiative_sensitive'
    : undefined;
}

export function cancelInitiatives(db: Database, chatId: ChatId) {
  db.prepare('DELETE FROM autonomous_questions WHERE chat_id=?').run(chatId);
  db.prepare(
    `UPDATE queue_jobs SET initiative_revision=NULL
    WHERE chat_id=? AND initiative_cause IS NOT NULL AND initiative_revision IS NOT NULL
    AND (state!='terminal' OR EXISTS (
      SELECT 1 FROM response_traces WHERE job_id=queue_jobs.id
      AND json_extract(payload,'$.publication.status') IN ('pending_checks','allowed')
    ))`,
  ).run(chatId);
}
