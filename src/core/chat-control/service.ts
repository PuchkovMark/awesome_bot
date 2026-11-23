import type { ConnectionScope } from '../../contracts/index';
import type { AuthorizationTransaction } from '../../storage/authorization-types';
import type { ChatControlState } from '../../storage/chat-control-store';
import type { ChatControlCommand } from './commands';

const pauseDuration = 15 * 60_000;
const modeLabel = { silent: 'молчаливый', normal: 'нормальный', active: 'активный' } as const;
export type ChatControlResult = {
  readonly status:
    'applied' | 'duplicate' | 'inactive' | 'waiting' | 'permanent' | 'expired' | 'invalid_duration';
  readonly state: ChatControlState;
};

export function applyChatControl(
  tx: AuthorizationTransaction,
  command: ChatControlCommand,
  now: number,
  sequence?: number,
): ChatControlResult {
  const state = tx.controlState();
  switch (command.kind) {
    case 'settings':
      return { status: 'applied', state };
    case 'greeting':
      tx.writeGreeting(command.enabled, now, sequence);
      break;
    case 'quietHours':
      tx.writeQuietHours(command.hours);
      break;
    case 'mode':
      tx.updateControlSettings({ responseMode: command.mode }, now);
      break;
    case 'off':
    case 'on':
      tx.updateControlSettings({ enabled: command.kind === 'on' }, now);
      break;
    case 'disableAutonomous':
      tx.writePause({ ...state, autonomousDisabled: true });
      break;
    case 'pause':
    case 'extend': {
      if (state.autonomousDisabled) return { status: 'permanent', state };
      const extending = command.kind === 'extend';
      if (!extending && (!state.enabled || state.mode !== 'active'))
        return { status: 'inactive', state };
      if (extending && (state.pausedUntil === null || state.pausedUntil <= now))
        return { status: 'expired', state };
      if (!extending && state.nextParticipantPause !== null && now < state.nextParticipantPause)
        return { status: 'waiting', state };
      const until = extending ? state.pausedUntil! + command.minutes * 60_000 : now + pauseDuration;
      const next = until + pauseDuration;
      if (
        !Number.isSafeInteger(next) ||
        next > 8_640_000_000_000_000 ||
        (extending && (!Number.isSafeInteger(command.minutes) || command.minutes <= 0))
      )
        return { status: 'invalid_duration', state };
      tx.writePause({ pausedUntil: until, nextParticipantPause: next, autonomousDisabled: false });
      break;
    }
  }
  return { status: 'applied', state: tx.controlState() };
}

export function formatChatControl(
  scope: ConnectionScope,
  command: ChatControlCommand,
  result: ChatControlResult,
  now: number,
): string | undefined {
  const { state } = result;
  if (result.status === 'duplicate' || result.status === 'waiting') return undefined;
  if (command.kind === 'greeting')
    return state.greetingEnabledAt === null ? 'Приветствия выключены.' : 'Приветствия включены.';
  if (result.status === 'permanent') return 'Самостоятельные реплики отключены.';
  if (result.status === 'expired') return 'Действующей паузы для продления нет.';
  if (result.status === 'inactive') return 'Команда «помолчи» доступна в активном режиме.';
  if (result.status === 'invalid_duration') return 'Укажи допустимую длительность паузы.';
  const time = (at: number) =>
    new Intl.DateTimeFormat('ru', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: state.timezone,
    }).format(at);
  if (command.kind === 'pause' && state.pausedUntil !== null) {
    return `Самостоятельные реплики на паузе до ${time(state.pausedUntil)} (${state.timezone}).`;
  }
  const pause = state.autonomousDisabled
    ? 'отключены'
    : state.pausedUntil !== null && now < state.pausedUntil
      ? `пауза до ${time(state.pausedUntil)} (${state.timezone})`
      : 'паузы нет';
  const lines = [
    `${scope.chatId}@${scope.generation}`,
    state.enabled ? 'Бот включён.' : 'Бот выключен.',
    `Режим: ${modeLabel[state.mode]}.`,
    `Самостоятельные реплики: ${pause}.`,
  ];
  const hour = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  lines.push(
    state.quietHours
      ? `Тихие часы ${hour(state.quietHours.start)}–${hour(state.quietHours.end)} (${state.timezone}).`
      : 'Тихие часы выключены.',
  );
  if (
    !state.autonomousDisabled &&
    state.nextParticipantPause !== null &&
    now < state.nextParticipantPause
  ) {
    lines.push(
      `Следующая пауза от участника доступна с ${time(state.nextParticipantPause)} (${state.timezone}).`,
    );
  }
  return lines.join('\n');
}
