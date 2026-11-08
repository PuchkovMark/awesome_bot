import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { GameSession } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { logger } from '../../logger/index.js';
import senderService from '../sender/senderService.js';
import { difficultyInText, normalize } from './gameEngine.js';
import { serializeGameConversation } from './gameSessionLock.js';
import {
  determineMafiaWinner,
  mafiaFaction,
  mafiaRoleBrief,
  mafiaRoleLabel,
  mafiaSettings,
  parseNightAction,
  resolveNightActions,
  roleComposition,
  shuffleRoles,
  tallyMafiaVotes,
  type MafiaActionKind,
  type MafiaDifficulty,
  type MafiaFaction as MafiaWinner,
  type MafiaNightAction,
  type MafiaPlayerState,
  type MafiaRole,
  type MafiaSettings,
} from './mafiaEngine.js';

type MafiaPhase =
  'lobby' | 'dealing' | 'night' | 'discussion' | 'voting' | 'paused' | 'finished' | 'cancelled';
type MafiaDatabaseState = 'waiting' | 'active' | 'paused' | 'finished';
type MafiaSession = Pick<GameSession, 'id' | 'conversationId' | 'game' | 'state' | 'data'>;

interface MafiaState {
  version: 1;
  phase: MafiaPhase;
  creatorId: string;
  settings: MafiaSettings;
  futureSettings: Partial<MafiaSettings>;
  players: MafiaPlayerState[];
  deadlineAt: number | null;
  remainingMs: number | null;
  pausedPhase: MafiaPhase | null;
  nightNumber: number;
  votes: Record<string, string>;
  revoteRound: number;
  revoteCandidates: string[];
  nightActions: Record<string, MafiaNightAction[]>;
  rolesDelivered: string[];
  events: string[];
  winner: MafiaWinner | null;
  started: boolean;
  statsRecorded: boolean;
}

export interface MafiaRequestOptions {
  isGroup?: boolean;
  isAdmin?: boolean;
  canManageChat?: boolean;
  isReplyToBot?: boolean;
  allowNaturalStart?: boolean;
  eventId?: string;
  name?: string;
  settings?: Partial<MafiaSettings>;
}

export interface MafiaMessenger {
  canSendPrivateMessage(userId: string | number): Promise<boolean>;
  send(peerId: number, text: string, options?: { randomId?: number }): Promise<void>;
}

interface MafiaStartRequest {
  settings: Partial<MafiaSettings>;
}

class MafiaSessionConflict extends Error {}

const activeDatabaseStates: MafiaDatabaseState[] = ['waiting', 'active', 'paused'];
const gameSessionStates: MafiaDatabaseState[] = ['waiting', 'active', 'paused'];
const permissionReminder =
  'Открой личные сообщения сообщества и напиши Пеньку любое сообщение, затем попробуй начать партию ещё раз.';

export function detectMafiaStartRequest(text: string): MafiaStartRequest | null {
  const normalized = normalize(text);
  if (
    !/мафи/u.test(normalized) ||
    !/(?:давай|организуй|запусти|сыграем|сыграть|играем|хочу|играть|кто хочет|начни|поиграем)/u.test(
      normalized,
    )
  ) {
    return null;
  }
  const targetPlayers = normalized.match(
    /(?:на|до|состав)\s+(\d{1,2})\s*(?:игрок\w*|человек)?/u,
  )?.[1];
  const numericDifficulty = normalized.match(/(?:сложность|уровень)\s*(?:на\s*)?([1-4])/u)?.[1];
  const difficulty = numericDifficulty
    ? (Number(numericDifficulty) as MafiaDifficulty)
    : (difficultyInText(normalized) ?? 2);
  const settings: Partial<MafiaSettings> = {
    difficulty,
    ...(targetPlayers ? { targetPlayers: Number(targetPlayers) } : {}),
  };
  const seconds = normalized.match(/(\d{1,3})\s*(?:секунд\w*|сек\b)/u)?.[1];
  if (seconds) {
    if (/\bнабор\b/u.test(normalized)) settings.recruitmentSeconds = Number(seconds);
    if (/\bночь\b/u.test(normalized)) settings.nightSeconds = Number(seconds);
    if (/обсуждени/u.test(normalized)) settings.discussionSeconds = Number(seconds);
    if (/голосован/u.test(normalized)) settings.votingSeconds = Number(seconds);
  }
  return {
    settings,
  };
}

function isGroupPeer(conversationId: string): boolean {
  const peerId = Number(conversationId);
  return Number.isSafeInteger(peerId) && peerId >= 2_000_000_000;
}

function toDatabaseState(phase: MafiaPhase): MafiaDatabaseState {
  if (phase === 'lobby' || phase === 'dealing') return 'waiting';
  if (phase === 'paused') return 'paused';
  if (phase === 'finished' || phase === 'cancelled') return 'finished';
  return 'active';
}

