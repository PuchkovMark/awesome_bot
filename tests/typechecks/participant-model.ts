import type {
  ParticipantRecord,
  ParticipantProfileRecord,
  ProfileFactRecord,
} from '../../src/storage/index';
export const participant: ParticipantRecord = {
  chatId: 'test-a:chat',
  userId: 'test-a:user',
  joinedAt: null,
  role: 'unknown',
  roleObservedAt: null,
  status: 'unknown',
  statusObservedAt: null,
  lastSeenAt: null,
};
export const profile: ParticipantProfileRecord = {
  chatId: participant.chatId,
  userId: participant.userId,
  createdAt: 0,
  updatedAt: 0,
};
export const fact: ProfileFactRecord = {
  ...profile,
  id: 1,
  fieldKey: 'synthetic',
  value: 'Тест',
  sourceKind: 'inferred',
  sourceUserId: null,
  sourceMessageId: null,
  sourceNote: null,
  reliability: 'unknown',
  visibility: 'unknown',
};
// @ts-expect-error — роль владельца бота не является сведениями об участии.
export const invalidRole: ParticipantRecord = { ...participant, role: 'botOwner' };
// @ts-expect-error — произвольный статус не входит в словарь.
export const invalidStatus: ParticipantRecord = { ...participant, status: 'online' };
// @ts-expect-error — время числовое или явно null.
export const invalidTime: ParticipantRecord = { ...participant, joinedAt: 'today' };
// @ts-expect-error — id требует платформенного префикса.
export const invalidId: ParticipantRecord = { ...participant, userId: 'user' };
const { visibility, ...withoutVisibility } = fact;
export const visibilityExample = visibility;
// @ts-expect-error — нет default видимости.
export const missingVisibility: ProfileFactRecord = withoutVisibility;
const { reliability, ...withoutReliability } = fact;
export const reliabilityExample = reliability;
// @ts-expect-error — источник сам по себе не назначает надёжность.
export const missingReliability: ProfileFactRecord = withoutReliability;
// @ts-expect-error — источник ограничен согласованным словарём.
export const invalidSource: ProfileFactRecord = { ...fact, sourceKind: 'modelInstruction' };
// @ts-expect-error — произвольная аудитория не поддерживается.
export const invalidVisibility: ProfileFactRecord = { ...fact, visibility: 'allPlatforms' };
// @ts-expect-error — nullable поле обязательно по форме сохранённой записи.
export const missingObservation: ParticipantRecord = {
  chatId: 'a:c',
  userId: 'a:u',
  joinedAt: null,
  role: 'unknown',
  status: 'unknown',
  statusObservedAt: null,
  lastSeenAt: null,
};
