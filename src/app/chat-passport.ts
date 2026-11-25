import type { AuthorizationContext, ConnectionScope, IncomingMessage } from '../contracts/index';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import type { createVkChannel } from '../channels/vk/channel';
import { vkMessageLength } from '../channels/vk/outbound-text';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import { ordinaryGroupRoute } from '../core/message-router/routing';
import { pendingControlPrompts, type TrackPublication } from './control-publications';
import { chatControlStore } from '../storage/chat-control-store';
import { chatPassportStore } from '../storage/chat-passport-store';
import {
  passportSectionBytes,
  passportSections,
  type PassportEntry,
  type PassportReplyResult,
  type PassportSection,
} from '../storage/chat-passport-types';
import { StorageError } from '../storage/errors';
import type { Storage } from '../storage/types';

const sections = {
  topic: { title: 'Тема', command: '/паспорт тема' },
  rules: { title: 'Правила', command: '/правила' },
  traditions: { title: 'Традиции', command: '/традиции' },
  glossary: { title: 'Глоссарий', command: '/паспорт глоссарий' },
  events: { title: 'Важные события', command: '/события' },
} satisfies Record<PassportSection, { readonly title: string; readonly command: string }>;
const editInstruction =
  '\n\nОтветьте на это сообщение полным новым текстом. Раздел виден всем участникам беседы.';
const clearInstruction = '\nЧтобы очистить раздел, ответьте «Подтверждаю».';
const read = {
  action: 'chat.passport.read',
  minimumRole: 'member',
  journalLabel: 'Команда паспорта беседы',
} as const;
const edit = {
  action: 'chat.passport.edit',
  minimumRole: 'admin',
  journalLabel: 'Действие с паспортом беседы',
} as const;

type Request =
  | { readonly kind: 'all' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'section' | 'edit' | 'clear'; readonly section: PassportSection };

function parse(text: string): Request | null {
  const tokens = text.trim().toLowerCase().split(/\s+/u);
  if (tokens[0] === '/паспорт' && tokens.length === 1) return { kind: 'all' };
  for (const section of passportSections) {
    const prefix = sections[section].command.split(' ');
    if (!prefix.every((token, index) => token === tokens[index])) continue;
    if (tokens.length === prefix.length) return { kind: 'section', section };
    if (tokens.length === prefix.length + 1 && tokens.at(-1) === 'изменить')
      return { kind: 'edit', section };
    if (tokens.length === prefix.length + 1 && tokens.at(-1) === 'очистить')
      return { kind: 'clear', section };
  }
  return ['/паспорт', '/правила', '/традиции', '/события'].includes(tokens[0]!)
    ? { kind: 'invalid' }
    : null;
}

const sectionNames = new Map<string, PassportSection>([
  ['тему', 'topic'],
  ['правила', 'rules'],
  ['глоссарий', 'glossary'],
  ['традиции', 'traditions'],
  ['события', 'events'],
  ['важные события', 'events'],
]);

function requestedSection(message: IncomingMessage) {
  if (message.isBot !== false || message.hasForwarded) return undefined;
  const route = ordinaryGroupRoute(message);
  if (route !== 'mention' && route !== 'reply' && route !== 'name') return undefined;
  const request = message.text
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/^пен[её]к(?:\s*[,!]\s*|\s+)/u, '')
    .replace(/\s*,\s*пен[её]к[.!?]*$/u, '')
    .replace(/^пожалуйста[ ,]+/u, '')
    .replace(/,\s*пожалуйста[.!?]*$/u, '')
    .replace(/[.!?]+$/u, '')
    .trim();
  const selected =
    /^(?:покажи|покажите|выведи|пришли) (?:мне |нам )?(правила|глоссарий|тему|традиции|(?:важные )?события)(?: (?:этой |этого )?(?:беседы|чата))?(?: целиком)?$/u.exec(
      request.replace(/\s+/gu, ' '),
    )?.[1];
  return selected === undefined ? undefined : sectionNames.get(selected);
}

function view(entry: PassportEntry) {
  return sections[entry.section].title + '\n' + (entry.text ?? 'Раздел пока пуст.');
}

function fullPassport(entries: readonly PassportEntry[]): readonly string[] {
  const filled = entries.filter((entry) => entry.text !== null);
  if (!filled.length) return ['Паспорт беседы пока пуст.'];
  const parts: string[] = [];
  let text = 'Паспорт беседы';
  for (const entry of filled) {
    const block = view(entry);
    if (Buffer.byteLength(text + '\n\n' + block) > vkMessageLength.value) {
      parts.push(text);
      text = block;
    } else text += '\n\n' + block;
  }
  parts.push(text);
  return parts;
}

function resultText(result: PassportReplyResult, section: PassportSection) {
  switch (result) {
    case 'duplicate':
      return null;
    case 'applied':
      return 'Раздел паспорта обновлён.';
    case 'too_long':
      return `Текст превышает предел в ${passportSectionBytes} байт UTF-8. Раздел сохранён в прежнем виде.`;
    case 'empty':
      return `Введите текст раздела. Для очистки используйте ${sections[section].command} очистить.`;
    case 'invalid_confirmation':
      return 'Для правки отправьте текст раздела. Для очистки ответьте «Подтверждаю» на запрос подтверждения.';
    case 'stale':
      return `Редакция раздела устарела. Откройте свежую командой ${sections[section].command}.`;
    case 'closed':
      return `Откройте свою подсказку командой ${sections[section].command}.`;
  }
}

