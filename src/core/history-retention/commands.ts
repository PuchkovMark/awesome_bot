import type { ChatId } from '../../contracts/index';
import { parseChatBinding } from '../chat-control/commands';

export interface HistoryTarget {
  readonly chatId: ChatId;
  readonly generation: number;
}
export type HistoryCommand =
  | { readonly kind: 'request'; readonly target?: HistoryTarget }
  | { readonly kind: 'confirm'; readonly code: string }
  | { readonly kind: 'invalid' };

export function parseHistoryCommand(
  text: string,
  channel: 'group' | 'private',
): HistoryCommand | undefined {
  const [name, ...args] = text.trim().toLowerCase().split(/\s+/u);
  if (name === '/очистить-историю') {
    if (channel === 'group' && args.length === 0) return { kind: 'request' };
    const target =
      channel === 'private' && args.length === 1 ? parseChatBinding(args[0]) : undefined;
    return target ? { kind: 'request', target } : { kind: 'invalid' };
  }
  if (name === '/подтвердить-очистку') {
    const code = args[0];
    return args.length === 1 && code && /^[0-9a-f]{32}$/u.test(code)
      ? { kind: 'confirm', code }
      : { kind: 'invalid' };
  }
  return undefined;
}
