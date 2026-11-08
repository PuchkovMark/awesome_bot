import { randomInt } from 'node:crypto';
import { normalize } from './gameEngine.js';

export type MafiaDifficulty = 1 | 2 | 3 | 4;
export type MafiaRole = 'villager' | 'mafia' | 'don' | 'doctor' | 'commissioner' | 'maniac';
export type MafiaFaction = 'town' | 'mafia' | 'maniac';
export type MafiaActionKind = 'kill' | 'save' | 'inspect' | 'don-inspect';

export interface MafiaSettings {
  difficulty: MafiaDifficulty;
  minPlayers: number;
  maxPlayers: number;
  targetPlayers: number | null;
  recruitmentSeconds: number;
  nightSeconds: number;
  discussionSeconds: number;
  votingSeconds: number;
  allowRevote: boolean;
  revealRole: boolean;
  allowDeadTalk: boolean;
  allowSpectate: boolean;
  mafiaCount: number | null;
  hasDon: boolean | null;
  hasDoctor: boolean | null;
  hasCommissioner: boolean | null;
  hasManiac: boolean | null;
}

export interface MafiaPlayerState {
  vkUserId: string;
  name: string;
  role: MafiaRole | null;
  alive: boolean;
  selfHealUsed: boolean;
}

export interface MafiaNightAction {
  kind: MafiaActionKind;
  targetId: string;
}

export interface MafiaBallotResult {
  counts: Record<string, number>;
  leaders: string[];
  eliminatedId: string | null;
}

const difficultyDefaults: Record<
  MafiaDifficulty,
  { donFrom: number; doctorFrom: number; commissionerFrom: number; maniacFrom: number }
