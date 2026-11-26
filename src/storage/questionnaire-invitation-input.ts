import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { readDisclosureGate } from './chat-disclosure-store';
import { profileAdmitted } from './personal-data-store';
import { participantProfileAvailable, readDeparture } from './participant-departures';
import { questionnaireMessageSequence } from './questionnaire-types';
import {
  isQuestionnaireMember,
  markQuestionnaireInput,
  questionnaireHour,
  questionnaireSource,
} from './questionnaire-input';
import { requireInput } from './validation';

export type InvitationReplyStatus = 'answer' | 'restart' | 'warning' | 'pending' | 'ignore';

interface Invitation {
  readonly windowId: number;
  readonly stage: 'warning' | 'questions';
  readonly template: string;
  readonly disclosure: number;
  readonly shownAt: number | null;
  readonly participation: number | null;
  readonly invited: number | null;
  readonly expectedAttempt: string | null;
  readonly inputFloor: number;
}
interface Attempt {
  readonly attempt: string;
  readonly state: string;
  readonly template: string;
}
const subject = '(chat_id,generation,user_id)=(?,?,?)';

function inspect(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  receipt: string,
  messageId: number,
  now: number,
):
  | { status: Exclude<InvitationReplyStatus, 'answer'> }
  | { status: 'answer'; invitation: Invitation; existing?: Attempt }
  | undefined {
  const sequence = questionnaireMessageSequence(receipt);
  if (sequence === null || scope.chatId === user) return;
  const invitation = db
    .prepare(
      `SELECT w.id AS windowId,p.stage,w.invitation_template AS template,
    w.invitation_disclosure AS disclosure,p.confirmed_at AS shownAt,m.invited,
    m.invitation_participation AS participation,m.invitation_attempt AS expectedAttempt,
    coalesce(b.input_floor,0) AS inputFloor
    FROM questionnaire_invitation_parts p JOIN greeting_windows w ON w.id=p.window_id
    LEFT JOIN greeting_members m ON m.window_id=w.id AND m.user_id=?
    LEFT JOIN connection_source_boundaries b ON b.chat_id=w.chat_id
    WHERE w.chat_id=? AND w.generation=? AND p.receipt=?
    ORDER BY p.started_at DESC LIMIT 1`,
    )
    .get(user, scope.chatId, scope.generation, sequence) as Invitation | undefined;
  if (!invitation) {
    const legacy = db
      .prepare(
        `SELECT 1 FROM greeting_windows w JOIN messages m ON m.id=w.invitation_message_id
      WHERE w.chat_id=? AND w.generation=? AND w.invitation_template IS NULL AND m.platform_message_id=?`,
      )
      .get(scope.chatId, scope.generation, receipt);
    return legacy ? { status: 'ignore' } : undefined;
  }
  if (
    invitation.invited !== 1 ||
    invitation.disclosure !== readDisclosureGate(db, scope).version ||
    !isQuestionnaireMember(db, scope, user) ||
    !profileAdmitted(db, scope, user, now, 'write')
  )
    return { status: 'ignore' };
  if (invitation.stage === 'warning') return { status: 'warning' };
  const departure = readDeparture(db, scope, user);
  if (
    !participantProfileAvailable(departure) ||
    invitation.participation !== (departure?.revision ?? 0)
  )
    return { status: 'ignore' };
  if (sequence <= invitation.inputFloor) return { status: 'restart' };
  if (invitation.shownAt === null) return { status: 'pending' };
  if (now < invitation.shownAt || now - invitation.shownAt >= questionnaireHour)
    return { status: 'restart' };

  const source = questionnaireSource(db, scope, user, messageId, now);
  if (
    !source?.text.trim() ||
    (questionnaireMessageSequence(source.platformMessageId) ?? 0) <= sequence
  )
    return { status: 'ignore' };
  const existing = db
    .prepare(`SELECT attempt,state,template FROM questionnaire_progress WHERE ${subject}`)
    .get(scope.chatId, scope.generation, user) as Attempt | undefined;
  if (
    (invitation.expectedAttempt !== null && invitation.expectedAttempt !== existing?.attempt) ||
    (existing && (existing.template !== invitation.template || existing.state === 'paused'))
  )
    return { status: 'restart' };
  if (existing && (existing.state === 'processing' || existing.state === 'completed'))
    return { status: 'ignore' };
  return { status: 'answer', invitation, ...(existing ? { existing } : {}) };
}

export function questionnaireInvitationReply(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  receipt: string,
  messageId: number,
  now: number,
) {
  return inspect(db, scope, user, receipt, messageId, now)?.status;
}

export function acceptInvitationInput(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  receipt: string,
  messageId: number,
  now: number,
) {
  requireInput(db.inTransaction);
  const selected = inspect(db, scope, user, receipt, messageId, now);
  if (selected?.status !== 'answer') return false;
  const { invitation, existing } = selected;
  const key = [scope.chatId, scope.generation, user] as const;
  const attempt = existing?.attempt ?? randomUUID();
  if (!existing) {
    db.prepare(
      `INSERT INTO questionnaire_progress
      (chat_id,generation,user_id,attempt,presentation,template,state,shown_at,shown_message_id)
      VALUES(?,?,?,?,?,?,'active',?,?)`,
    ).run(...key, attempt, randomUUID(), invitation.template, invitation.shownAt, Number(receipt));
  } else if (existing.state !== 'active') {
    db.prepare(
      `UPDATE questionnaire_progress SET shown_at=?,shown_message_id=? WHERE ${subject}`,
    ).run(invitation.shownAt, Number(receipt), ...key);
  }
  db.prepare(
    'UPDATE greeting_members SET invitation_attempt=? WHERE window_id=? AND user_id=?',
  ).run(attempt, invitation.windowId, user);
  return markQuestionnaireInput(db, scope, user, attempt, messageId);
}
