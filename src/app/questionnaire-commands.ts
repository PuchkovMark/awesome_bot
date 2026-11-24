import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat } from '../channels/vk/normalize';
import { vkLocalId } from '../channels/vk/outbound';
import { splitVkText, vkMessageLength } from '../channels/vk/outbound-text';
import type {
  AuthorizationContext,
  ChatId,
  ConnectionScope,
  IncomingMessage,
} from '../contracts/index';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import type { createQuestionnaireProgress } from '../core/questionnaire/progress';
import { chatControlStore } from '../storage/chat-control-store';
import { StorageError } from '../storage/errors';
import {
  legacyQuestionnairePrompts,
  questionnaireMessageSequence,
} from '../storage/questionnaire-access-store';
import type { QuestionnaireCommand } from '../storage/questionnaire-progress-store';
import {
  questionnairePresentationStore,
  type QuestionnairePresentationGrant,
} from '../storage/questionnaire-presentation-store';
import { questionnaireManagementStore } from '../storage/questionnaire-management-store';
import { questionnaireEditorParts } from './questionnaire-management';
import { questionnaireViewStore } from '../storage/questionnaire-view-store';
import type { Storage } from '../storage/types';
import type { PublicationGuard } from '../core/message-router/publication-service';
import { questionnaireListText } from '../core/questionnaire/text';

export const openQuestionnaire = '/анкета';
const cancelQuestionnaire = '/анкета отмена';
export function parseQuestionnaireCommand(text: string): QuestionnaireCommand | null {
  switch (text.trim().toLowerCase().replace(/\s+/gu, ' ')) {
    case openQuestionnaire:
      return 'open';
    case '/анкета пауза':
      return 'pause';
    case cancelQuestionnaire:
      return 'cancel';
    default:
      return null;
  }
}

export function parseQuestionnaireView(text: string) {
  return /^\/анкета\s+показать(?:\s+([\s\S]+))?$/iu.exec(text.trim());
}

const unavailable = 'Анкета недоступна.';
const ownCommand = {
  action: 'onboarding.self.manage',
  minimumRole: 'member',
  journalLabel: 'Действие с анкетой',
} as const;

const prompt = {
  group:
    'Ваш ответ увидят участники этой беседы. Ответьте одним сообщением, любые вопросы можно пропустить. Обратитесь к боту по имени, упомяните его или ответьте на его сообщение.',
  private:
    'Пришлите ответы следующим сообщением. Любые вопросы можно пропустить. Для отмены отправьте /анкета отмена.',
};
const status = {
  active: 'Анкета открыта. Пришлите ответы одним сообщением.',
  paused: 'Анкета на паузе. Чтобы продолжить, отправьте /анкета.',
  dispatching:
    'Доставка вопросов пока не подтверждена. Чтобы начать показ заново, поставьте анкету на паузу и откройте её снова.',
  processing: 'Ответ обрабатывается.',
  completed: 'Вы уже заполнили анкету.',
  cancelled: 'Заполнение анкеты отменено.',
  idle: 'У вас нет открытой анкеты в этом чате.',
  unconfigured: 'Вопросы не настроены. Администратор может задать их через /вопросы.',
  profile_required: 'Для анкеты нужен доступный профиль в этом чате.',
  forbidden: null,
  duplicate: null,
} as const;

