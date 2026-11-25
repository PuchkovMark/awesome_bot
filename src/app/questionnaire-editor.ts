import type { AuthorizationContext, ConnectionScope, IncomingMessage } from '../contracts/index';
import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import { splitVkText, vkMessageLength } from '../channels/vk/outbound-text';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import { legacyQuestionnaire } from '../core/questionnaires/legacy-template';
import { chatControlStore } from '../storage/chat-control-store';
import { StorageError } from '../storage/errors';
import { questionnaireStore } from '../storage/questionnaire-store';
import type { QuestionnaireReplyResult } from '../storage/questionnaire-types';
import type { Storage } from '../storage/types';

const heading = 'Вопросы анкеты';
const sample = 'Стартовый образец анкеты\nСписок этой беседы пока не сохранён.';
const editorHeading = 'Редактор анкеты';
const instruction =
  '\n\nЧтобы изменить анкету, ответьте на это сообщение полным списком, по одному вопросу на строку.';
const continuation = '\n\nДля правки дождитесь сообщения редактора.';
const reopen = 'Откройте /вопросы изменить и ответьте на сообщение редактора полным списком.';
const edit = {
  action: 'chat.onboarding.configure',
  minimumRole: 'admin',
  journalLabel: 'Действие с вопросами анкеты',
} as const;

function looksLikeEditor(text: string | undefined) {
  return (
    !!text &&
    (text.startsWith(heading + '\n') ||
      text.startsWith(sample) ||
      text.startsWith(editorHeading + '\n')) &&
    (text.endsWith(instruction) || text.endsWith(continuation))
  );
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
}) {
  const { storage, authorization, channel, lifecycle, signal } = options;
  const questionnaires = questionnaireStore(storage);
  const controls = chatControlStore(storage);

  function guardFor(context: AuthorizationContext, accepted: () => boolean) {
    const current = () =>
      !signal.aborted &&
      accepted() &&
      lifecycle.isAdmissionCurrent(context.scope) &&
      controls.read(context.scope).enabled;
    return {
      signal,
      isCurrent: current,
      async allow() {
        return current() && (await authorization.check(context, edit.action)).allowed && current();
      },
    };
  }

  return {
    beforePersonalCommands(message: VkIncoming) {
      if (!isVkGroupChat(message.peerId) || !message.reply) return false;
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
        !!message.replyToMessageId &&
        questionnaires.ownsPrompt(scope, message.replyToMessageId, message.userId)
      );
    },
    recognizeReply(scope: ConnectionScope, message: IncomingMessage) {
      if (!message.isGroupChat) return null;
      const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
      return receipt !== undefined &&
        (looksLikeEditor(message.botReplyText) || questionnaires.hasPrompt(scope, receipt))
        ? edit
        : null;
    },
    async show(
      context: AuthorizationContext,
      message: IncomingMessage,
      accepted: () => boolean,
      editing: boolean,
    ) {
      if (
        !message.isGroupChat ||
        message.isBot !== false ||
        message.hasForwarded ||
        message.replyAddress ||
        message.replyToMessageId
      )
        return;
      const guard = guardFor(context, accepted);
      if (!(await guard.allow())) return;
      const scope = context.scope;
      const chosen = questionnaires.current(scope);
      const revision = chosen?.ref.revision ?? 0;
      const list = (chosen?.questions ?? legacyQuestionnaire.questions).map(({ text }) => text);
      const title = chosen ? heading : sample;
      if (!editing) {
        const parts = splitVkText(
          title + '\n\n' + list.join('\n') + '\n\nДля правки отправьте /вопросы изменить.',
          vkMessageLength.value,
        );
        for (const part of parts)
          if (!(await channel.deliverGroupControl(scope, part, guard))) break;
        return;
      }
      const { display, editor } = preview(title, list);
      const stillShown = {
        ...guard,
        isCurrent: () =>
          guard.isCurrent() && (questionnaires.current(scope)?.ref.revision ?? 0) === revision,
      };
      for (const chunk of display)
        if (!(await channel.deliverGroupControl(scope, chunk, stillShown))) return;
      const receipt = await channel.deliverGroupControl(scope, editor, stillShown);
      if (receipt && stillShown.isCurrent() && (await guard.allow()))
        questionnaires.recordPrompt(scope, context.userId, revision, receipt);
    },
    async reply(context: AuthorizationContext, message: IncomingMessage, accepted: () => boolean) {
      if (
        message.isBot !== false ||
        message.hasForwarded ||
        message.replyAddress !== 'bot' ||
        !message.replyToMessageId
      )
        return;
      const guard = guardFor(context, accepted);
      if (!guard.isCurrent()) return;
      const raw = message.literalText ?? message.text;
      if (message.attachments.length || looksLikeEditor(raw)) {
        await channel.replyGroupControl(context.scope, reopen, guard);
        return;
      }
      const id = Number(message.messageId);
      if (!Number.isSafeInteger(id) || id < 1 || String(id) !== message.messageId) return;
      const result = await authorization.applyQuestionnaireReply(
        context,
        { receipt: message.replyToMessageId, eventId: id, eventAt: message.timestamp, text: raw },
        guard.isCurrent,
      );
      if (result.allowed && result.value.status === 'confirm') {
        const { before, shown, question } = result.value;
        const form = new Intl.PluralRules('ru').select(before);
        const noun = form === 'few' ? 'вопроса' : form === 'one' ? 'вопрос' : 'вопросов';
        const text = `В списке ${before} ${noun}, останется 1. Ответьте на это сообщение «Заменить» или «Оставить».`;
        const receipt = await channel.deliverGroupControl(context.scope, text, guard);
        if (receipt && (await guard.allow()))
          questionnaires.recordPrompt(context.scope, context.userId, shown, receipt, {
            editor: message.replyToMessageId,
            eventId: message.messageId,
            question,
          });
        return;
      }
      const response = result.allowed ? replyText(result.value) : null;
      if (response && guard.isCurrent())
        await channel.replyGroupControl(context.scope, response, guard);
    },
  };
}
