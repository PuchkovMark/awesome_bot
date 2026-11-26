import type { AuthorizationContext, ConnectionScope, IncomingMessage } from '../contracts/index';
import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import { splitVkText, vkMessageLength } from '../channels/vk/outbound-text';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import { chatControlStore } from '../storage/chat-control-store';
import { StorageError } from '../storage/errors';
import { questionnaireStore } from '../storage/questionnaire-store';
import type { QuestionnaireReplyResult } from '../storage/questionnaire-types';
import type { Storage } from '../storage/types';
import {
  pendingControlPrompts,
  verifiedControlReplyText,
  type TrackPublication,
} from './control-publications';

const heading = 'Вопросы анкеты';
const sample = 'Стартовый образец анкеты\nСписок этой беседы пока не сохранён.';
const viewInstruction = '\n\nДля правки отправьте /вопросы изменить.';
const partMark = '\nСписок показан частями.\n\n';
const editorHeading = 'Редактор анкеты';
const instruction =
  '\n\nЧтобы изменить анкету, ответьте на это сообщение полным списком, по одному вопросу на строку.';
const continuation = '\n\nДля правки дождитесь сообщения редактора.';
const reopen = 'Откройте /вопросы изменить и ответьте на сообщение редактора полным списком.';
const confirmation = 'Ответьте на это сообщение «Заменить» или «Оставить».';
const invitationPrefix = 'Приглашения к анкете включены. В анкете ';
const invitationInstruction =
  ' Чтобы заменить их, ответьте на это сообщение всем списком, по одному вопросу на строку.';
const edit = {
  action: 'chat.onboarding.configure',
  minimumRole: 'admin',
  journalLabel: 'Действие с вопросами анкеты',
} as const;

function looksLikeEditor(text: string | undefined) {
  return (
    !!text &&
    (invitationEditor(text) ||
      ((text.startsWith(heading + '\n') ||
        text.startsWith(sample) ||
        text.startsWith(editorHeading + '\n')) &&
        (text.endsWith(instruction) || text.endsWith(continuation))) ||
      (text.startsWith('В списке ') && text.endsWith(confirmation)))
  );
}

function invitationEditor(text: string | undefined) {
  return !!text?.startsWith(invitationPrefix) && text.endsWith(invitationInstruction);
}

function serviceReply(text: string, parent: string | undefined) {
  const command = text.trim();
  return invitationEditor(parent) && /^\/[^\r\n]+$/u.test(command);
}

function invitationText(count: number) {
  const form = new Intl.PluralRules('ru').select(count);
  const noun = form === 'one' ? 'вопрос' : form === 'few' ? 'вопроса' : 'вопросов';
  return invitationPrefix + count + ' ' + noun + '.';
}

function questionView(text: string) {
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  if (!normalized.endsWith(viewInstruction)) return undefined;
  const title = [heading, sample].find((part) => normalized.startsWith(part + '\n'));
  if (!title) return undefined;
  const framed = normalized.slice(title.length, -viewInstruction.length);
  if (framed.startsWith(partMark)) return { kind: 'part' } as const;
  if (framed.startsWith('\n\n')) return { kind: 'full', text: framed.slice(2) } as const;
}

function questionViewParts(title: string, list: readonly string[]) {
  const body = list.join('\n');
  const full = title + '\n\n' + body + viewInstruction;
  if (Buffer.byteLength(full) <= vkMessageLength.value) return [full];
  const prefix = title + partMark;
  const limit = vkMessageLength.value - Buffer.byteLength(prefix + viewInstruction);
  return splitVkText(body, limit).map((part) => prefix + part + viewInstruction);
}

function preview(title: string, lines: readonly string[]) {
  const list = lines.join('\n');
  const prefix = title + '\n\n';
  if (Buffer.byteLength(prefix + list + instruction) <= vkMessageLength.value)
    return { display: [], editor: prefix + list + instruction };
  const limit = vkMessageLength.value - Buffer.byteLength(prefix + continuation);
  return {
    display: splitVkText(list, limit).map((part) => prefix + part + continuation),
    editor: `${editorHeading}\nВопросов в показанном списке — ${lines.length}.` + instruction,
  };
}

