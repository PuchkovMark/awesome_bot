import type { AuthorizationContext, IncomingMessage } from '../contracts/index';
import type { createVkChannel } from '../channels/index';
import type { createAuthorizationService } from '../core/authorization/service';
import type { ServiceCommand } from '../core/message-router/types';
import { starterPersonas, type PersonaCard } from '../core/personas/catalog';
import { starterPersonaCard } from '../core/personas/card';
import { chatControlStore } from '../storage/chat-control-store';
import type { Storage } from '../storage/index';

type Request =
  | { readonly kind: 'view'; readonly unknownName: boolean }
  | { readonly kind: 'select'; readonly card: PersonaCard };

const personaCommand = /^\/персонаж(?:[^\S\r\n]+([^\r\n]+))?$/iu;

export function isPersonaCommand(text: string): boolean {
  return personaCommand.test(text.trim());
}

function parse(message: IncomingMessage): Request | null {
  if (
    message.isBot !== false ||
    message.attachments.length ||
    message.hasForwarded ||
    message.replyAddress === 'other' ||
    message.replyAddress === 'unknown' ||
    (!message.isGroupChat && message.chatId !== message.userId)
  )
    return null;
  const command = personaCommand.exec(message.text.trim());
  if (!command) return null;
  const name = command[1]?.trim().normalize('NFC').toLowerCase();
  const card = name && starterPersonas.find((item) => item.name.toLowerCase() === name);
  return card ? { kind: 'select', card } : { kind: 'view', unknownName: name !== undefined };
}

function service(request: Request, group: boolean): ServiceCommand {
  const journalLabel = 'Команда выбора персонажа';
  if (request.kind === 'view')
    return { action: 'chat.persona.read', minimumRole: 'member', journalLabel };
  return group
    ? { action: 'chat.persona.select', minimumRole: 'admin', journalLabel }
    : { action: 'persona.self.select', minimumRole: 'member', journalLabel };
}

const names = starterPersonas.map(({ name }) => name).join(', ');

export function createPersonaCommands(options: {
  readonly storage: Storage;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    'replyGroupControl' | 'replyPrivateControl'
  >;
  readonly signal: AbortSignal;
}) {
  const { storage, authorization, channel, signal } = options;
  const controls = chatControlStore(storage);
  return {
    recognize(message: IncomingMessage) {
      const request = parse(message);
      return request ? service(request, message.isGroupChat) : null;
    },
    async execute(context: AuthorizationContext, message: IncomingMessage, current: () => boolean) {
      const request = parse(message);
      if (!request || context.chatId !== message.chatId || context.userId !== message.userId)
        return;
      const command = service(request, message.isGroupChat);
      const subject = command.action === 'persona.self.select' ? context.userId : undefined;
      const isCurrent = () => {
        if (signal.aborted || !current()) return false;
        try {
          const state = controls.read(context.scope);
          return state.enabled && (message.isGroupChat || state.mode !== 'silent');
        } catch {
          return false;
        }
      };
      const allow = async () => {
        if (!isCurrent() || !(await authorization.check(context, command.action, subject)).allowed)
          return false;
        if (!isCurrent()) return false;
        if (request.kind === 'view' && controls.read(context.scope).mode === 'silent') {
          const role = await authorization.role(context);
          return isCurrent() && role.allowed && role.value !== 'member';
        }
        return true;
      };
      if (!isCurrent()) return;
      let text: string;
      if (request.kind === 'select') {
        const sequence = Number(message.messageId);
        if (
          !Number.isSafeInteger(sequence) ||
          sequence <= 0 ||
          String(sequence) !== message.messageId
        )
          return;
        const result = await authorization.selectPersona(
          context,
          request.card.id,
          { sourceChatId: message.chatId, messageId: sequence, timestamp: message.timestamp },
          isCurrent,
        );
        if (!result.allowed || result.value.status !== 'selected') return;
        text = `В этом чате теперь отвечает ${request.card.name}.`;
      } else {
        if (!(await allow())) return;
        const selected = await storage.contextState.persona(context.scope);
        const name = selected && starterPersonaCard(selected)?.name;
        const effective = name
          ? `Текущий персонаж — ${name}.`
          : selected
            ? 'Действует ранее выбранный персонаж.'
            : 'Персонаж ещё не выбран.';
        text =
          (request.unknownName ? 'Персонаж с таким именем недоступен.\n' : '') +
          effective +
          `\nДоступные персонажи — ${names}.`;
      }
      if (!isCurrent()) return;
      const guard = { signal, isCurrent, allow };
      if (message.isGroupChat) await channel.replyGroupControl(context.scope, text, guard);
      else await channel.replyPrivateControl(context.userId, text, guard);
    },
  };
}
