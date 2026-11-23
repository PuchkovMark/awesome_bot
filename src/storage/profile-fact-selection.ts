import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import type {
  FactReliability,
  FactSourceKind,
  FactVisibility,
  OwnProfileFact,
} from './participant-types';
import { historyBounds } from './history-retention-store';
import { profileAdmitted } from './personal-data-store';
import { requireInput } from './validation';

function normalizedInterest(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function interestKey(interest: string): string {
  requireInput(typeof interest === 'string');
  const result = normalizedInterest(interest);
  requireInput(Boolean(result) && !result.includes('\0'));
  return result;
}

export type ProfileQuery =
  | { readonly kind: 'profile'; readonly subjectId: UserId }
  | { readonly kind: 'interest'; readonly interest: string };

interface FactRow {
  readonly id: number;
  readonly messageRowId: number | null;
  readonly sourceMessageId: string | null;
  readonly sourceAt: number | null;
  readonly eventKey: string | null;
  readonly userId: UserId;
  readonly fieldKey: string;
  readonly interest: string;
  readonly value: string;
  readonly kind: 'set' | 'visibility' | 'withdraw';
  readonly sourceKind: FactSourceKind;
  readonly visibility: FactVisibility;
  readonly reliability: FactReliability;
  readonly legacy: number;
  readonly rejected: number;
}
export const sourcePriority = { self: 3, admin: 2, inferred: 1 } as const;

interface Slot {
  fact?: FactRow;
  restriction?: FactRow;
  legacyRestriction?: FactVisibility;
}

function selectSlots(db: Database, scope: ConnectionScope, query: ProfileQuery, now: number) {
  if (!db.prepare('SELECT 1 FROM chats WHERE chat_id=? AND enabled=1').get(scope.chatId))
    return new Map<UserId, Map<string, Slot>>();

  const bounds = historyBounds(db, scope.chatId, now);
  const profile = query.kind === 'profile';
  const condition = profile
    ? 'f.user_id=?'
    : "f.field_key='interest' AND (f.interest_key=? OR f.generation IS NULL)";
  const rows = db
    .prepare(
      `SELECT f.id, f.user_id AS userId, f.field_key AS fieldKey, f.interest_key AS interest,
      f.change_kind AS kind, f.source_kind AS sourceKind, f.value, f.visibility, f.reliability,
      f.source_message_id AS sourceMessageId,f.source_at AS sourceAt,f.event_key AS eventKey,
    f.generation IS NULL AS legacy, r.fact_id IS NOT NULL AS rejected,
      CASE WHEN f.source_kind <> 'self' THEN (SELECT m.id FROM messages m
        WHERE m.chat_id=f.chat_id AND m.platform_message_id=f.source_message_id) END AS messageRowId
    FROM profile_facts f JOIN chat_participants p USING(chat_id,user_id)
    LEFT JOIN profile_fact_rejections r ON r.fact_id=f.id
    WHERE f.chat_id=? AND (f.generation=? OR (f.generation IS NULL AND f.visibility<>'chat'))
      AND ${profile ? "p.status IN ('present','unknown')" : "p.status='present'"} AND ${condition}
      AND (f.source_kind='self' OR f.generation IS NULL OR EXISTS (
        SELECT 1 FROM personal_visible_messages m
        WHERE m.chat_id=f.chat_id AND m.platform_message_id=f.source_message_id
          AND m.id>? AND m.timestamp>?
      ))
    ORDER BY f.source_at DESC, f.event_key COLLATE BINARY DESC, (f.change_kind='withdraw') DESC, f.id`,
    )
    .all(
      scope.chatId,
      scope.generation,
      profile ? query.subjectId : query.interest,
      bounds.clearedThrough,
      bounds.expiredThrough,
    ) as FactRow[];

  const byUser = new Map<UserId, Map<string, Slot>>();
  for (const row of rows) {
    const interest =
      row.legacy && row.fieldKey === 'interest' ? normalizedInterest(row.value) : row.interest;
    if (query.kind === 'interest' && interest !== query.interest) continue;
    const key = row.fieldKey + '\0' + interest;
    let slots = byUser.get(row.userId);
    if (!slots) {
      slots = new Map<string, Slot>();
      byUser.set(row.userId, slots);
    }
    let slot = slots.get(key);
    if (!slot) {
      slot = {};
      slots.set(key, slot);
    }
    if (row.legacy) {
      // Старые строки не подтверждают допуск, но сохраняют уже известное ограничение.
      if (slot.legacyRestriction === undefined || row.visibility === 'unknown')
        slot.legacyRestriction = row.visibility;
    } else if (row.kind === 'visibility') {
      slot.restriction ??= row;
    } else if (
      !slot.fact ||
      sourcePriority[row.sourceKind] > sourcePriority[slot.fact.sourceKind]
    ) {
      slot.fact = row;
    }
  }

  return byUser;
}

function slotVisibility(slot: Slot): FactVisibility {
  return slot.restriction?.visibility ?? slot.legacyRestriction ?? slot.fact?.visibility ?? 'chat';
}

export function selectCurrentFacts(
  db: Database,
  scope: ConnectionScope,
  query: ProfileQuery,
  now: number,
) {
  const byUser = selectSlots(db, scope, query, now);
  const selected: { row: FactRow; restrictionId: number | null; visibility: FactVisibility }[] = [];
  for (const [user, slots] of byUser) {
    if (!profileAdmitted(db, scope, user, now)) continue;
    for (const slot of slots.values()) {
      const { fact, restriction } = slot;
      if (fact?.kind === 'set' && !fact.rejected)
        selected.push({
          row: fact,
          restrictionId: restriction?.id ?? null,
          visibility: slotVisibility(slot),
        });
    }
  }
  // Сортировка по строкам фактов сохраняет порядок не изменившихся позиций.
  return selected.sort((left, right) => left.row.id - right.row.id);
}

export function selectPublicFacts(
  db: Database,
  scope: ConnectionScope,
  query: ProfileQuery,
  now: number,
) {
  return selectCurrentFacts(db, scope, query, now).filter(
    ({ row, visibility }) =>
      visibility === 'chat' && (query.kind === 'profile' || row.sourceKind === 'self'),
  );
}

export function selectOwnProfile(
  db: Database,
  scope: ConnectionScope,
  actor: UserId,
  now: number,
): readonly OwnProfileFact[] {
  return selectCurrentFacts(db, scope, { kind: 'profile', subjectId: actor }, now).map(
    ({
      row: { id, fieldKey, value, sourceKind, reliability, interest },
      restrictionId,
      visibility,
    }) => ({
      fieldKey,
      value,
      sourceKind,
      reliability,
      interest,
      factId: id,
      restrictionId,
      visibility,
    }),
  );
}

export function ownInterestRestriction(
  db: Database,
  scope: ConnectionScope,
  actor: UserId,
  interest: string,
  now: number,
): FactVisibility {
  const slot = selectSlots(db, scope, { kind: 'profile', subjectId: actor }, now)
    .get(actor)
    ?.get('interest' + '\0' + interest);
  return slot ? slotVisibility(slot) : 'chat';
}
