import type { LifecycleObservation } from '../../contracts/index';
import { validId, platformOf } from '../authorization/validation';
/** Структурная проверка не доказывает семантику confirmed: источник доверенный. */
export function observationOf(value: unknown, platform: string): LifecycleObservation {
  const unavailable: LifecycleObservation = { confidence: 'unavailable', bot: 'unknown' };
  try {
    if (!value || typeof value !== 'object') return unavailable;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (k) =>
          ![
            'confidence',
            'bot',
            'creatorId',
            'inviterId',
            'creatorChanged',
            'members',
            'departedIds',
          ].includes(k),
      )
    )
      return unavailable;
    if (
      !['confirmed', 'uncertain', 'unavailable'].includes(row.confidence as string) ||
      !['present', 'absent', 'unknown'].includes(row.bot as string)
    )
      return unavailable;
    const result: {
      confidence: LifecycleObservation['confidence'];
      bot: LifecycleObservation['bot'];
      creatorId?: Exclude<LifecycleObservation['creatorId'], undefined>;
      inviterId?: Exclude<LifecycleObservation['inviterId'], undefined>;
      creatorChanged?: boolean;
      departedIds?: readonly import('../../contracts/index').UserId[];
      members?: { complete: boolean; ids: NonNullable<LifecycleObservation['members']>['ids'] };
    } = {
      confidence: row.confidence as LifecycleObservation['confidence'],
      bot: row.bot as LifecycleObservation['bot'],
    };
    for (const key of ['creatorId', 'inviterId'] as const)
      if (Object.hasOwn(row, key)) {
        const id = row[key];
        if (id !== null && (!validId(id) || platformOf(id) !== platform)) return unavailable;
        result[key] = id as NonNullable<LifecycleObservation['creatorId']> | null;
      }
    if (Object.hasOwn(row, 'creatorChanged')) {
      if (typeof row.creatorChanged !== 'boolean') return unavailable;
      result.creatorChanged = row.creatorChanged;
    }
    if (Object.hasOwn(row, 'members')) {
      if (!row.members || typeof row.members !== 'object') return unavailable;
      const members = row.members as Record<string, unknown>;
      if (
        Object.keys(members).some((k) => !['ids', 'complete'].includes(k)) ||
        typeof members.complete !== 'boolean' ||
        !Array.isArray(members.ids)
      )
        return unavailable;
      if (members.ids.some((id) => !validId(id) || platformOf(id) !== platform)) return unavailable;
      result.members = { complete: members.complete, ids: Object.freeze([...members.ids]) };
    }
    if (Object.hasOwn(row, 'departedIds')) {
      if (
        !Array.isArray(row.departedIds) ||
        row.departedIds.some((id) => !validId(id) || platformOf(id) !== platform)
      )
        return unavailable;
      if (result.members?.ids.some((id) => (row.departedIds as unknown[]).includes(id)))
        return unavailable;
      result.departedIds = Object.freeze([...row.departedIds]);
    }
    return Object.freeze(result);
  } catch {
    return unavailable;
  }
}