function readState(session: MafiaSession): MafiaState {
  let value: unknown;
  try {
    value = JSON.parse(session.data) as unknown;
  } catch (error) {
    logger.error({ err: error, sessionId: session.id }, 'Mafia session contains invalid JSON');
    throw new Error('Не удалось прочитать сохранённое состояние партии в мафию.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Partial<MafiaState>).version !== 1 ||
    !Array.isArray((value as Partial<MafiaState>).players)
  ) {
    throw new Error(`Сохранённое состояние партии ${session.id} имеет неверный формат.`);
  }
  return value as MafiaState;
}

function isGameManager(state: MafiaState, userId: string, options: MafiaRequestOptions): boolean {
  return userId === state.creatorId || options.isAdmin === true || options.canManageChat === true;
}

function playerIndex(state: MafiaState, userId: string): number {
  return state.players.findIndex((player) => player.vkUserId === userId);
}

function renderPlayers(state: MafiaState): string {
  if (state.players.length === 0) return 'Пока никто не записался.';
  return state.players
    .map((player, index) => {
      const alive = player.alive ? '' : ' — выбыл';
      const role =
        !player.alive && state.settings.revealRole && player.role
          ? ` (${mafiaRoleLabel(player.role)})`
          : '';
      return `${index + 1}. ${player.name}${alive}${role}`;
    })
    .join('\n');
}

function renderFinishedResults(state: MafiaState): string {
  const winner = state.winner
    ? { town: 'мирные жители', mafia: 'мафия', maniac: 'маньяк' }[state.winner]
    : 'победителя нет';
  const roles = state.players
    .map(
      (player, index) =>
        `${index + 1}. ${player.name} — ${player.role ? mafiaRoleLabel(player.role) : 'роль не выдана'}`,
    )
    .join('\n');
  return `🏁 Партия завершена. Победили: ${winner}.\n\nРоли:\n${roles}\n\nХод партии:\n${state.events.slice(-20).join('\n') || 'Событий нет.'}`;
}

function phaseDescription(state: MafiaState): string {
  switch (state.phase) {
    case 'lobby':
      return `Набор игроков: ${state.players.length}/${state.settings.maxPlayers}. Нужно минимум ${state.settings.minPlayers}.`;
    case 'dealing':
      return 'Подготавливаю личную раздачу ролей.';
    case 'night':
      return `Ночь ${state.nightNumber}. Осталось игроков: ${state.players.filter((player) => player.alive).length}.`;
    case 'discussion':
      return `День ${state.nightNumber}. Идёт обсуждение; осталось игроков: ${state.players.filter((player) => player.alive).length}.`;
    case 'voting':
      return `Голосование${state.revoteRound > 0 ? ' (переголосование)' : ''}.`;
    case 'paused':
      return 'Партия приостановлена.';
    case 'finished':
      return 'Партия завершена.';
    case 'cancelled':
      return 'Набор отменён.';
  }
}

function stableRandomId(sessionId: string, userId: string, kind: string): number {
  const digest = createHash('sha256').update(`${sessionId}:${userId}:${kind}`).digest();
  return (digest.readUInt32BE(0) % 2_147_483_646) + 1;
}

function displayDuration(seconds: number): string {
  return seconds >= 60
    ? `${Math.floor(seconds / 60)} мин${seconds % 60 ? ` ${seconds % 60} сек` : ''}`
    : `${seconds} сек`;
}

function roleFaction(role: MafiaRole | null): MafiaWinner | null {
  return role ? mafiaFaction(role) : null;
}

function parseTargetText(text: string): string | null {
  const normalized = normalize(text)
    .replace(/^(?:голосую|голос|голос за|за|обвиняю|выбираю)\s+/u, '')
    .trim();
  const mention = normalized.match(/(?:id|club)(\d+)/u)?.[1];
  return mention ?? normalized;
}

function phaseEvent(label: string, state: MafiaState): void {
  state.events.push(`День ${state.nightNumber}: ${label}`);
  if (state.events.length > 100) state.events.splice(0, state.events.length - 100);
}

export class MafiaService {
  constructor(private readonly messenger: MafiaMessenger = senderService) {}

  private async getActiveSession(conversationId: string): Promise<MafiaSession | null> {
    return prisma.gameSession.findFirst({
      where: {
        conversationId,
        game: 'mafia',
        state: { in: activeDatabaseStates },
      },
      select: { id: true, conversationId: true, game: true, state: true, data: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async getLatestFinishedSession(conversationId: string): Promise<MafiaSession | null> {
    return prisma.gameSession.findFirst({
      where: { conversationId, game: 'mafia', state: 'finished' },
      select: { id: true, conversationId: true, game: true, state: true, data: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async getSessionsForPlayer(userId: string): Promise<MafiaSession[]> {
    const sessions = await prisma.gameSession.findMany({
      where: { game: 'mafia', state: { in: activeDatabaseStates } },
      select: { id: true, conversationId: true, game: true, state: true, data: true },
      orderBy: { updatedAt: 'desc' },
    });
    return sessions.filter((session) =>
      readState(session).players.some((player) => player.vkUserId === userId),
    );
  }

  private async persist(
    session: MafiaSession,
    state: MafiaState,
    options: { eventId?: string; userId?: string; kind?: string } = {},
  ): Promise<boolean> {
    const targetState = toDatabaseState(state.phase);
    try {
      await prisma.$transaction(async (tx) => {
        if (options.eventId && options.userId) {
          await tx.gameEvent.create({
            data: {
              sessionId: session.id,
              vkUserId: options.userId,
              eventId: options.eventId,
              kind: options.kind ?? 'mafia-action',
            },
          });
        }
        if (state.phase === 'finished' && state.started && !state.statsRecorded) {
          await this.recordStats(tx, session, state);
          state.statsRecorded = true;
        }
        const result = await tx.gameSession.updateMany({
          where: { id: session.id, state: session.state, data: session.data },
          data: {
            state: targetState,
            data: JSON.stringify(state),
            ...(state.phase === 'finished' || state.phase === 'cancelled'
              ? { endedAt: new Date() }
              : {}),
          },
        });
        if (result.count !== 1)
          throw new MafiaSessionConflict('Mafia session changed concurrently');
      });
      return true;
    } catch (error) {
      if (error instanceof MafiaSessionConflict) return false;
      if (
        options.eventId &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      logger.error({ err: error, sessionId: session.id }, 'Failed to persist Mafia session');
      throw error;
    }
  }

  private async recordStats(
    tx: Prisma.TransactionClient,
    session: MafiaSession,
    state: MafiaState,
  ): Promise<void> {
    for (const player of state.players) {
      const isWinner = state.winner !== null && roleFaction(player.role) === state.winner;
      const localWhere = {
        scope_scopeId_vkUserId: {
          scope: 'conversation',
          scopeId: session.conversationId,
          vkUserId: player.vkUserId,
        },
      };
      const local = await tx.gamePlayerStats.findUnique({ where: localWhere });
      const updateStats = {
        gamesPlayed: { increment: 1 },
        wins: { increment: isWinner ? 1 : 0 },
        currentWinStreak: isWinner ? { increment: 1 } : 0,
        bestWinStreak: isWinner
          ? Math.max(local?.bestWinStreak ?? 0, (local?.currentWinStreak ?? 0) + 1)
          : (local?.bestWinStreak ?? 0),
      };
      await tx.gamePlayerStats.upsert({
        where: localWhere,
        create: {
          scope: 'conversation',
          scopeId: session.conversationId,
          vkUserId: player.vkUserId,
          gamesPlayed: 1,
          wins: isWinner ? 1 : 0,
          currentWinStreak: isWinner ? 1 : 0,
          bestWinStreak: isWinner ? 1 : 0,
        },
        update: updateStats,
      });
      const globalWhere = {
        scope_scopeId_vkUserId: {
          scope: 'global',
          scopeId: 'global',
          vkUserId: player.vkUserId,
        },
      };
      const global = await tx.gamePlayerStats.findUnique({ where: globalWhere });
      if (global?.excludedFromGlobal) continue;
      await tx.gamePlayerStats.upsert({
        where: globalWhere,
        create: {
          scope: 'global',
          scopeId: 'global',
          vkUserId: player.vkUserId,
          gamesPlayed: 1,
          wins: isWinner ? 1 : 0,
          currentWinStreak: isWinner ? 1 : 0,
          bestWinStreak: isWinner ? 1 : 0,
        },
        update: {
          gamesPlayed: { increment: 1 },
          wins: { increment: isWinner ? 1 : 0 },
          currentWinStreak: isWinner ? { increment: 1 } : 0,
          bestWinStreak: isWinner
            ? Math.max(global?.bestWinStreak ?? 0, (global?.currentWinStreak ?? 0) + 1)
            : (global?.bestWinStreak ?? 0),
        },
      });
    }
  }

  private async hasProcessed(session: MafiaSession, eventId?: string): Promise<boolean> {
    if (!eventId) return false;
    return Boolean(
      await prisma.gameEvent.findUnique({
        where: { sessionId_eventId: { sessionId: session.id, eventId } },
        select: { id: true },
      }),
    );
  }

  private async start(
    conversationId: string,
    userId: string,
    options: MafiaRequestOptions,
  ): Promise<string> {
    if (!(options.isGroup ?? isGroupPeer(conversationId))) {
      return 'В мафию можно играть только в групповой беседе.';
    }
    return serializeGameConversation(conversationId, async () => {
      const existing = await this.getActiveSession(conversationId);
      if (existing) {
        const current = readState(existing);
        return current.phase === 'lobby'
          ? `Набор уже идёт.\n${phaseDescription(current)}\n${renderPlayers(current)}`
          : `В этой беседе уже идёт партия в мафию. ${phaseDescription(current)}`;
      }
      const otherGame = await prisma.gameSession.findFirst({
        where: { conversationId, state: { in: gameSessionStates } },
        select: { id: true },
      });
      if (otherGame) return 'В этой беседе уже идёт другая игра. Сначала завершите её.';

      const storedSettings = await prisma.gameSession.findFirst({
        where: { conversationId, game: 'mafia', state: 'finished' },
        select: { data: true },
        orderBy: { updatedAt: 'desc' },
      });
      let inheritedSettings: Partial<MafiaSettings> = {};
      if (storedSettings) {
        try {
          const previous = JSON.parse(storedSettings.data) as Partial<MafiaState>;
          inheritedSettings = previous.futureSettings ?? {};
        } catch (error) {
          logger.warn({ err: error, conversationId }, 'Unable to load previous Mafia settings');
        }
      }
      const inputSettings = { ...inheritedSettings, ...options.settings };
      const difficulty = inputSettings.difficulty ?? 2;
      const settings = mafiaSettings(difficulty, inputSettings);
      if (settings.targetPlayers !== null && settings.targetPlayers < settings.minPlayers) {
        return `Для начала партии нужно не меньше ${settings.minPlayers} игроков.`;
      }
      await prisma.conversation.upsert({
        where: { id: conversationId },
        create: { id: conversationId, isGroup: true },
        update: {},
      });
      const state: MafiaState = {
        version: 1,
        phase: 'lobby',
        creatorId: userId,
        settings,
        futureSettings: {},
        players: [
          {
            vkUserId: userId,
            name: options.name?.trim() || 'Участник',
            role: null,
            alive: true,
            selfHealUsed: false,
          },
        ],
        deadlineAt: Date.now() + settings.recruitmentSeconds * 1000,
        remainingMs: null,
        pausedPhase: null,
        nightNumber: 0,
        votes: {},
        revoteRound: 0,
        revoteCandidates: [],
        nightActions: {},
        rolesDelivered: [],
        events: [],
        winner: null,
        started: false,
        statsRecorded: false,
      };
      await prisma.gameSession.create({
        data: {
          conversationId,
          game: 'mafia',
          state: 'waiting',
          data: JSON.stringify(state),
        },
      });
      return `🕵️ Начинаю набор в «Мафию»!\n${phaseDescription(state)}\nУчастники, напишите «я играю». Чтобы выйти до начала — «выйти из игры». Список: «игроки». Начать может организатор после набора минимума; автоматически проверю состав через ${displayDuration(settings.recruitmentSeconds)}.`;
    });
  }

  async startGame(
    conversationId: string,
    userId: string,
    options: MafiaRequestOptions = {},
  ): Promise<string> {
    return this.start(conversationId, userId, options);
  }

  private async beginParty(
    session: MafiaSession,
    state: MafiaState,
    triggerUserId?: string,
  ): Promise<string> {
    if (state.players.length < state.settings.minPlayers) {
      return `Пока мало игроков: ${state.players.length}/${state.settings.minPlayers}. Набор остаётся открытым.`;
    }
    let roles: MafiaRole[];
    try {
      roles = roleComposition(state.players.length, state.settings);
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'Не удалось подобрать сбалансированный состав ролей.';
    }

    const unavailable: string[] = [];
    try {
      for (const player of state.players) {
        if (!(await this.messenger.canSendPrivateMessage(player.vkUserId))) {
          unavailable.push(player.name);
        }
      }
    } catch (error) {
      logger.error({ err: error, sessionId: session.id }, 'Mafia private-message preflight failed');
      return 'Не удалось проверить доставку личных сообщений VK. Роли не распределены; попробуйте начать ещё раз.';
    }
    if (unavailable.length > 0) {
      return `Не могу начать: у следующих игроков закрыты личные сообщения боту: ${unavailable.join(', ')}.\n${permissionReminder}\nОни могут открыть сообщения или выйти из набора; затем повторите «начинай».`;
    }

    const shuffled = shuffleRoles(roles);
    state.players.forEach((player, index) => {
      player.role = shuffled[index]!;
      player.alive = true;
      player.selfHealUsed = false;
    });
    state.phase = 'dealing';
    state.deadlineAt = null;
    state.remainingMs = null;
    state.rolesDelivered = [];
    phaseEvent('роли распределены приватно', state);
    if (
      !(await this.persist(session, state, { userId: triggerUserId, kind: 'mafia-deal-start' }))
    ) {
      return 'Партия уже была изменена другим событием; повторите команду.';
    }
    const preparedSession: MafiaSession = {
      ...session,
      state: toDatabaseState(state.phase),
      data: JSON.stringify(state),
    };
    return this.deliverRoles(preparedSession, state, triggerUserId);
  }

  private roleMessage(state: MafiaState, player: MafiaPlayerState): string {
    const playerNumber = playerIndex(state, player.vkUserId) + 1;
    const allies =
      player.role === 'mafia' || player.role === 'don'
        ? state.players
            .map((candidate, index) =>
              candidate.vkUserId !== player.vkUserId &&
              (candidate.role === 'mafia' || candidate.role === 'don')
                ? `${index + 1}. ${candidate.name}`
                : null,
            )
            .filter((name): name is string => name !== null)
        : [];
    return [
      `🎭 Твоя роль в партии «Мафия» — ${mafiaRoleLabel(player.role!)}.`,
      mafiaRoleBrief(player.role!),
      `Твой номер игрока: ${playerNumber}.`,
      ...(allies.length > 0 ? [`Твои союзники: ${allies.join('; ')}.`] : []),
      'Не раскрывай эту личную информацию в общей беседе. Игровые ночные действия принимай только здесь, в личных сообщениях боту.',
    ].join('\n\n');
  }

  private async deliverRoles(
    session: MafiaSession,
    state: MafiaState,
    triggerUserId?: string,
  ): Promise<string> {
    let currentSession = session;
    for (const player of state.players) {
      if (state.rolesDelivered.includes(player.vkUserId)) continue;
      try {
        await this.messenger.send(Number(player.vkUserId), this.roleMessage(state, player), {
          randomId: stableRandomId(session.id, player.vkUserId, 'role'),
        });
      } catch (error) {
        logger.error(
          { err: error, sessionId: session.id, vkUserId: player.vkUserId },
          'Failed to deliver a Mafia role privately',
        );
        state.phase = 'cancelled';
        state.deadlineAt = null;
        state.players.forEach((participant) => {
          participant.role = null;
          participant.alive = false;
        });
        state.events = [];
        state.rolesDelivered = [];
        await this.persist(currentSession, state, {
          userId: triggerUserId,
          kind: 'mafia-deal-failed',
        });
        return `Не удалось доставить личную роль игроку ${player.name}; партию отменил. Роли в беседе не раскрываю. Проверьте личные сообщения и создайте новый набор.`;
      }
      state.rolesDelivered.push(player.vkUserId);
      if (
        !(await this.persist(currentSession, state, {
          userId: triggerUserId,
          kind: 'mafia-role-delivered',
        }))
      ) {
        return 'Состояние раздачи изменилось; проверьте список игроков и повторите команду запуска.';
      }
      currentSession = {
        ...currentSession,
        state: toDatabaseState(state.phase),
        data: JSON.stringify(state),
      };
    }

    state.phase = 'night';
    state.started = true;
    state.nightNumber = 1;
    state.deadlineAt = Date.now() + state.settings.nightSeconds * 1000;
    state.nightActions = {};
    phaseEvent('наступила ночь', state);
    if (
      !(await this.persist(currentSession, state, {
        userId: triggerUserId,
        kind: 'mafia-night-start',
      }))
    ) {
      return 'Не удалось сохранить начало ночи. Роли доставлены, состояние партии восстановится автоматически.';
    }
    const activeSession: MafiaSession = {
      ...currentSession,
      state: 'active',
      data: JSON.stringify(state),
    };
    await this.sendNightPrompts(activeSession, state);
    return `🔒 Роли отправлены в личные сообщения. Началась ночь ${state.nightNumber} (${displayDuration(state.settings.nightSeconds)}). Ночные действия принимаю только в личке.`;
  }

  private async sendNightPrompts(session: MafiaSession, state: MafiaState): Promise<void> {
    for (const player of state.players) {
      if (!player.alive || !player.role) continue;
      const prompts: string[] = [];
      if (player.role === 'mafia' || player.role === 'don') {
        prompts.push(
          `🌙 Ночь ${state.nightNumber}. Выберите цель мафии: отправьте «убить N», где N — номер игрока.`,
        );
      }
      if (player.role === 'doctor') {
        prompts.push(
          `🌙 Ночь ${state.nightNumber}. Кого спасёшь? Отправь «лечить N». Себя можно лечить один раз за партию.`,
        );
      }
      if (player.role === 'commissioner') {
        prompts.push(
          `🌙 Ночь ${state.nightNumber}. Кого проверить? Отправь «проверить N». Результат увижу только ты.`,
        );
      }
      if (player.role === 'maniac') {
        prompts.push(`🌙 Ночь ${state.nightNumber}. Выбери цель: отправь «убить N».`);
      }
      if (player.role === 'don') {
        prompts.push(
          'Как дон, дополнительно можешь отправить «проверить N», чтобы узнать, комиссар ли выбранный игрок.',
        );
      }
      for (const prompt of prompts) {
        try {
          await this.messenger.send(Number(player.vkUserId), prompt, {
            randomId: stableRandomId(
              session.id,
              player.vkUserId,
              `night-${state.nightNumber}-${prompt.length}`,
            ),
          });
        } catch (error) {
          logger.warn(
            { err: error, sessionId: session.id, vkUserId: player.vkUserId },
            'Unable to send a Mafia night-action prompt',
          );
        }
      }
    }
  }

  async shouldHandleMessage(
    conversationId: string,
    userId: string,
    text: string,
    options: Pick<MafiaRequestOptions, 'isGroup' | 'isReplyToBot' | 'allowNaturalStart'> = {},
  ): Promise<boolean> {
    if (options.isGroup ?? isGroupPeer(conversationId)) {
      if (options.allowNaturalStart !== false && detectMafiaStartRequest(text)) return true;
      const session = await this.getActiveSession(conversationId);
      if (!session) return /^(?:результаты|итоги|покажи результаты)$/u.test(normalize(text));
      const state = readState(session);
      const normalized = normalize(text);
      if (
        /^(?:я играю|присоединяюсь|присоединиться|добавь меня|вступаю|выйти из игры|выйти|игроки|список игроков|кто играет|статус игры|начинай|начать игру|отмени набор|отмени игру|поставь игру на паузу|продолжай игру|заверши игру|останови игру|результаты|итоги|покажи результаты|сделай игру сложнее|сделай игру легче|легче|сложнее)/u.test(
          normalized,
        )
      ) {
        return true;
      }
      if (state.phase === 'voting' && /^(?:голос(?:ую)?(?: за)?|за|обвиняю)\s+/u.test(normalized)) {
        return true;
      }
      return /^(?:мафия\s+)?(?:сложность|уровень|настрой|ночь|обсуждение|голосование|набор)\b/u.test(
        normalized,
      );
    }

    const privateAction = this.privateActionText(text);
    if (!privateAction) return false;
    const sessions = await this.getSessionsForPlayer(userId);
    return sessions.some((session) => {
      const state = readState(session);
      const player = state.players.find((candidate) => candidate.vkUserId === userId);
      return (
        (!privateAction.conversationId ||
          privateAction.conversationId === session.conversationId) &&
        state.phase === 'night' &&
        player?.alive === true &&
        player.role !== null &&
        parseNightAction(privateAction.text, player.role) !== null
      );
    });
  }

  private privateActionText(text: string): { conversationId: string | null; text: string } | null {
    const match = text.match(/^\s*(?:беседа|чат)\s+(\d{10})\s+(.+)$/iu);
    if (match) return { conversationId: match[1]!, text: match[2]! };
    if (
      !/(?:^\s*\d{1,2}\s*$|(?:убить|устранить|лечить|спасти|защитить|проверить|проверка)\s+\d{1,2}\s*$)/iu.test(
        text,
      )
    ) {
      return null;
    }
    return { conversationId: null, text };
  }

  async handleNaturalMessage(
    conversationId: string,
    userId: string,
    text: string,
    options: MafiaRequestOptions = {},
  ): Promise<string | null> {
    const startRequest = options.allowNaturalStart === false ? null : detectMafiaStartRequest(text);
    if (startRequest && (options.isGroup ?? isGroupPeer(conversationId))) {
      return this.start(conversationId, userId, {
        ...options,
        settings: { ...startRequest.settings, ...options.settings },
      });
    }
    if (options.isGroup ?? isGroupPeer(conversationId)) {
      if (/^(?:результаты|итоги|покажи результаты)$/u.test(normalize(text))) {
        const session =
          (await this.getActiveSession(conversationId)) ??
          (await this.getLatestFinishedSession(conversationId));
        if (!session) return null;
        const state = readState(session);
        return state.phase === 'finished' ? renderFinishedResults(state) : phaseDescription(state);
      }
      return serializeGameConversation(conversationId, async () => {
        const session = await this.getActiveSession(conversationId);
        if (!session) return null;
        if (await this.hasProcessed(session, options.eventId)) return null;
        return this.handleGroupMessage(session, readState(session), userId, text, options);
      });
    }
    return this.handlePrivateMessage(userId, text, options);
  }

  private async handleGroupMessage(
    session: MafiaSession,
    state: MafiaState,
    userId: string,
    text: string,
    options: MafiaRequestOptions,
  ): Promise<string | null> {
    const normalized = normalize(text)
      .replace(/[.!?]+$/u, '')
      .trim();
    if (/^(?:игроки|список игроков|кто играет|статус игры|статус)$/u.test(normalized)) {
      return `${phaseDescription(state)}\n${renderPlayers(state)}`;
    }
    if (/^(?:результаты|итоги|покажи результаты)$/u.test(normalized)) {
      return state.phase === 'finished' ? renderFinishedResults(state) : phaseDescription(state);
    }
    if (state.phase === 'lobby') {
      if (
        /^(?:я играю|присоединяюсь|присоединиться|добавь меня|вступаю|играть)$/u.test(normalized)
      ) {
        return this.joinLobby(session, state, userId, options);
      }
      if (/^(?:выйти из игры|выйти|не играю|убери меня)$/u.test(normalized)) {
        return this.leaveLobby(session, state, userId, options);
      }
      if (/^(?:начинай|начать игру|запускай|старт)$/u.test(normalized)) {
        if (!isGameManager(state, userId, options)) {
          return 'Запустить партию может организатор набора или администратор беседы.';
        }
        return this.beginParty(session, state, userId);
      }
      if (/^(?:отмени набор|отмени игру|отмена)$/u.test(normalized)) {
        if (!isGameManager(state, userId, options)) {
          return 'Отменить набор может его организатор или администратор беседы.';
        }
        state.phase = 'cancelled';
        state.deadlineAt = null;
        state.events = [];
        if (
          !(await this.persist(session, state, {
            eventId: options.eventId,
            userId,
            kind: 'mafia-cancel',
          }))
        ) {
          return null;
        }
        return 'Набор в мафию отменён.';
      }
      if (this.isSettingsRequest(normalized)) {
        return this.changeSettings(session, state, userId, text, options);
      }
      return null;
    }

    if (state.phase === 'paused') {
      if (/^(?:продолжай игру|продолжить|возобнови игру)$/u.test(normalized)) {
        if (!isGameManager(state, userId, options))
          return 'Продолжить партию может организатор или администратор беседы.';
        const phase = state.pausedPhase;
        if (!phase || phase === 'paused' || phase === 'lobby')
          return 'Не удалось восстановить фазу партии.';
        state.phase = phase;
        state.pausedPhase = null;
        state.deadlineAt = Date.now() + Math.max(1000, state.remainingMs ?? 1000);
        state.remainingMs = null;
        if (
          !(await this.persist(session, state, {
            eventId: options.eventId,
            userId,
            kind: 'mafia-resume',
          }))
        ) {
          return null;
        }
        if (phase === 'night') await this.sendNightPrompts(session, state);
        return `Партия продолжается. ${phaseDescription(state)}`;
      }
      return null;
    }

    if (state.phase === 'finished' || state.phase === 'cancelled' || state.phase === 'dealing') {
      return null;
    }
    if (/^(?:поставь игру на паузу|пауза)$/u.test(normalized)) {
      if (!isGameManager(state, userId, options))
        return 'Приостановить партию может организатор или администратор беседы.';
      state.pausedPhase = state.phase;
      state.phase = 'paused';
      state.remainingMs = Math.max(1000, (state.deadlineAt ?? Date.now()) - Date.now());
      state.deadlineAt = null;
      if (
        !(await this.persist(session, state, {
          eventId: options.eventId,
          userId,
          kind: 'mafia-pause',
        }))
      ) {
        return null;
      }
      return '⏸ Партия приостановлена. Продолжить можно сообщением «продолжай игру».';
    }
    if (/^(?:заверши игру|останови игру|закончить партию)$/u.test(normalized)) {
      if (!isGameManager(state, userId, options))
        return 'Завершить партию может организатор или администратор беседы.';
      return this.finishGame(session, state, null, 'Партия завершена досрочно.', options);
    }
    if (this.isSettingsRequest(normalized)) {
      return this.changeSettings(session, state, userId, text, options);
    }
    if (state.phase === 'voting') {
      const vote = normalized.match(/^(?:голос(?:ую)?(?: за)?|за|обвиняю)\s+(.+)$/u);
      if (vote) return this.castVote(session, state, userId, vote[1]!, options);
    }
    if (
      /^(?:игроки|список игроков|кто играет|статус игры|статус|сколько осталось игроков)$/u.test(
        normalized,
      )
    ) {
      return `${phaseDescription(state)}\n${renderPlayers(state)}`;
    }
    return null;
  }

  private resolveTarget(state: MafiaState, rawTarget: string): MafiaPlayerState | null {
    const target = parseTargetText(rawTarget);
    if (!target) return null;
    if (/^\d{1,2}$/u.test(target)) {
      return state.players[Number(target) - 1] ?? null;
    }
    const byId = state.players.find((player) => player.vkUserId === target);
    if (byId) return byId;
    const matches = state.players.filter((player) => normalize(player.name) === normalize(target));
    return matches.length === 1 ? matches[0]! : null;
  }

  private async castVote(
    session: MafiaSession,
    state: MafiaState,
    userId: string,
    rawTarget: string,
    options: MafiaRequestOptions,
  ): Promise<string> {
    const voter = state.players.find((player) => player.vkUserId === userId);
    if (state.phase !== 'voting') return 'Сейчас голосование не открыто.';
    if (!voter) return 'Ты не участвуешь в этой партии.';
    if (!voter.alive) {
      return state.settings.allowDeadTalk
        ? 'Наблюдай за игрой, но выбывшие не голосуют.'
        : 'Выбывшие игроки не могут голосовать.';
    }
    const target = this.resolveTarget(state, rawTarget);
    if (!target || !target.alive) return 'Укажи номер или точное имя живого игрока из списка.';
    if (target.vkUserId === userId) return 'За себя голосовать нельзя.';
    if (state.revoteRound > 0 && !state.revoteCandidates.includes(target.vkUserId)) {
      return 'При переголосовании можно выбрать только одного из кандидатов с равным числом голосов.';
    }
    state.votes[userId] = target.vkUserId;
    if (
      !(await this.persist(session, state, {
        eventId: options.eventId,
        userId,
        kind: 'mafia-vote',
      }))
    ) {
      return 'Это сообщение уже было обработано.';
    }
    const living = state.players.filter((player) => player.alive);
    const response = `Голос записан за игрока №${playerIndex(state, target.vkUserId) + 1}. Можно изменить его до окончания голосования.`;
    if (living.every((player) => state.votes[player.vkUserId])) {
      const current = await this.getActiveSession(session.conversationId);
      if (current?.id === session.id) {
        return this.completeVoting(current, state);
      }
    }
    return response;
  }

  private async handlePrivateMessage(
    userId: string,
    text: string,
    options: MafiaRequestOptions,
  ): Promise<string | null> {
    const privateAction = this.privateActionText(text);
    if (!privateAction) return null;
    const matching = await this.getSessionsForPlayer(userId);
    const eligible = matching.filter((session) => {
      const state = readState(session);
      const player = state.players.find((candidate) => candidate.vkUserId === userId);
      return (
        (!privateAction.conversationId ||
          privateAction.conversationId === session.conversationId) &&
        state.phase === 'night' &&
        player?.alive === true &&
        player.role !== null &&
        parseNightAction(privateAction.text, player.role) !== null
      );
    });
    if (eligible.length === 0) return null;
    if (eligible.length > 1) {
      const conversations = eligible.map((session) => session.conversationId).join(', ');
      return `У тебя есть активные ночные ходы в нескольких беседах (${conversations}). Напиши действие в личке с номером беседы: «беседа <ID> убить 3».`;
    }
    const selected = eligible[0]!;
    return serializeGameConversation(selected.conversationId, async () => {
      const session = await this.getActiveSession(selected.conversationId);
      if (!session || session.id !== selected.id) return null;
      if (await this.hasProcessed(session, options.eventId)) return null;
      const state = readState(session);
      return this.submitNightAction(session, state, userId, privateAction.text, options);
    });
  }

  private async submitNightAction(
    session: MafiaSession,
    state: MafiaState,
    userId: string,
    text: string,
    options: MafiaRequestOptions,
  ): Promise<string> {
    if (state.phase !== 'night') return 'Сейчас не ночь; действие не принято.';
    const actor = state.players.find((player) => player.vkUserId === userId);
    if (!actor || !actor.alive || !actor.role)
      return 'Ты не можешь выполнять ночные действия в этой партии.';
    const parsed = parseNightAction(text, actor.role);
    if (!parsed)
      return 'Не понял действие. Открой последнее личное сообщение Пенька и отправь номер игрока в указанном формате.';
    const target = this.resolveTarget(state, parsed.targetId);
    if (!target || !target.alive)
      return 'Такого живого игрока нет. Отправь номер из списка партии.';
    if (
      parsed.kind === 'kill' &&
      actor.role !== 'maniac' &&
      mafiaFaction(target.role!) === 'mafia'
    ) {
      return 'Мафия не может выбрать своей целью союзника.';
    }
    if (parsed.kind === 'kill' && actor.role === 'maniac' && target.vkUserId === actor.vkUserId) {
      return 'Маньяк не может выбрать себя.';
    }
    if (
      (parsed.kind === 'inspect' || parsed.kind === 'don-inspect') &&
      target.vkUserId === actor.vkUserId
    ) {
      return 'Нельзя проверить себя.';
    }
    if (parsed.kind === 'save' && target.vkUserId === actor.vkUserId && actor.selfHealUsed) {
      return 'Ты уже лечил себя в этой партии. Выбери другого живого игрока.';
    }
    const action: MafiaNightAction = { kind: parsed.kind, targetId: target.vkUserId };
    const actions = state.nightActions[userId] ?? [];
    const existingIndex = actions.findIndex((previous) => previous.kind === action.kind);
    if (existingIndex >= 0) actions[existingIndex] = action;
    else actions.push(action);
    state.nightActions[userId] = actions;
    const completed = this.nightActionsComplete(state);
    if (!completed) {
      if (
        !(await this.persist(session, state, {
          eventId: options.eventId,
          userId,
          kind: 'mafia-night-action',
        }))
      ) {
        return 'Это сообщение уже было обработано.';
      }
      return `Принято: действие записано для игрока №${playerIndex(state, target.vkUserId) + 1}. До конца ночи выбор можно изменить.`;
    }
    const result = await this.resolveNight(session, state, {
      eventId: options.eventId,
      userId,
      kind: 'mafia-night-action',
    });
    await this.publish(session.conversationId, result);
    return 'Все обязательные ночные действия приняты. Итог ночи опубликован в беседе.';
  }

  private nightActionsComplete(state: MafiaState): boolean {
    for (const player of state.players) {
      if (!player.alive || !player.role) continue;
      const actions = state.nightActions[player.vkUserId] ?? [];
      const has = (kind: MafiaActionKind) => actions.some((action) => action.kind === kind);
      if ((player.role === 'mafia' || player.role === 'don') && !has('kill')) {
        return false;
      }
      if (player.role === 'doctor' && !has('save')) return false;
      if (player.role === 'commissioner' && !has('inspect')) return false;
      if (player.role === 'maniac' && !has('kill')) return false;
    }
    return true;
  }

  private async resolveNight(
    session: MafiaSession,
    state: MafiaState,
    event: { eventId?: string; userId?: string; kind?: string } = {},
  ): Promise<string> {
    const resolution = resolveNightActions(state.players, state.nightActions);
    for (const [actorId, actions] of Object.entries(state.nightActions)) {
      const actor = state.players.find((player) => player.vkUserId === actorId);
      if (
        actor?.role === 'doctor' &&
        actions.some((action) => action.kind === 'save' && action.targetId === actorId)
      ) {
        actor.selfHealUsed = true;
      }
    }
    const eliminated = resolution.eliminatedIds
      .map((id) => state.players.find((player) => player.vkUserId === id))
      .filter((player): player is MafiaPlayerState => player !== undefined);
    for (const player of eliminated) player.alive = false;
    state.deadlineAt = null;
    state.nightActions = {};
    for (const player of eliminated) {
      phaseEvent(`${player.name} выбыл ночью`, state);
    }
    const winner = determineMafiaWinner(state.players);
    let publicResult =
      eliminated.length === 0
        ? `🌅 Наступило утро ${state.nightNumber}. Этой ночью никто не выбыл.`
        : `🌅 Наступило утро ${state.nightNumber}. Выбыли: ${eliminated
            .map(
              (player) =>
                `${player.name}${state.settings.revealRole && player.role ? ` (${mafiaRoleLabel(player.role)})` : ''}`,
            )
            .join(', ')}.`;
    if (winner) {
      const result = await this.finishGame(session, state, winner, publicResult, event);
      await this.deliverInvestigations(session, state, resolution.investigations);
      return result;
    }
    state.phase = 'discussion';
    state.deadlineAt = Date.now() + state.settings.discussionSeconds * 1000;
    phaseEvent('началось дневное обсуждение', state);
    if (!(await this.persist(session, state, event))) return 'Ход уже обработан.';
    await this.deliverInvestigations(session, state, resolution.investigations);
    publicResult += `\n💬 Обсуждение продлится ${displayDuration(state.settings.discussionSeconds)}.`;
    return publicResult;
  }

  private async deliverInvestigations(
    session: MafiaSession,
    state: MafiaState,
    investigations: Array<{ actorId: string; targetId: string; result: string }>,
  ): Promise<void> {
    for (const investigation of investigations) {
      try {
        await this.messenger.send(
          Number(investigation.actorId),
          `Результат проверки: игрок №${playerIndex(state, investigation.targetId) + 1} — ${investigation.result}.`,
        );
      } catch (error) {
        logger.warn(
          { err: error, sessionId: session.id, vkUserId: investigation.actorId },
          'Failed to deliver a private Mafia investigation result',
        );
      }
    }
  }

  private async publish(conversationId: string, text: string): Promise<void> {
    try {
      await this.messenger.send(Number(conversationId), text);
    } catch (error) {
      logger.error({ err: error, conversationId }, 'Failed to publish a Mafia phase transition');
    }
  }

  private async startVoting(session: MafiaSession, state: MafiaState): Promise<string> {
    state.phase = 'voting';
    state.votes = {};
    state.revoteCandidates = [];
    state.revoteRound = 0;
    state.deadlineAt = Date.now() + state.settings.votingSeconds * 1000;
    phaseEvent('началось голосование', state);
    if (!(await this.persist(session, state, { kind: 'mafia-voting-start' }))) {
      return 'Не удалось сохранить начало голосования.';
    }
    const candidates = state.players
      .map((player, index) => (player.alive ? `${index + 1}. ${player.name}` : null))
      .filter((value): value is string => value !== null);
    return `🗳 Голосование открыто на ${displayDuration(state.settings.votingSeconds)}. Напишите «голос за N», где N — номер игрока.\n${candidates.join('\n')}`;
  }

  private async completeVoting(
    session: MafiaSession,
    state: MafiaState,
    event: { eventId?: string; userId?: string; kind?: string } = {},
  ): Promise<string> {
    const livingIds = new Set(
      state.players.filter((player) => player.alive).map((player) => player.vkUserId),
    );
    const candidates = state.revoteRound > 0 ? new Set(state.revoteCandidates) : livingIds;
    const result = tallyMafiaVotes(state.votes, livingIds, candidates);
    const summary = Object.entries(result.counts)
      .map(
        ([targetId, votes]) =>
          `${state.players[playerIndex(state, targetId)]?.name ?? 'Игрок'} — ${votes}`,
      )
      .join('; ');
    if (result.leaders.length > 1 && state.settings.allowRevote && state.revoteRound === 0) {
      state.phase = 'voting';
      state.revoteRound = 1;
      state.revoteCandidates = result.leaders;
      state.votes = {};
      state.deadlineAt = Date.now() + state.settings.votingSeconds * 1000;
      phaseEvent('равенство голосов — переголосование', state);
      if (!(await this.persist(session, state, event))) return 'Голосование уже обработано.';
      return `⚖️ Ничья (${summary}). Проведём переголосование между:\n${result.leaders
        .map(
          (id) => `${playerIndex(state, id) + 1}. ${state.players[playerIndex(state, id)]!.name}`,
        )
        .join('\n')}`;
    }
    if (result.eliminatedId) {
      const eliminated = state.players.find((player) => player.vkUserId === result.eliminatedId)!;
      eliminated.alive = false;
      phaseEvent(`${eliminated.name} исключён голосованием (${summary || 'без голосов'})`, state);
      const label =
        state.settings.revealRole && eliminated.role ? ` (${mafiaRoleLabel(eliminated.role)})` : '';
      const announcement = `📣 Голосование завершено${summary ? `: ${summary}` : ''}. ${eliminated.name}${label} покидает игру.`;
      const winner = determineMafiaWinner(state.players);
      if (winner) return this.finishGame(session, state, winner, announcement, event);
      return this.startNightAfterVote(session, state, announcement, event);
    }
    const announcement =
      result.leaders.length > 1
        ? 'После переголосования снова ничья. Сегодня никто не исключён.'
        : 'Никто не получил голосов; сегодня никто не исключён.';
    phaseEvent(announcement, state);
    return this.startNightAfterVote(session, state, announcement, event);
  }

  private async startNightAfterVote(
    session: MafiaSession,
    state: MafiaState,
    announcement: string,
    event: { eventId?: string; userId?: string; kind?: string } = {},
  ): Promise<string> {
    state.phase = 'night';
    state.nightNumber += 1;
    state.votes = {};
    state.revoteCandidates = [];
    state.revoteRound = 0;
    state.deadlineAt = Date.now() + state.settings.nightSeconds * 1000;
    state.nightActions = {};
    phaseEvent('наступила ночь', state);
    if (!(await this.persist(session, state, event))) return 'Этап уже был обработан.';
    await this.sendNightPrompts(session, state);
    return `${announcement}\n🌙 Наступила ночь ${state.nightNumber} (${displayDuration(state.settings.nightSeconds)}). Ночные действия — только в личных сообщениях.`;
  }

  private async finishGame(
    session: MafiaSession,
    state: MafiaState,
    winner: MafiaWinner | null,
    summary: string,
    event: { eventId?: string; userId?: string; kind?: string } = {},
  ): Promise<string> {
    state.phase = 'finished';
    state.winner = winner;
    state.deadlineAt = null;
    state.remainingMs = null;
    state.pausedPhase = null;
    state.events.push(summary);
    if (!(await this.persist(session, state, event))) return 'Партия уже завершена.';
    const winnerLabel = winner
      ? { town: 'мирные жители', mafia: 'мафия', maniac: 'маньяк' }[winner]
      : 'победителя нет';
    const roles = state.players
      .map(
        (player, index) =>
          `${index + 1}. ${player.name} — ${player.role ? mafiaRoleLabel(player.role) : 'роль не выдана'}`,
      )
      .join('\n');
    const history = state.events.slice(-20).join('\n');
    return `🏁 Партия завершена. Победили: ${winnerLabel}.\n${summary}\n\nРоли:\n${roles}\n\nХод партии:\n${history || 'Событий нет.'}`;
  }

  async handleCommand(
    conversationId: string,
    userId: string,
    commandText: string,
    options: MafiaRequestOptions = {},
  ): Promise<string | null> {
    const tokens = commandText.trim().split(/\s+/u).filter(Boolean);
    const first = normalize(tokens[0] ?? '');
    const second = normalize(tokens[1] ?? '');
    const mafiaAlias = ['mafia', 'мафия', 'мафию'].includes(first);
    const explicitStart =
      (first === 'start' || first === 'начать') && ['mafia', 'мафия', 'мафию'].includes(second);
    if (mafiaAlias || explicitStart) {
      const subcommand = mafiaAlias ? second : 'начать';
      const subcommandText = tokens.slice(mafiaAlias ? 2 : 2).join(' ');
      const settingsText =
        subcommand === 'start' || subcommand === 'начать'
          ? subcommandText
          : tokens.slice(1).join(' ');
      const request = detectMafiaStartRequest(`давай в мафию ${settingsText}`);
      const session = await this.getActiveSession(conversationId);
      if (
        !session &&
        (subcommand === 'start' || subcommand === 'начать' || (mafiaAlias && !second))
      ) {
        return this.start(conversationId, userId, {
          ...options,
          isGroup: options.isGroup ?? isGroupPeer(conversationId),
          settings: { ...request?.settings, ...options.settings },
        });
      }
      if (!session) {
        if (subcommand === 'results' || subcommand === 'результаты' || subcommand === 'итоги') {
          return this.handleNaturalMessage(conversationId, userId, 'результаты', options);
        }
        return null;
      }
      const naturalText =
        subcommand === 'start' || subcommand === 'начать'
          ? 'начинай'
          : subcommand === 'join' || subcommand === 'войти' || subcommand === 'присоединиться'
            ? 'я играю'
            : subcommand === 'leave' || subcommand === 'выйти'
              ? 'выйти из игры'
              : subcommand === 'players' || subcommand === 'игроки' || subcommand === 'список'
                ? 'игроки'
                : subcommand === 'status' || subcommand === 'статус'
                  ? 'статус игры'
                  : subcommand === 'results' ||
                      subcommand === 'результаты' ||
                      subcommand === 'итоги'
                    ? 'результаты'
                    : subcommand === 'cancel' || subcommand === 'отменить'
                      ? 'отмени набор'
                      : subcommand === 'pause' || subcommand === 'пауза'
                        ? 'поставь игру на паузу'
                        : subcommand === 'resume' || subcommand === 'продолжить'
                          ? 'продолжай игру'
                          : subcommand === 'stop' || subcommand === 'завершить'
                            ? 'заверши игру'
                            : subcommand === 'difficulty' || subcommand === 'сложность'
                              ? `сложность ${subcommandText}`
                              : subcommand === 'settings' || subcommand === 'настройки'
                                ? subcommandText
                                : null;
      if (naturalText !== null) {
        return this.handleNaturalMessage(conversationId, userId, naturalText, options);
      }
      if (!settingsText) {
        const state = readState(session);
        return `${phaseDescription(state)}\n${renderPlayers(state)}`;
      }
      return this.handleNaturalMessage(conversationId, userId, settingsText, options);
    }

    const session = await this.getActiveSession(conversationId);
    if (!session) return null;
    const naturalText =
      first === 'join' || first === 'присоединиться' || first === 'войти'
        ? 'я играю'
        : first === 'leave' || first === 'выйти'
          ? 'выйти из игры'
          : first === 'players' || first === 'список' || first === 'игроки'
            ? 'игроки'
            : first === 'start' || first === 'запустить'
              ? 'начинай'
              : first === 'cancel' || first === 'отменить'
                ? 'отмени набор'
                : first === 'pause' || first === 'пауза'
                  ? 'поставь игру на паузу'
                  : first === 'resume' || first === 'продолжить'
                    ? 'продолжай игру'
                    : first === 'stop' || first === 'завершить'
                      ? 'заверши игру'
                      : first === 'difficulty' || first === 'сложность'
                        ? `измени сложность ${tokens.slice(1).join(' ')}`
                        : first === 'status' || first === 'статус'
                          ? 'статус игры'
                          : first === 'settings' || first === 'настройки'
                            ? tokens.slice(1).join(' ')
                            : null;
    if (naturalText === null) return null;
    return this.handleNaturalMessage(conversationId, userId, naturalText, options);
  }

  async handleParticipantLeave(
    conversationId: string,
    userId: string,
    eventId?: string,
  ): Promise<string | null> {
    return serializeGameConversation(conversationId, async () => {
      const session = await this.getActiveSession(conversationId);
      if (!session) return null;
      const state = readState(session);
      const player = state.players.find((participant) => participant.vkUserId === userId);
      if (!player) return null;
      if (state.phase === 'lobby') {
        state.players = state.players.filter((participant) => participant.vkUserId !== userId);
        if (state.creatorId === userId) state.creatorId = state.players[0]?.vkUserId ?? '';
        if (state.players.length === 0) {
          state.phase = 'cancelled';
          state.deadlineAt = null;
        }
        if (!(await this.persist(session, state, { eventId, userId, kind: 'mafia-member-left' }))) {
          return null;
        }
        return `${player.name} вышел из набора в мафию.`;
      }
      if (!player.alive) return null;
      player.alive = false;
      delete state.votes[userId];
      delete state.nightActions[userId];
      phaseEvent(`${player.name} покинул беседу и выбыл`, state);
      const winner = determineMafiaWinner(state.players);
      if (winner) {
        return this.finishGame(
          session,
          state,
          winner,
          `${player.name} покинул беседу. Партия завершена.`,
          { eventId, userId, kind: 'mafia-member-left' },
        );
      }
      if (state.phase === 'night' && this.nightActionsComplete(state)) {
        const result = await this.resolveNight(session, state, {
          eventId,
          userId,
          kind: 'mafia-member-left',
        });
        await this.publish(conversationId, result);
        return null;
      }
      if (
        state.phase === 'voting' &&
        state.players
          .filter((participant) => participant.alive)
          .every((participant) => state.votes[participant.vkUserId])
      ) {
        return this.completeVoting(session, state, { eventId, userId, kind: 'mafia-member-left' });
      }
      if (!(await this.persist(session, state, { eventId, userId, kind: 'mafia-member-left' }))) {
        return null;
      }
      return `${player.name} покинул беседу и выбыл из партии.`;
    });
  }

  async handleTimeouts(now = Date.now()): Promise<Array<{ conversationId: string; text: string }>> {
    const sessions = await prisma.gameSession.findMany({
      where: { game: 'mafia', state: { in: activeDatabaseStates } },
      select: { id: true, conversationId: true, game: true, state: true, data: true },
    });
    const expired: Array<{ conversationId: string; text: string }> = [];
    for (const found of sessions) {
      await serializeGameConversation(found.conversationId, async () => {
        const session = await this.getActiveSession(found.conversationId);
        if (!session || session.id !== found.id) return;
        const state = readState(session);
        if (state.phase === 'dealing') {
          const text = await this.deliverRoles(session, state);
          const latest = await prisma.gameSession.findUnique({
            where: { id: session.id },
            select: { id: true, conversationId: true, game: true, state: true, data: true },
          });
          const finalPhase = latest ? readState(latest).phase : null;
          if (finalPhase === 'night' || finalPhase === 'cancelled') {
            expired.push({ conversationId: session.conversationId, text });
          }
          return;
        }
        if (state.phase === 'paused' || !state.deadlineAt || state.deadlineAt > now) return;
        if (state.phase === 'lobby') {
          if (state.players.length < state.settings.minPlayers) {
            state.phase = 'cancelled';
            state.deadlineAt = null;
            const text = `Набор завершён: записалось ${state.players.length}, а нужно минимум ${state.settings.minPlayers}. Партию не запускал.`;
            if (await this.persist(session, state, { kind: 'mafia-lobby-timeout' })) {
              expired.push({ conversationId: session.conversationId, text });
            }
            return;
          }
          const text = await this.beginParty(session, state);
          if (state.phase === 'lobby') {
            state.deadlineAt = Date.now() + 60_000;
            await this.persist(session, state, { kind: 'mafia-retry-lobby' });
          }
          expired.push({ conversationId: session.conversationId, text });
          return;
        }
        if (state.phase === 'night') {
          const text = await this.resolveNight(session, state, {
            eventId: `timeout-night-${state.nightNumber}`,
            userId: state.creatorId,
            kind: 'mafia-night-timeout',
          });
          expired.push({ conversationId: session.conversationId, text });
          return;
        }
        if (state.phase === 'discussion') {
          expired.push({
            conversationId: session.conversationId,
            text: await this.startVoting(session, state),
          });
          return;
        }
        if (state.phase === 'voting') {
          expired.push({
            conversationId: session.conversationId,
            text: await this.completeVoting(session, state, {
              eventId: `timeout-vote-${state.nightNumber}-${state.revoteRound}`,
              userId: state.creatorId,
              kind: 'mafia-vote-timeout',
            }),
          });
        }
      });
    }
    return expired;
  }

  private async joinLobby(
    session: MafiaSession,
    state: MafiaState,
    userId: string,
    options: MafiaRequestOptions,
  ): Promise<string> {
    if (state.phase !== 'lobby')
      return 'Набор уже завершён; присоединиться к начавшейся партии нельзя.';
    const existing = state.players.find((player) => player.vkUserId === userId);
    if (existing) return `${existing.name}, ты уже записан.`;
    if (state.players.length >= state.settings.maxPlayers) return 'Набор уже заполнен.';
    state.players.push({
      vkUserId: userId,
      name: options.name?.trim() || 'Участник',
      role: null,
      alive: true,
      selfHealUsed: false,
    });
    if (
      !(await this.persist(session, state, {
        eventId: options.eventId,
        userId,
        kind: 'mafia-join',
      }))
    ) {
      return 'Это сообщение уже было обработано.';
    }
    return `Записал ${state.players[state.players.length - 1]!.name}. Игроков: ${state.players.length}/${state.settings.maxPlayers}.`;
  }

  private async leaveLobby(
    session: MafiaSession,
    state: MafiaState,
    userId: string,
    options: MafiaRequestOptions,
  ): Promise<string> {
    if (state.phase !== 'lobby')
      return 'После раздачи ролей выйти из партии таким способом нельзя.';
    const index = playerIndex(state, userId);
    if (index < 0) return 'Ты не записан в эту партию.';
    const [departed] = state.players.splice(index, 1);
    if (state.creatorId === userId) state.creatorId = state.players[0]?.vkUserId ?? '';
    if (state.players.length === 0) {
      state.phase = 'cancelled';
      state.deadlineAt = null;
    }
    if (
      !(await this.persist(session, state, {
        eventId: options.eventId,
        userId,
        kind: 'mafia-leave',
      }))
    ) {
      return 'Это сообщение уже было обработано.';
    }
    return `${departed!.name} вышел из набора. Игроков: ${state.players.length}/${state.settings.maxPlayers}.`;
  }

  private isSettingsRequest(text: string): boolean {
    return /(?:сложность|уровень|ночь|обсуждение|голосование|набор|минимум|максимум|игроков|мафи|доно|доктор|комиссар|маньяк|переголос|раскрывать роль|говорить после выбыв)/u.test(
      text,
    );
  }

  private parseSettings(text: string, state: MafiaState): Partial<MafiaSettings> {
    const normalized = normalize(text);
    const next: Partial<MafiaSettings> = {};
    const numericDifficulty = normalized.match(/(?:сложность|уровень)\s*(?:на\s*)?([1-4])/u)?.[1];
    const difficulty = numericDifficulty
      ? (Number(numericDifficulty) as MafiaDifficulty)
      : /(?:сделай|давай|игру)?\s*(?:сложнее|усложни)/u.test(normalized)
        ? (Math.min(4, state.settings.difficulty + 1) as MafiaDifficulty)
        : /(?:легче|проще|упрости)/u.test(normalized)
          ? (Math.max(1, state.settings.difficulty - 1) as MafiaDifficulty)
          : difficultyInText(normalized);
    if (difficulty) next.difficulty = difficulty;
    const targetPlayers = normalized.match(/(?:на|цель)\s+(\d{1,2})\s*(?:игрок\w*|человек)?/u)?.[1];
    if (targetPlayers) next.targetPlayers = Number(targetPlayers);
    const maxPlayers = normalized.match(
      /(?:максимум|макс|до)\s+(\d{1,2})\s*(?:игрок\w*|человек)?/u,
    )?.[1];
    if (maxPlayers) next.maxPlayers = Number(maxPlayers);
    const minPlayers = normalized.match(
      /(?:минимум|мин)\s+(\d{1,2})\s*(?:игрок\w*|человек)?/u,
    )?.[1];
    if (minPlayers) next.minPlayers = Number(minPlayers);
    const seconds = normalized.match(/(\d{1,3})\s*(?:секунд\w*|сек\b)/u)?.[1];
    if (seconds) {
      if (/\bнабор\b/u.test(normalized)) next.recruitmentSeconds = Number(seconds);
      else if (/\bночь\b/u.test(normalized)) next.nightSeconds = Number(seconds);
      else if (/обсуждени/u.test(normalized)) next.discussionSeconds = Number(seconds);
      else if (/голосован/u.test(normalized)) next.votingSeconds = Number(seconds);
    }
    const mafiaCount = normalized.match(/(\d{1,2})\s+мафи/u)?.[1];
    if (mafiaCount) next.mafiaCount = Number(mafiaCount);
    const toggle = (pattern: RegExp): boolean | null => {
      if (!pattern.test(normalized)) return null;
      if (
        /(?:без|выключи|отключи|убери|нет)\s+(?:дона|доно|доктора|комиссара|маньяка)/u.test(
          normalized,
        )
      ) {
        return false;
      }
      if (
        /(?:добавь|включи|добавить|с|есть)\s+(?:дона|доно|доктора|комиссара|маньяка)/u.test(
          normalized,
        )
      ) {
        return true;
      }
      return null;
    };
    const don = toggle(/дон/u);
    const doctor = toggle(/доктор/u);
    const commissioner = toggle(/комиссар/u);
    const maniac = toggle(/маньяк/u);
    if (don !== null) next.hasDon = don;
    if (doctor !== null) next.hasDoctor = doctor;
    if (commissioner !== null) next.hasCommissioner = commissioner;
    if (maniac !== null) next.hasManiac = maniac;
    if (/(?:без переголосования|переголосование выключить|переголосование нет)/u.test(normalized)) {
      next.allowRevote = false;
    }
    if (/(?:переголосование включить|переголосование да)/u.test(normalized)) {
      next.allowRevote = true;
    }
    if (/(?:без раскрытия роли|роль не раскрывать)/u.test(normalized)) next.revealRole = false;
    if (/(?:раскрывать роль|роль раскрывать)/u.test(normalized)) next.revealRole = true;
    if (/(?:разреши говорить после выбывания|выбывшим можно говорить)/u.test(normalized)) {
      next.allowDeadTalk = true;
    }
    if (/(?:запрети говорить после выбывания|выбывшим нельзя говорить)/u.test(normalized)) {
      next.allowDeadTalk = false;
    }
    if (Object.keys(next).length === 0 && /сложнее/u.test(normalized)) {
      next.difficulty = Math.min(4, state.settings.difficulty + 1) as MafiaDifficulty;
    } else if (Object.keys(next).length === 0 && /(?:легче|проще)/u.test(normalized)) {
      next.difficulty = Math.max(1, state.settings.difficulty - 1) as MafiaDifficulty;
    }
    return next;
  }

  private async changeSettings(
    session: MafiaSession,
    state: MafiaState,
    userId: string,
    text: string,
    options: MafiaRequestOptions,
  ): Promise<string> {
    if (!isGameManager(state, userId, options)) {
      return 'Настройки партии меняет её организатор или администратор беседы.';
    }
    const changes = this.parseSettings(text, state);
    if (Object.keys(changes).length === 0) return 'Не понял, какие настройки изменить.';
    if (state.phase === 'lobby') {
      const settings = mafiaSettings(changes.difficulty ?? state.settings.difficulty, {
        ...state.settings,
        ...changes,
      });
      if (
        settings.targetPlayers !== null &&
        (settings.targetPlayers < settings.minPlayers ||
          settings.targetPlayers > settings.maxPlayers)
      ) {
        return 'Целевое число игроков должно быть в заданном диапазоне набора.';
      }
      try {
        if (state.players.length > settings.maxPlayers) {
          return `Уже записано ${state.players.length} человек; сначала убери лишних игроков или увеличь максимум.`;
        }
        roleComposition(Math.max(settings.minPlayers, state.players.length), settings);
      } catch (error) {
        return error instanceof Error ? error.message : 'Такой состав ролей не сбалансирован.';
      }
      state.settings = settings;
      state.deadlineAt = Date.now() + settings.recruitmentSeconds * 1000;
    } else {
      const unsafe = ['mafiaCount', 'hasDon', 'hasDoctor', 'hasCommissioner', 'hasManiac'].some(
        (key) => key in changes,
      );
      if (unsafe) {
        state.futureSettings = { ...state.futureSettings, ...changes };
        if (
          !(await this.persist(session, state, {
            eventId: options.eventId,
            userId,
            kind: 'mafia-next-settings',
          }))
        ) {
          return 'Это сообщение уже было обработано.';
        }
        return 'Состав ролей текущей партии уже зафиксирован. Изменения сохранены и применятся в следующей партии.';
      }
      state.futureSettings = { ...state.futureSettings, ...changes };
      if ('nightSeconds' in changes) state.settings.nightSeconds = changes.nightSeconds!;
      if ('discussionSeconds' in changes)
        state.settings.discussionSeconds = changes.discussionSeconds!;
      if ('votingSeconds' in changes) state.settings.votingSeconds = changes.votingSeconds!;
      if ('difficulty' in changes) state.settings.difficulty = changes.difficulty!;
      if ('allowRevote' in changes) state.settings.allowRevote = changes.allowRevote!;
      if ('revealRole' in changes) state.settings.revealRole = changes.revealRole!;
      if ('allowDeadTalk' in changes) state.settings.allowDeadTalk = changes.allowDeadTalk!;
    }
    if (
      !(await this.persist(session, state, {
        eventId: options.eventId,
        userId,
        kind: 'mafia-settings',
      }))
    ) {
      return 'Это сообщение уже было обработано.';
    }
    return state.phase === 'lobby'
      ? `Настройки набора обновлены: минимум ${state.settings.minPlayers}, максимум ${state.settings.maxPlayers}; сложность ${state.settings.difficulty}/4; набор ${displayDuration(state.settings.recruitmentSeconds)}.`
      : 'Безопасные настройки обновлены и применятся в следующих фазах или партиях. Уже выданные роли и текущий ход не изменились.';
  }
}

export const mafiaService = new MafiaService();
export default mafiaService;
