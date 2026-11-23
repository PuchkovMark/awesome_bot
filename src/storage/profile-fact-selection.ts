import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import type { FactReliability, FactSourceKind, FactVisibility } from './participant-types';
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
  readonly userId: UserId;
  readonly fieldKey: string;
  readonly interest: string;
  readonly value: string;
  readonly kind: 'set' | 'visibility' | 'withdraw';
  readonly sourceKind: FactSourceKind;
  readonly visibility: FactVisibility;
  readonly reliability: FactReliability;
  readonly legacy: number;
}
const sourcePriority = { self: 3, admin: 2, inferred: 1 } as const;

interface Slot {
  fact?: FactRow;
  restriction?: FactRow;
  legacyRestriction?: FactVisibility;
}

export function selectPublicFacts(
  db: Database,
  scope: ConnectionScope,
  query: ProfileQuery,
  now: number,
) {
  if (!db.prepare('SELECT 1 FROM chats WHERE chat_id=? AND enabled=1').get(scope.chatId)) return [];

  const bounds = historyBounds(db, scope.chatId, now);
  const profile = query.kind === 'profile';
  const condition = profile
    ? 'f.user_id=?'
    : "f.field_key='interest' AND (f.interest_key=? OR f.generation IS NULL)";
  const rows = db
    .prepare(
      `SELECT f.id, f.user_id AS userId, f.field_key AS fieldKey, f.interest_key AS interest,
      f.change_kind AS kind, f.source_kind AS sourceKind, f.value, f.visibility, f.reliability,
      f.generation IS NULL AS legacy
    FROM profile_facts f JOIN chat_participants p USING(chat_id,user_id)
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

  const visible: { row: FactRow; restrictionId: number | null }[] = [];
  for (const [user, slots] of byUser) {
    if (!profileAdmitted(db, scope, user, now)) continue;
    for (const { fact, restriction, legacyRestriction } of slots.values()) {
      if (
        fact?.kind === 'set' &&
        (restriction?.visibility ?? legacyRestriction ?? fact.visibility) === 'chat' &&
        (profile || fact.sourceKind === 'self')
      )
        visible.push({ row: fact, restrictionId: restriction?.id ?? null });
    }
  }
  // Порядок зависит только от опубликованного набора, включая ноль совпадений.
  return visible.sort((left, right) => left.row.id - right.row.id);
}