function replyText(result: QuestionnaireReplyResult) {
  switch (result.status) {
    case 'applied':
      return `Анкета сохранена. Количество вопросов — ${result.count}.`;
    case 'kept':
      return 'Прежний список вопросов сохранён.';
    case 'choose':
      return 'Ответьте на запрос подтверждения «Заменить» или «Оставить».';
    case 'confirm':
    case 'duplicate':
      return null;
    case 'stale':
      return 'Список вопросов изменился. ' + reopen;
    case 'closed':
      return reopen;
    case 'empty':
      return 'В списке должен быть хотя бы один вопрос. Прежняя редакция сохранена.';
    case 'too_long':
      return `Весь список должен помещаться в одно сообщение до ${vkMessageLength.value} байт UTF-8. Прежняя редакция сохранена.`;
    case 'invalid':
      return 'Пришлите вопросы обычным текстом, по одному на строку.';
  }
}

export function createQuestionnaireEditor(options: {
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
  const { storage, authorization, channel, lifecycle, signal } = options;
  const questionnaires = questionnaireStore(storage);
  const controls = chatControlStore(storage);
  const prompts = pendingControlPrompts();

  function guardFor(context: AuthorizationContext, accepted: () => boolean) {
    const current = () =>
      accepted() &&
      lifecycle.isAdmissionCurrent(context.scope) &&
      controls.read(context.scope).enabled;
    return {
      signal,
      isCurrent: current,
      async allow() {
        return (
          !signal.aborted &&
          current() &&
          (await authorization.check(context, edit.action)).allowed &&
          current()
        );
      },
    };
  }

  function sendEditor(
    context: AuthorizationContext,
    guard: ReturnType<typeof guardFor>,
    revision: number,
    editor: string,
    display: readonly string[] = [],
  ) {
    const scope = context.scope;
    const current = () =>
      guard.isCurrent() && questionnaires.current(scope)?.ref.revision === revision;
    const stillShown = { ...guard, isCurrent: current };
    options.track(
      prompts.send(scope, context.userId, editor, async (receivedId) => {
        for (const chunk of display)
          if (!(await channel.deliverGroupControl(scope, chunk, stillShown))) return;
        const receipt = await channel.deliverGroupControl(scope, editor, {
          ...stillShown,
          receivedId,
        });
        if (receipt && current() && (await guard.allow()) && current())
          questionnaires.recordPrompt(scope, context.userId, revision, receipt);
      }),
    );
  }

  return {
    confirmInvitation(context: AuthorizationContext, accepted: () => boolean) {
      const shown = questionnaires.current(context.scope);
      if (!shown) return;
      sendEditor(
        context,
        guardFor(context, accepted),
        shown.ref.revision,
        invitationText(shown.questions.length) + invitationInstruction,
      );
    },
    invitationPrivate(scope: ConnectionScope) {
      const count = questionnaires.current(scope)?.questions.length ?? 0;
      return (
        invitationText(count) +
        ' Чтобы заменить список, отправьте /анкета вопросы изменить в самой беседе.'
      );
    },
    beforePersonalCommands(message: VkIncoming) {
      if (!isVkGroupChat(message.peerId) || !message.reply) return false;
      if (serviceReply(message.text, message.reply.text)) return false;
      if (looksLikeEditor(message.reply.text)) return true;
      try {
        return questionnaires.hasPrompt(
          lifecycle.admissionScope(vkChatId(message.peerId)),
          String(message.reply.cmid),
        );
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        return false;
      }
    },
    ownsReply(scope: ConnectionScope, message: IncomingMessage) {
      return (
        message.replyAddress === 'bot' &&
        !message.hasForwarded &&
        !serviceReply(message.text, message.botReplyText) &&
        !!message.replyToMessageId &&
        (prompts.owns(scope, message) ||
          questionnaires.ownsPrompt(scope, message.replyToMessageId, message.userId))
      );
    },
    recognizeReply(scope: ConnectionScope, message: IncomingMessage) {
      if (!message.isGroupChat || serviceReply(message.text, message.botReplyText)) return null;
      const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
      return receipt !== undefined &&
        (looksLikeEditor(message.botReplyText) ||
          prompts.has(scope, message) ||
          questionnaires.hasPrompt(scope, receipt))
        ? edit
        : null;
    },
    async show(
      context: AuthorizationContext,
      message: IncomingMessage,
      accepted: () => boolean,
      editing: boolean,
    ) {
      if (!message.isGroupChat || message.isBot !== false || message.hasForwarded) return;
      if (message.replyAddress || message.replyToMessageId) {
        const parent = verifiedControlReplyText(message);
        if (!editing || parent === undefined || !questionView(parent)) return;
      }
      const guard = guardFor(context, accepted);
      if (!(await guard.allow())) return;
      const scope = context.scope;
      const chosen = questionnaires.current(scope);
      if (!chosen) return;
      const list = chosen.questions.map(({ text }) => text);
      if (!editing) {
        const parts = questionViewParts(heading, list);
        options.track(
          (async () => {
            for (const part of parts)
              if (!(await channel.deliverGroupControl(scope, part, guard))) break;
          })(),
        );
        return;
      }
      const { display, editor } = preview(heading, list);
      sendEditor(context, guard, chosen.ref.revision, editor, display);
    },
    async reply(context: AuthorizationContext, message: IncomingMessage, accepted: () => boolean) {
      if (
        message.isBot !== false ||
        message.hasForwarded ||
        serviceReply(message.text, message.botReplyText) ||
        message.replyAddress !== 'bot' ||
        !message.replyToMessageId
      )
        return;
      const guard = guardFor(context, accepted);
      if (!guard.isCurrent()) return;
      const raw = message.literalText ?? message.text;
      const view = questionView(raw);
      if (message.attachments.length || looksLikeEditor(raw) || view?.kind === 'part') {
        options.track(channel.replyGroupControl(context.scope, reopen, guard));
        return;
      }
      const id = Number(message.messageId);
      if (!Number.isSafeInteger(id) || id < 1 || String(id) !== message.messageId) return;
      const editor = message.replyToMessageId;
      const text = view?.kind === 'full' ? view.text : raw;
      const apply = async () => {
        if (!guard.isCurrent()) return;
        const result = await authorization.applyQuestionnaireReply(
          context,
          { receipt: editor, eventId: id, eventAt: message.timestamp, text },
          guard.isCurrent,
        );
        if (result.allowed && result.value.status === 'confirm') {
          const { before, shown, question } = result.value;
          const form = new Intl.PluralRules('ru').select(before);
          const noun = form === 'few' ? 'вопроса' : form === 'one' ? 'вопрос' : 'вопросов';
          const text = `В списке ${before} ${noun}, останется 1. ${confirmation}`;
          options.track(
            prompts.send(context.scope, context.userId, text, async (receivedId) => {
              const receipt = await channel.deliverGroupControl(context.scope, text, {
                ...guard,
                receivedId,
              });
              if (receipt && (await guard.allow()))
                questionnaires.recordPrompt(context.scope, context.userId, shown, receipt, {
                  editor,
                  eventId: message.messageId,
                  question,
                });
            }),
          );
          return;
        }
        const response = result.allowed ? replyText(result.value) : null;
        if (response && guard.isCurrent())
          options.track(channel.replyGroupControl(context.scope, response, guard));
      };
      const waiting = prompts.defer(context.scope, message, apply);
      if (waiting) options.track(waiting);
      else await apply();
    },
  };
}
