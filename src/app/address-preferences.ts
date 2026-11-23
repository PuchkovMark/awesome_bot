import type { createVkChannel } from '../channels/index';
import type { ConnectionScope, IncomingMessage } from '../contracts/index';
import {
  addressPreferenceStore,
  type AddressPreferenceChange,
} from '../storage/address-preference-store';
import { chatControlStore } from '../storage/chat-control-store';
import type { Storage } from '../storage/index';

const botName = /^пен[её]к(?![\p{L}\p{N}_])[\s,!:.—-]*/iu;

function parse(message: IncomingMessage): AddressPreferenceChange | null {
  if (
    message.isBot !== false ||
    message.hasForwarded ||
    message.replyAddress === 'other' ||
    message.replyAddress === 'unknown'
  )
    return null;
  const name = botName.exec(message.text.trim());
  if (message.isGroupChat) {
    if (!name && !message.isReplyToBot && (!message.isMentioned || message.hasOtherAddress))
      return null;
  } else if (message.chatId !== message.userId) return null;
  const text = message.text.trim().slice(name?.[0].length ?? 0);
  if (/^обращайся ко мне как в vk[.!]?$/iu.test(text)) return { kind: 'reset' };
  if (/^скрой мо[её] обращение[.!]?$/iu.test(text)) return { kind: 'visibility', value: 'bot' };
  if (/^показывай мо[её] обращение в беседе[.!]?$/iu.test(text))
    return { kind: 'visibility', value: 'chat' };
  const form = /^называй меня +([^\p{Cc}\p{Zl}\p{Zp}]+)$/iu.exec(text)?.[1]?.trim();
  return form ? { kind: 'set', form } : null;
}

export function createAddressPreferenceHandlers(options: {
  readonly storage: Storage;
  readonly channel: ReturnType<typeof createVkChannel>;
  readonly signal: AbortSignal;
}) {
  const store = addressPreferenceStore(options.storage);
  const controls = chatControlStore(options.storage);
  const { channel, signal } = options;
  return {
    recognize(message: IncomingMessage) {
      return parse(message)
        ? ({ action: 'profile.self.address', minimumRole: 'member' } as const)
        : null;
    },
    async execute(scope: ConnectionScope, message: IncomingMessage, current: () => boolean) {
      const change = parse(message);
      const sequence = Number(message.messageId);
      if (
        !change ||
        String(sequence) !== message.messageId ||
        !Number.isSafeInteger(sequence) ||
        sequence <= 0
      )
        return;
      const isCurrent = () => {
        if (signal.aborted || !current()) return false;
        try {
          const state = controls.read(scope);
          return state.enabled && state.mode !== 'silent';
        } catch {
          return false;
        }
      };
      if (!isCurrent()) return;
      const result = store.change(
        scope,
        message.userId,
        {
          sequence,
          at: message.timestamp,
          isGroupChat: message.isGroupChat,
        },
        change,
        isCurrent,
      );
      if (result === 'stale' || !isCurrent()) return;
      const response =
        result === 'blocked'
          ? 'Для настройки обращения нужен доступный профиль в этом чате.'
          : change.kind === 'reset'
            ? 'В этом чате снова использую актуальное имя VK.'
            : 'Настройка обращения обновлена для этого чата.';
      const guard = { signal, isCurrent, allow: async () => isCurrent() };
      if (message.isGroupChat) await channel.replyGroupControl(scope, response, guard);
      else await channel.replyPrivateControl(message.userId, response, guard);
    },
  };
}