export function createChatPassport(options: {
  readonly storage: Storage;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly lifecycle: ReturnType<typeof createLifecycleService>;
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    'replyGroupControl' | 'deliverGroupControl'
  >;
  readonly signal: AbortSignal;
  readonly track: TrackPublication;
}) {
  const { storage, authorization, lifecycle, channel, signal } = options;
  const passport = chatPassportStore(storage);
  const controls = chatControlStore(storage);
  const prompts = pendingControlPrompts();

  function sectionForReply(scope: ConnectionScope, message: IncomingMessage) {
    const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
    if (receipt === undefined) return undefined;
    const saved = passport.sectionForReply(scope, receipt);
    if (saved) return saved;
    // У сообщения с потерянной квитанцией может быть проверяемый reply.
    // Текст позволяет распознать маршрут, но запись требует существующей привязки.
    const text = message.botReplyText;
    if (!text || (!text.endsWith(editInstruction) && !text.endsWith(clearInstruction)))
      return undefined;
    return passportSections.find((section) => text.startsWith(sections[section].title + '\n'));
  }

  return {
    privateCommand(message: VkIncoming) {
      return !isVkGroupChat(message.peerId) && parse(message.text) !== null
        ? Promise.resolve()
        : undefined;
    },
    beforePersonalCommands(message: VkIncoming) {
      if (!isVkGroupChat(message.peerId) || !message.reply) return false;
      try {
        const scope = lifecycle.admissionScope(vkChatId(message.peerId));
        return passport.sectionForReply(scope, String(message.reply.cmid)) !== undefined;
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        return false;
      }
    },
    ownsReply(scope: ConnectionScope, message: IncomingMessage) {
      return (
        message.replyAddress === 'bot' &&
        !message.hasForwarded &&
        !!message.replyToMessageId &&
        (prompts.owns(scope, message) ||
          passport.ownsPrompt(scope, message.replyToMessageId, message.userId))
      );
    },
    recognize(scope: ConnectionScope, message: IncomingMessage) {
      if (!message.isGroupChat) return null;
      if (sectionForReply(scope, message)) return edit;
      const request = parse(message.text);
      if (request) return request.kind === 'clear' || request.kind === 'edit' ? edit : read;
      return requestedSection(message) ? read : null;
    },
    async execute(
      context: AuthorizationContext,
      message: IncomingMessage,
      accepted: () => boolean,
    ) {
      const scope = context.scope;
      const current = () => {
        if (!accepted() || !lifecycle.isAdmissionCurrent(scope)) return false;
        return controls.read(scope).enabled;
      };
      if (!current() || !message.isGroupChat || message.isBot !== false || message.hasForwarded)
        return;
      const guard = (action: typeof edit.action | typeof read.action) => ({
        signal,
        isCurrent: current,
        async allow() {
          if (
            signal.aborted ||
            !current() ||
            !(await authorization.check(context, action)).allowed ||
            !current()
          )
            return false;
          if (controls.read(scope).mode !== 'silent') return true;
          const role = await authorization.role(context);
          return current() && role.allowed && role.value !== 'member';
        },
      });
      const reply = (text: string) =>
        options.track(channel.replyGroupControl(scope, text, guard(read.action)));
      const referenced = sectionForReply(scope, message);
      if (referenced) {
        if (message.replyAddress !== 'bot' || !message.replyToMessageId) return;
        const eventId = Number(message.messageId);
        if (!Number.isSafeInteger(eventId) || eventId < 1 || String(eventId) !== message.messageId)
          return;
        const receipt = message.replyToMessageId;
        const apply = async () => {
          if (!current()) return;
          const result = await authorization.applyPassportReply(
            context,
            {
              receipt,
              eventId,
              eventAt: message.timestamp,
              text: message.literalText ?? message.text,
            },
            current,
          );
          const text = result.allowed ? resultText(result.value, referenced) : null;
          if (text && current()) reply(text);
        };
        const waiting = prompts.defer(scope, message, apply);
        if (waiting) options.track(waiting);
        else await apply();
        return;
      }

      const selected = requestedSection(message);
      if (selected) {
        const entry = passport.read(scope).find(({ section }) => section === selected)!;
        reply(view(entry));
        return;
      }
      const request = parse(message.text);
      if (!request || message.replyAddress || message.replyToMessageId) return;
      if (request.kind === 'invalid') {
        reply('Откройте паспорт командой /паспорт или выберите раздел его командой.');
        return;
      }
      const entries = passport.read(scope);
      if (request.kind === 'all') {
        const parts = fullPassport(entries);
        options.track(
          (async () => {
            for (const part of parts) {
              if (!current()) break;
              await channel.replyGroupControl(scope, part, guard(read.action));
            }
          })(),
        );
        return;
      }
      const entry = entries.find(({ section }) => section === request.section)!;
      const canEdit = await authorization.check(context, edit.action);
      if (!current()) return;
      if (!canEdit.allowed) {
        if (request.kind === 'section') reply(view(entry));
        return;
      }
      if (request.kind === 'section') {
        reply(
          view(entry) + `\n\nДля правки отправьте ${sections[entry.section].command} изменить.`,
        );
        return;
      }
      if (request.kind === 'clear' && entry.text === null) {
        reply(view(entry));
        return;
      }
      const text =
        request.kind === 'clear'
          ? sections[entry.section].title + clearInstruction
          : view(entry) + editInstruction;
      options.track(
        prompts.send(scope, context.userId, text, async (receivedId) => {
          const part = await channel.deliverGroupControl(scope, text, {
            ...guard(edit.action),
            receivedId,
          });
          if (part && current() && (await guard(edit.action).allow()))
            passport.recordPrompt(
              scope,
              context.userId,
              entry,
              request.kind === 'clear' ? 'clear' : 'edit',
              part,
              Date.now(),
            );
        }),
      );
    },
    prune: passport.prune,
  };
}