> = {
  1: { donFrom: Infinity, doctorFrom: 7, commissionerFrom: Infinity, maniacFrom: Infinity },
  2: { donFrom: 10, doctorFrom: 6, commissionerFrom: 8, maniacFrom: Infinity },
  3: { donFrom: 8, doctorFrom: 6, commissionerFrom: 7, maniacFrom: 10 },
  4: { donFrom: 7, doctorFrom: 5, commissionerFrom: 6, maniacFrom: 8 },
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function mafiaSettings(
  difficulty: MafiaDifficulty = 2,
  overrides: Partial<MafiaSettings> = {},
): MafiaSettings {
  const maxPlayers = boundedInteger(overrides.maxPlayers, 15, 5, 15);
  const minPlayers = boundedInteger(overrides.minPlayers, 5, 5, maxPlayers);
  const targetPlayers =
    overrides.targetPlayers === null || overrides.targetPlayers === undefined
      ? null
      : boundedInteger(overrides.targetPlayers, minPlayers, minPlayers, maxPlayers);
  return {
    difficulty,
    minPlayers,
    maxPlayers,
    targetPlayers,
    recruitmentSeconds: boundedInteger(overrides.recruitmentSeconds, 120, 30, 600),
    nightSeconds: boundedInteger(overrides.nightSeconds, 60, 15, 300),
    discussionSeconds: boundedInteger(overrides.discussionSeconds, 90, 15, 600),
    votingSeconds: boundedInteger(overrides.votingSeconds, 45, 10, 300),
    allowRevote: overrides.allowRevote ?? true,
    revealRole: overrides.revealRole ?? true,
    allowDeadTalk: overrides.allowDeadTalk ?? false,
    allowSpectate: overrides.allowSpectate ?? true,
    mafiaCount:
      overrides.mafiaCount === null || overrides.mafiaCount === undefined
        ? null
        : boundedInteger(overrides.mafiaCount, 1, 1, 7),
    hasDon: overrides.hasDon ?? null,
    hasDoctor: overrides.hasDoctor ?? null,
    hasCommissioner: overrides.hasCommissioner ?? null,
    hasManiac: overrides.hasManiac ?? null,
  };
}

export function roleComposition(playerCount: number, settings: MafiaSettings): MafiaRole[] {
  if (!Number.isInteger(playerCount) || playerCount < 5 || playerCount > 15) {
    throw new Error('Для игры в мафию нужно от 5 до 15 игроков.');
  }
  const defaults = difficultyDefaults[settings.difficulty];
  const maxMafia = Math.floor((playerCount - 1) / 2);
  const defaultMafia = Math.max(1, Math.floor(playerCount / 4));
  const mafiaCount = settings.mafiaCount ?? Math.min(defaultMafia, maxMafia);
  if (mafiaCount < 1 || mafiaCount > maxMafia) {
    throw new Error(`Для ${playerCount} игроков допустимо от 1 до ${maxMafia} мафиози.`);
  }
  const hasDon = settings.hasDon ?? (playerCount >= defaults.donFrom && mafiaCount >= 2);
  const hasDoctor = settings.hasDoctor ?? playerCount >= defaults.doctorFrom;
  const hasCommissioner = settings.hasCommissioner ?? playerCount >= defaults.commissionerFrom;
  const hasManiac = settings.hasManiac ?? playerCount >= defaults.maniacFrom;
  const specials = Number(hasDoctor) + Number(hasCommissioner) + Number(hasManiac);
  if (hasDon && mafiaCount < 2) {
    throw new Error('Для роли дона нужны как минимум два мафиози.');
  }
  if (mafiaCount + specials >= playerCount) {
    throw new Error('Этот набор ролей не оставляет места мирным жителям.');
  }

  const roles: MafiaRole[] = [];
  for (let index = 0; index < mafiaCount; index += 1) {
    roles.push(hasDon && index === 0 ? 'don' : 'mafia');
  }
  if (hasDoctor) roles.push('doctor');
  if (hasCommissioner) roles.push('commissioner');
  if (hasManiac) roles.push('maniac');
  while (roles.length < playerCount) roles.push('villager');
  return roles;
}

export function shuffleRoles(
  roles: readonly MafiaRole[],
  randomIndex: (maxExclusive: number) => number = (maxExclusive) => randomInt(maxExclusive),
): MafiaRole[] {
  const shuffled = [...roles];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new Error('Источник случайных чисел вернул индекс вне диапазона.');
    }
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

export function mafiaFaction(role: MafiaRole): MafiaFaction {
  if (role === 'mafia' || role === 'don') return 'mafia';
  if (role === 'maniac') return 'maniac';
  return 'town';
}

export function mafiaRoleLabel(role: MafiaRole): string {
  return {
    villager: 'Мирный житель',
    mafia: 'Мафия',
    don: 'Дон мафии',
    doctor: 'Доктор',
    commissioner: 'Комиссар',
    maniac: 'Маньяк',
  }[role];
}

export function mafiaRoleBrief(role: MafiaRole): string {
  return {
    villager: 'Днём обсуждай подозрения и голосуй за исключение игрока.',
    mafia: 'Ночью тайно выбирай цель вместе с мафией; днём не выдавай свою роль.',
    don: 'Ночью голосуй за цель мафии. Командой «проверить N» можешь искать комиссара.',
    doctor: 'Ночью выбери игрока для спасения. Себя можно лечить только один раз за партию.',
    commissioner: 'Ночью выбери игрока для проверки; результат придёт только тебе.',
    maniac: 'Ночью самостоятельно выбери цель. Победи, оставшись последним игроком.',
  }[role];
}

export function parseNightAction(text: string, role: MafiaRole): MafiaNightAction | null {
  const normalized = normalize(text)
    .replace(/[.!?]+$/u, '')
    .trim();
  const target = normalized.match(/(?:^|\s)(\d{1,2})$/u)?.[1];
  if (!target) return null;
  const explicitTarget = Number(target);
  if (!Number.isInteger(explicitTarget) || explicitTarget < 1 || explicitTarget > 15) return null;
  const command = normalized.slice(0, normalized.length - target.length).trim();
  if (role === 'commissioner' && /^(?:проверить|проверка|проверь)$/u.test(command)) {
    return { kind: 'inspect', targetId: String(explicitTarget) };
  }
  if (role === 'don' && /^(?:проверить|проверка|проверь)$/u.test(command)) {
    return { kind: 'don-inspect', targetId: String(explicitTarget) };
  }
  if (
    (role === 'mafia' || role === 'don' || role === 'maniac') &&
    /^(?:убить|устранить|цель|мафия)?$/u.test(command)
  ) {
    return { kind: 'kill', targetId: String(explicitTarget) };
  }
  if (role === 'doctor' && /^(?:лечить|спасти|защитить|цель)?$/u.test(command)) {
    return { kind: 'save', targetId: String(explicitTarget) };
  }
  return null;
}

export function tallyMafiaVotes(
  votes: Readonly<Record<string, string>>,
  eligibleVoters: ReadonlySet<string>,
  eligibleTargets: ReadonlySet<string>,
): MafiaBallotResult {
  const counts: Record<string, number> = {};
  for (const [voterId, targetId] of Object.entries(votes)) {
    if (!eligibleVoters.has(voterId) || !eligibleTargets.has(targetId)) continue;
    counts[targetId] = (counts[targetId] ?? 0) + 1;
  }
  const highest = Math.max(0, ...Object.values(counts));
  const leaders =
    highest === 0 ? [] : Object.keys(counts).filter((targetId) => counts[targetId] === highest);
  return { counts, leaders, eliminatedId: leaders.length === 1 ? leaders[0]! : null };
}

export function determineMafiaWinner(players: readonly MafiaPlayerState[]): MafiaFaction | null {
  const alive = players.filter((player) => player.alive && player.role !== null);
  const mafia = alive.filter((player) => mafiaFaction(player.role!) === 'mafia').length;
  const maniac = alive.filter((player) => player.role === 'maniac').length;
  if (alive.length === 0) return null;
  if (mafia === 0 && maniac === 0) return 'town';
  if (mafia > 0 && mafia >= alive.length - mafia) return 'mafia';
  if (maniac === 1 && alive.length === 1) return 'maniac';
  return null;
}

export function resolveNightActions(
  players: readonly MafiaPlayerState[],
  actions: Readonly<Record<string, MafiaNightAction | MafiaNightAction[]>>,
): {
  eliminatedIds: string[];
  investigations: Array<{ actorId: string; targetId: string; result: string }>;
} {
  const byId = new Map(players.map((player) => [player.vkUserId, player]));
  const active = (playerId: string) => byId.get(playerId)?.alive === true;
  const allActions = Object.entries(actions).flatMap(([actorId, value]) =>
    (Array.isArray(value) ? value : [value]).map((action) => [actorId, action] as const),
  );
  const mafiaVotes = allActions.filter(
    ([actorId, action]) =>
      active(actorId) &&
      action.kind === 'kill' &&
      ['mafia', 'don'].includes(byId.get(actorId)?.role ?? ''),
  );
  const mafiaCounts = new Map<string, number>();
  for (const [, action] of mafiaVotes) {
    if (active(action.targetId)) {
      mafiaCounts.set(action.targetId, (mafiaCounts.get(action.targetId) ?? 0) + 1);
    }
  }
  const mostMafiaVotes = Math.max(0, ...mafiaCounts.values());
  const mafiaTargets = [...mafiaCounts.entries()]
    .filter(([, count]) => count === mostMafiaVotes && count > 0)
    .map(([targetId]) => targetId);
  const attacks = new Set<string>();
  if (mafiaTargets.length === 1) attacks.add(mafiaTargets[0]!);
  for (const [actorId, action] of allActions) {
    if (
      active(actorId) &&
      byId.get(actorId)?.role === 'maniac' &&
      action.kind === 'kill' &&
      active(action.targetId)
    ) {
      attacks.add(action.targetId);
    }
  }
  const saved = new Set<string>();
  for (const [actorId, action] of allActions) {
    const actor = byId.get(actorId);
    const target = byId.get(action.targetId);
    if (active(actorId) && actor?.role === 'doctor' && action.kind === 'save' && target?.alive) {
      if (actorId !== action.targetId || !actor.selfHealUsed) saved.add(action.targetId);
    }
  }
  const eliminatedIds = [...attacks].filter((targetId) => !saved.has(targetId));
  const investigations = allActions.flatMap(([actorId, action]) => {
    const actor = byId.get(actorId);
    const target = byId.get(action.targetId);
    if (!actor?.alive || !target?.alive || !target.role) return [];
    if (actor.role === 'commissioner' && action.kind === 'inspect') {
      return [
        {
          actorId,
          targetId: action.targetId,
          result: mafiaFaction(target.role!) === 'mafia' ? 'мафия' : 'не мафия',
        },
      ];
    }
    if (actor.role === 'don' && action.kind === 'don-inspect') {
      return [
        {
          actorId,
          targetId: action.targetId,
          result: target.role === 'commissioner' ? 'комиссар' : 'не комиссар',
        },
      ];
    }
    return [];
  });
  return { eliminatedIds, investigations };
}
