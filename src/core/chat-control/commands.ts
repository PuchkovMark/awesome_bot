import type { ChatId } from '../../contracts/index';
import type { ResponseMode } from '../../storage/types';
import type { ServiceCommand } from '../message-router/types';

export type ChatControlCommand =
  | { readonly kind: 'settings' | 'on' | 'off' | 'pause' | 'disableAutonomous' }
  | { readonly kind: 'mode'; readonly mode: ResponseMode }
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
  if (!kind && name !== '/режим' && name !== '/продлить-паузу') return undefined;
  if (location === 'group' && kind === 'on') return { command: 'invalid' };
  const target = location === 'private' ? parseChatBinding(args.shift()) : undefined;
  if (location === 'private' && !target) return { command: 'invalid' };
  let command: ChatControlRequest['command'] = 'invalid';
  if (name === '/режим' && args.length === 1) {
    const mode = modes.get(args[0]!);
    if (mode) command = { kind: 'mode', mode };
  } else if (name === '/продлить-паузу' && args.length === 1 && /^[1-9]\d*$/u.test(args[0]!)) {
    const minutes = Number(args[0]);
    if (Number.isSafeInteger(minutes)) command = { kind: 'extend', minutes };
  } else if (kind && kind !== 'mode' && kind !== 'extend' && args.length === 0) command = { kind };
  return target ? { command, target } : { command };
}
