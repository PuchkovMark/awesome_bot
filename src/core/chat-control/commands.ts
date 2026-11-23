import type { ChatId } from '../../contracts/index';
import type { ResponseMode } from '../../storage/types';
import type { ServiceCommand } from '../message-router/types';
import type { QuietHours } from '../../storage/chat-control-store';

export type ChatControlCommand =
  | { readonly kind: 'settings' | 'on' | 'off' | 'pause' | 'disableAutonomous' }
  | { readonly kind: 'mode'; readonly mode: ResponseMode }
  | { readonly kind: 'greeting' | 'invitation'; readonly enabled: boolean }
  | { readonly kind: 'quietHours'; readonly hours: QuietHours | null }
  | { readonly kind: 'extend'; readonly minutes: number };
export type ChatControlRequest = {
  readonly command: ChatControlCommand | 'explain' | 'invalid';
  readonly target?: { readonly chatId: ChatId; readonly generation: number };
};

export function chatControlAction(command: ChatControlCommand): ServiceCommand {
  if (command.kind === 'pause') return { action: 'chat.pause', minimumRole: 'member' };
  if (command.kind === 'extend' || command.kind === 'disableAutonomous')
    return { action: 'chat.pause.extend', minimumRole: 'admin' };
  return { action: 'chat.configure', minimumRole: command.kind === 'on' ? 'owner' : 'admin' };
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
  if (args.length !== 1) return 'invalid';
  if (args[0] === 'выкл') return { kind: 'quietHours', hours: null };
  const interval = /^([01]\d|2[0-3]):([0-5]\d)[–-]([01]\d|2[0-3]):([0-5]\d)$/u.exec(args[0]!);
  if (!interval) return 'invalid';
  const start = Number(interval[1]) * 60 + Number(interval[2]);
  const end = Number(interval[3]) * 60 + Number(interval[4]);
  return start === end ? 'invalid' : { kind: 'quietHours', hours: { start, end } };
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
  else if (name === '/режим' && args.length === 1) {
    const mode = modes.get(args[0]!);
    if (mode) command = { kind: 'mode', mode };
  } else if (name === '/продлить-паузу' && args.length === 1 && /^[1-9]\d*$/u.test(args[0]!)) {
    const minutes = Number(args[0]);
    if (Number.isSafeInteger(minutes)) command = { kind: 'extend', minutes };
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