export function createQuestionnaireCommands(options: {
  readonly storage: Storage;
  readonly progress: ReturnType<typeof createQuestionnaireProgress>;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly lifecycle: Pick<ReturnType<typeof createLifecycleService>, 'current' | 'admissionScope'>;
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    | 'deliverQuestionnairePart'
    | 'replyGroupControl'
    | 'replyPrivateControl'
    | 'questionnaireMention'
  >;
  readonly track: (work: Promise<void>) => void;
  readonly present: (
    scope: ConnectionScope,
    grant: QuestionnairePresentationGrant,
    authorName: string,
    guard: PublicationGuard,
  ) => Promise<void>;
  readonly signal: AbortSignal;
}) {
  const { channel, progress, authorization, lifecycle, signal } = options;
  const controls = chatControlStore(options.storage);
  const legacyPrompts = legacyQuestionnairePrompts(options.storage);
  const presentations = questionnairePresentationStore(options.storage);
  const management = questionnaireManagementStore(options.storage);
  const views = questionnaireViewStore(options.storage);
  function commandOf(scope: ConnectionScope, message: IncomingMessage) {
    if (message.isBot !== false || (!message.isGroupChat && message.chatId !== message.userId))
      return null;
    const text = (message.literalText ?? message.text).trim();
    const progress = parseQuestionnaireCommand(text);
    if (progress) return progress;
    const view = parseQuestionnaireView(text);
    if (view) return { view: view[1] ?? '' };
    if (/^\/анкета\s+представить$/iu.test(text)) return { present: true };
    if (!message.isGroupChat) return null;
    if (/^\/анкета\s+изменить$/iu.test(text)) return { manage: 'edit' as const };
    const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
    if (!receipt) return null;
    if (management.hasPrompt(scope, receipt)) return { managementReply: receipt };
    if (legacyPrompts.hasPrompt(scope, receipt)) return { ignored: true };
    const presentChoice = text.toLowerCase();
    const isPresentationChoice =
      presentChoice === 'представить' || presentChoice === 'не представлять';
    if (presentations.hasPrompt(scope, receipt))
      return isPresentationChoice
        ? { present: presentChoice === 'представить', receipt }
        : { ignored: true };
    return isPresentationChoice && message.isReplyToBot ? { ignored: true } : null;
  }

  async function show(
    delivery: ConnectionScope,
    message: IncomingMessage,
    args: string,
    guard: PublicationGuard,
    ownActions = false,
  ) {
    let scope = delivery;
    const context = /^(vk:[1-9]\d*)(?:\s+([\s\S]+))?$/u.exec(args);
    if (context) {
      const chatId = context[1]! as ChatId;
      const local = vkLocalId(chatId);
      if (message.isGroupChat || local === undefined || !isVkGroupChat(local)) {
        await channel.deliverQuestionnairePart(delivery, unavailable, guard);
        return;
      }
      try {
        scope = lifecycle.admissionScope(chatId);
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        await channel.deliverQuestionnairePart(delivery, unavailable, guard);
        return;
      }
      args = context[2] ?? '';
    }
    const requester = message.userId;
    const subject = args ? channel.questionnaireMention(args) : requester;
    const read = () => {
      try {
        return subject ? views.read(scope, delivery, requester, subject, Date.now()) : null;
      } catch (error) {
        if (error instanceof StorageError) return null;
        throw error;
      }
    };
    if (!guard.isCurrent()) return;
    const view = read();
    if (!view) {
      await channel.deliverQuestionnairePart(delivery, unavailable, guard);
      return;
    }
    const current = () => guard.isCurrent() && read()?.signature === view.signature;
    const deliveryGuard = {
      ...guard,
      isCurrent: current,
      allow: async () => current() && (await guard.allow()) && current(),
    };
    let text = 'Анкета не заполнена';
    if (view.attempt !== null) {
      text = view.pairs.length
        ? questionnaireListText(view.pairs, 'Анкета')
        : 'Анкета\n\nНет публичных ответов';
      if (ownActions && message.isGroupChat)
        text += '\n\nПосмотреть — /анкета показать. Исправить ответ — /анкета изменить.';
    }
    for (const part of splitVkText(text)) {
      if (!current()) return;
      const result = await channel.deliverQuestionnairePart(delivery, part, deliveryGuard);
      if (result.kind !== 'delivered') return;
    }
  }

  return {
    recognize(scope: ConnectionScope, message: IncomingMessage) {
      const command = commandOf(scope, message);
      return command ? ownCommand : null;
    },
    async execute(
      context: AuthorizationContext,
      message: IncomingMessage,
      accepted: () => boolean,
    ) {
      const scope = context.scope;
      const command = commandOf(scope, message);
      const sequence = questionnaireMessageSequence(message.messageId);
      if (
        !command ||
        message.hasForwarded ||
        message.attachments.length ||
        context.userId !== message.userId ||
        scope.chatId !== message.chatId ||
        sequence === null
      )
        return;
      const control = controls.capture(scope);
      const current = () => !signal.aborted && accepted() && control().ordinary;
      const allowed = async () =>
        current() &&
        (await authorization.check(context, ownCommand.action, message.userId)).allowed &&
        current();
      if (!(await allowed())) return;

      const guard = { signal, isCurrent: current, allow: allowed };
      if (typeof command !== 'string' && 'manage' in command) {
        const form = management.open(
          scope,
          message.userId,
          sequence,
          message.timestamp,
          Date.now(),
        );
        if (form === null) await channel.replyGroupControl(scope, 'Анкета не заполнена', guard);
        if (!form) return;
        const currentForm = () =>
          current() && management.current(scope, message.userId, form.attempt, Date.now());
        const deliveryGuard = {
          ...guard,
          isCurrent: currentForm,
          allow: async () => currentForm() && (await allowed()) && currentForm(),
        };
        for (const part of questionnaireEditorParts(form.template.questions)) {
          if (!currentForm()) return;
          const sent = await channel.deliverQuestionnairePart(scope, part.text, deliveryGuard);
          if (
            sent.kind !== 'delivered' ||
            !currentForm() ||
            !management.remember(
              scope,
              message.userId,
              form.attempt,
              sent.receipt,
              part.first,
              part.last,
              Date.now(),
            )
          )
            return;
        }
        return;
      }
      if (typeof command !== 'string' && 'managementReply' in command) {
        if (message.replyAddress !== 'bot' || message.replyToMessageId !== command.managementReply)
          return;
        const receipt = questionnaireMessageSequence(command.managementReply);
        if (receipt === null) return;
        const result = management.reply(
          scope,
          message.userId,
          receipt,
          sequence,
          message.literalText ?? message.text,
          message.timestamp,
          Date.now(),
        );
        if (result) await channel.replyGroupControl(scope, result, guard);
        return;
      }
      if (typeof command !== 'string' && 'view' in command) {
        options.track(show(scope, message, command.view, guard));
        return;
      }
      if (typeof command !== 'string') {
        if ('ignored' in command) return;
        const receipt = command.receipt ? questionnaireMessageSequence(command.receipt) : null;
        if (
          command.receipt &&
          (receipt === null ||
            message.replyAddress !== 'bot' ||
            message.replyToMessageId !== command.receipt)
        )
          return;
        const event = { sequence, at: message.timestamp, receipt };
        if ('present' in command) {
          if (!message.isGroupChat) {
            await channel.replyPrivateControl(
              message.userId,
              'Отправьте /анкета представить в беседе с заполненной анкетой.',
              guard,
            );
            return;
          }
          const decision = presentations.decide(scope, message.userId, command.present, event);
          if (decision.kind === 'approved') {
            options.track(options.present(scope, decision.grant, message.authorName, guard));
            return;
          }
          if (decision.kind === 'declined')
            await channel.replyGroupControl(scope, 'Представление по анкете отменено.', guard);
          if (decision.kind === 'unavailable')
            await channel.replyGroupControl(
              scope,
              'У вас пока нет заполненной анкеты в этой беседе.',
              guard,
            );
          return;
        }
      }

      const actor = progress.participant(scope, message.userId);
      const result = actor.command(command, { sequence, at: message.timestamp }, Date.now());
      if (result.kind === 'completed' && command === 'open') {
        options.track(show(scope, message, '', guard, true));
        return;
      }
      if (result.kind !== 'showing') {
        const text =
          result.kind === 'active' && message.isGroupChat
            ? 'Анкета открыта. Пришлите ответы одним сообщением, адресованным боту.'
            : status[result.kind];
        if (text) {
          if (message.isGroupChat) await channel.replyGroupControl(scope, text, guard);
          else await channel.replyPrivateControl(message.userId, text, guard);
        }
        return;
      }

      const presentation = result.presentation;
      let work = actor.takePresentation(Date.now(), presentation);
      if (!work) return;
      const instructions = message.isGroupChat ? prompt.group : prompt.private;
      const together = instructions + '\n\n' + work.text;
      const separate = Buffer.byteLength(together) > vkMessageLength.value;
      const presenting = () => current() && actor.presenting(presentation, Date.now());
      const deliveryGuard = {
        ...guard,
        isCurrent: presenting,
        allow: async () => presenting() && (await allowed()) && presenting(),
      };
      async function deliver(stage: 'warning' | 'questions', text: string) {
        const sent = await channel.deliverQuestionnairePart(scope, text, deliveryGuard);
        if (sent.kind === 'delivered')
          return actor.confirmPresentation(presentation, stage, sent.receipt, Date.now(), current);
        if (sent.kind === 'failed') {
          // Возврат в показ проверяет поколение и идентификатор показа после смены ревизии.
          const attemptScope = lifecycle.current(scope.chatId);
          if (attemptScope.generation === scope.generation)
            progress.participant(attemptScope, message.userId).deliveryFailed(presentation);
        }
        return false;
      }
      if (separate && !work.warningDelivered) {
        if (!(await deliver('warning', instructions)) || !current()) return;
        work = actor.takePresentation(Date.now(), presentation);
        if (!work) return;
      }
      await deliver('questions', separate ? work.text : together);
    },
  };
}
