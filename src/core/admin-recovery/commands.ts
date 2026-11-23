import type { ChatId, UserId } from '../../contracts/index';

export type AdminRecoveryCommand =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'recover';
      readonly chatId: ChatId;
      readonly generation: number;
      readonly userId: UserId;
    }
  | { readonly kind: 'retry'; readonly id: number }
  | { readonly kind: 'invalid' };

export function parseAdminRecoveryCommand(text: string): AdminRecoveryCommand | undefined {
  const [name, first, second, ...rest] = text.trim().split(/\s+/u);
  if (name === '/беседы-без-админов')
    return first === undefined ? { kind: 'list' } : { kind: 'invalid' };
  if (name === '/повторить-подтверждение') {
    const id = Number(first);
    return String(id) === first && Number.isSafeInteger(id) && id > 0 && second === undefined
      ? { kind: 'retry', id }
      : { kind: 'invalid' };
  }
  if (name !== '/восстановить-админа') return undefined;
  const target = /^([a-z][a-z0-9_-]*:[1-9]\d*)@([1-9]\d*)$/u.exec(first ?? '');
  if (!target || !second || !/^[a-z][a-z0-9_-]*:[1-9]\d*$/u.test(second) || rest.length)
    return { kind: 'invalid' };
  const generation = Number(target[2]);
  return Number.isSafeInteger(generation)
    ? { kind: 'recover', chatId: target[1] as ChatId, generation, userId: second as UserId }
    : { kind: 'invalid' };
}
