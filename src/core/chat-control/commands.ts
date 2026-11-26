import type { ChatId } from '../../contracts/index';
import type { ResponseMode } from '../../storage/types';
import type { ServiceCommand } from '../message-router/types';
import type { QuietHours } from '../../storage/chat-control-store';

export type ChatControlCommand =
  | {
      readonly kind:
        | 'settings'
        | 'modeHelp'
        | 'quietHelp'
        | 'greetingHelp'
        | 'invitationHelp'
        | 'extendHelp'
        | 'on'
        | 'off'
        | 'pause'
        | 'disableAutonomous'
        | 'questionnaire'
        | 'questionnaireEdit';
    }
  | { readonly kind: 'mode'; readonly mode: ResponseMode }
  | { readonly kind: 'greeting' | 'invitation'; readonly enabled: boolean }
  | { readonly kind: 'quietHours'; readonly hours: QuietHours | null }
  | { readonly kind: 'extend'; readonly minutes: number };
export type ChatControlRequest = {
  readonly command: ChatControlCommand | 'explain' | 'invalid';
  readonly target?: { readonly chatId: ChatId; readonly generation: number };
};

export function chatControlAction(command: ChatControlCommand): ServiceCommand {
  if (command.kind === 'questionnaire' || command.kind === 'questionnaireEdit')
    return {
      action: 'chat.onboarding.configure',
      minimumRole: 'admin',
      journalLabel: 'Команда вопросов анкеты',
    };
  if (command.kind === 'pause') return { action: 'chat.pause', minimumRole: 'member' };
  if (
    command.kind === 'extend' ||
    command.kind === 'extendHelp' ||
    command.kind === 'disableAutonomous'
  )
    return { action: 'chat.pause.extend', minimumRole: 'admin' };
  if (command.kind === 'on' || command.kind === 'off')
    return { action: 'chat.enable', minimumRole: 'owner' };
  return { action: 'chat.configure', minimumRole: 'admin' };
}

const modes = new Map<string, ResponseMode>([
  ['молчаливый', 'silent'],
  ['нормальный', 'normal'],
  ['активный', 'active'],
]);
const simple = new Map<string, ChatControlCommand['kind']>([
  ['/настройки', 'settings'],
  ['/включить-бота', 'on'],
  ['/выключить-бота', 'off'],
  ['помолчи', 'pause'],
  ['/отключить-самостоятельные-реплики', 'disableAutonomous'],
]);

export function parseChatBinding(value: string | undefined): ChatControlRequest['target'] {
  const match = /^([a-z][a-z0-9_-]*:[1-9]\d*)@([1-9]\d*)$/u.exec(value ?? '');
  const generation = Number(match?.[2]);
  return match && Number.isSafeInteger(generation)
    ? { chatId: match[1] as ChatId, generation }
    : undefined;
}

function quietHours(args: readonly string[]): ChatControlRequest['command'] {
  if (args.length === 0) return { kind: 'settings' };
  if (args.length === 1 && args[0] === 'выкл') return { kind: 'quietHours', hours: null };
  const interval = /^([01]\d|2[0-3]):([0-5]\d)\s*[–—-]\s*([01]\d|2[0-3]):([0-5]\d)$/u.exec(
    args.join(' '),
  );
  if (!interval) return { kind: 'quietHelp' };
  const start = Number(interval[1]) * 60 + Number(interval[2]);
  const end = Number(interval[3]) * 60 + Number(interval[4]);
  return start === end ? { kind: 'quietHelp' } : { kind: 'quietHours', hours: { start, end } };
}

export function parseChatControl(
  text: string,
  location: 'group' | 'private',
): ChatControlRequest | undefined {
  const clean = text.trim().toLowerCase();
  if (/^почему ты так ответил(?:\s|$)/u.test(clean)) {
    if (location === 'group') return { command: 'invalid' };
    const parts = clean.slice('почему ты так ответил'.length).trim().split(/\s+/u);
    const target = parts.length === 1 ? parseChatBinding(parts[0]) : undefined;
    return target ? { command: 'explain', target } : { command: 'invalid' };
  }
  const [name, ...args] = clean.split(/\s+/u);
  if (!name || (name === 'помолчи' && (location === 'private' || args.length))) return undefined;
  if (location === 'group' && name === '/анкета' && args.join(' ') === 'вопросы изменить')
    return { command: { kind: 'questionnaireEdit' } };
  if (name === '/вопросы')
    return {
      command:
        location !== 'group'
          ? 'invalid'
          : !args.length
            ? { kind: 'questionnaire' }
            : args.length === 1 && args[0] === 'изменить'
              ? { kind: 'questionnaireEdit' }
              : 'invalid',
    };
  const kind = simple.get(name);
  if (
    !kind &&
    !['/режим', '/продлить-паузу', '/тихие-часы', '/приветствие', '/приглашение'].includes(name)
  )
    return undefined;
  if (location === 'group' && kind === 'on') return { command: 'invalid' };
  const target = location === 'private' ? parseChatBinding(args.shift()) : undefined;
  if (location === 'private' && !target) return { command: 'invalid' };
  let command: ChatControlRequest['command'] = 'invalid';
  if (name === '/тихие-часы') command = quietHours(args);
  else if (
    (name === '/приветствие' || name === '/приглашение') &&
    args.length === 1 &&
    (args[0] === 'вкл' || args[0] === 'выкл')
  )
    command = {
      kind: name === '/приветствие' ? 'greeting' : 'invitation',
      enabled: args[0] === 'вкл',
    };
  else if (name === '/приветствие' || name === '/приглашение')
    command = { kind: name === '/приветствие' ? 'greetingHelp' : 'invitationHelp' };
  else if (name === '/режим') {
    const mode = args.length === 1 ? modes.get(args[0]!) : undefined;
    command = mode ? { kind: 'mode', mode } : { kind: 'modeHelp' };
  } else if (name === '/продлить-паузу') {
    const minutes = Number(args[0]);
    command =
      args.length === 1 && /^[1-9]\d*$/u.test(args[0]!) && Number.isSafeInteger(minutes)
        ? { kind: 'extend', minutes }
        : { kind: 'extendHelp' };
  } else if (
    kind &&
    kind !== 'mode' &&
    kind !== 'extend' &&
    kind !== 'quietHours' &&
    kind !== 'greeting' &&
    kind !== 'invitation' &&
    args.length === 0
  )
    command = { kind };
  return target ? { command, target } : { command };
}
