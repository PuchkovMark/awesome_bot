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
import { questionnaireManagementStore } from '../storage/questionnaire-management-store';
import {
  isQuestionnaireManagementPrompt,
  questionnaireDeletionPrompt,
  questionnaireEditorParts,
} from './questionnaire-management';
import { pendingControlPrompts, type TrackPublication } from './control-publications';
import { questionnaireViewStore } from '../storage/questionnaire-view-store';
import { questionnaireStore } from '../storage/questionnaire-store';
import type { Storage } from '../storage/types';
import type { PublicationGuard } from '../core/message-router/publication-service';
import {
  completedQuestionnaireActions,
  privateQuestionnaireHint,
  questionnaireListText,
  questionnairePresentationQuestion,
} from '../core/questionnaire/text';

export const openQuestionnaire = '/анкета';
const cancelQuestionnaire = '/анкета отмена';
export function isQuestionnaireQuestions(message: IncomingMessage) {
  return (
    message.isGroupChat &&
    !message.hasOtherAddress &&
    /^\/анкета\s+вопросы$/iu.test(message.text.trim())
  );
}

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
const readQuestions = {
  action: 'commands.read',
  minimumRole: 'member',
  journalLabel: 'Просмотр вопросов анкеты',
} as const;
const questionList = { questions: true } as const;

const instructions =
  'Ваш ответ увидят участники этой беседы. Ответьте одним сообщением, любые вопросы можно пропустить. Обратитесь к боту по имени, упомяните его или ответьте на его сообщение.';
const showingAnswer = { showingAnswer: true } as const;
const status = {
  active: 'Анкета открыта. Пришлите ответы одним сообщением.',
  paused: 'Анкета на паузе. Чтобы продолжить, отправьте /анкета.',
  dispatching:
    'Доставка вопросов пока не подтверждена. Чтобы начать показ заново, поставьте анкету на паузу и откройте её снова.',
  processing: 'Ответ обрабатывается.',
  completed: 'Вы уже заполнили анкету.',
  cancelled: 'Заполнение анкеты отменено.',
  idle: 'У вас нет открытой анкеты в этом чате.',
  unconfigured: 'Вопросы не настроены. Администратор может задать их командой /вопросы изменить.',
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
  readonly track: TrackPublication;
  readonly signal: AbortSignal;
}) {
  const { channel, progress, authorization, lifecycle, signal } = options;
  const controls = chatControlStore(options.storage);
  const templates = questionnaireStore(options.storage);
  const legacyPrompts = legacyQuestionnairePrompts(options.storage);
  const management = questionnaireManagementStore(options.storage);
  const prompts = pendingControlPrompts();
  const questionLists = pendingControlPrompts();
  const views = questionnaireViewStore(options.storage);
  function commandOf(scope: ConnectionScope, message: IncomingMessage) {
    if (message.isBot !== false || (!message.isGroupChat && message.chatId !== message.userId))
      return null;
    const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
    if (message.isGroupChat && receipt && prompts.has(scope, message))
      return { managementReply: receipt };
    if (isQuestionnaireQuestions(message)) return questionList;
    const raw = message.text.trim();
    const text =
      raw.startsWith('/') &&
      (!message.hasOtherAddress || /^\/анкета\s+показать(?:\s|$)/iu.test(raw))
        ? raw
        : (message.literalText ?? message.text).trim();
    if (
      /^\/анкета\s+представить$/iu.test(text) ||
      (receipt &&
        (message.botReplyText === questionnairePresentationQuestion ||
          legacyPrompts.hasPrompt(scope, receipt)))
    )
      return { ignored: true };
    const progress = parseQuestionnaireCommand(text);
    if (progress) return progress;
    const view = parseQuestionnaireView(text);
    if (view) return { view: view[1] ?? '' };
    if (receipt && questionLists.owns(scope, message)) return showingAnswer;
    if (!message.isGroupChat) return null;
    if (/^\/анкета\s+изменить$/iu.test(text)) return { manage: 'edit' as const };
    if (/^\/анкета\s+удалить$/iu.test(text)) return { manage: 'delete' as const };
    if (!receipt) return null;
    if (
      management.hasPrompt(scope, receipt) ||
      isQuestionnaireManagementPrompt(message.botReplyText)
    )
      return { managementReply: receipt };
    return null;
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
      if (ownActions && message.isGroupChat) text += '\n\n' + completedQuestionnaireActions;
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
      if (command && typeof command !== 'string' && 'questions' in command) return readQuestions;
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
      const current = () => accepted() && control().ordinary;
      const viewingQuestions = typeof command !== 'string' && 'questions' in command;
      const allowed = async () =>
        current() &&
        (viewingQuestions
          ? await authorization.check(context, readQuestions.action)
          : await authorization.check(context, ownCommand.action, message.userId)
        ).allowed &&
        current();
      if (!(await allowed())) return;

      const guard = { signal, isCurrent: current, allow: allowed };
      if (viewingQuestions) {
        const list = templates.current(scope);
        if (list)
          options.track(
            channel.replyGroupControl(
              scope,
              'Вопросы анкеты\n\n' + list.questions.map(({ text }) => text).join('\n'),
              guard,
            ),
          );
        return;
      }
      if (typeof command !== 'string' && 'showingAnswer' in command) {
        options.track(
          message.isGroupChat
            ? channel.replyGroupControl(scope, status.dispatching, guard)
            : channel.replyPrivateControl(message.userId, status.dispatching, guard),
        );
        return;
      }
      if (typeof command !== 'string' && 'manage' in command) {
        const form = management.open(
          scope,
          message.userId,
          sequence,
          message.timestamp,
          Date.now(),
        );
        if (form === null)
          options.track(channel.replyGroupControl(scope, 'Анкета не заполнена', guard));
        if (!form) return;
        const currentForm = () =>
          current() && management.current(scope, message.userId, form.attempt, Date.now());
        const deliveryGuard = {
          ...guard,
          isCurrent: currentForm,
          allow: async () => currentForm() && (await allowed()) && currentForm(),
        };
        const parts =
          command.manage === 'edit'
            ? questionnaireEditorParts(form.template.questions)
            : [
                {
                  text: questionnaireDeletionPrompt,
                  first: 0,
                  last: 0,
                },
              ];
        options.track(
          (async () => {
            for (const part of parts) {
              if (!currentForm()) return;
              const remembered = await prompts.send(
                scope,
                message.userId,
                part.text,
                async (receivedId) => {
                  const sent = await channel.deliverQuestionnairePart(scope, part.text, {
                    ...deliveryGuard,
                    receivedId,
                  });
                  return (
                    sent.kind === 'delivered' &&
                    currentForm() &&
                    management.remember(
                      scope,
                      message.userId,
                      form.attempt,
                      sent.receipt,
                      part.first,
                      part.last,
                      Date.now(),
                      command.manage,
                    )
                  );
                },
              );
              if (!remembered) return;
            }
          })(),
        );
        return;
      }
      if (typeof command !== 'string' && 'managementReply' in command) {
        if (message.replyAddress !== 'bot' || message.replyToMessageId !== command.managementReply)
          return;
        const receipt = questionnaireMessageSequence(command.managementReply);
        if (receipt === null) return;
        const apply = async () => {
          if (!(await allowed())) return;
          const result = management.reply(
            scope,
            message.userId,
            receipt,
            sequence,
            message.literalText ?? message.text,
            message.timestamp,
            Date.now(),
          );
          if (result) options.track(channel.replyGroupControl(scope, result, guard));
        };
        const waiting = prompts.defer(scope, message, apply);
        if (waiting) options.track(waiting);
        else await apply();
        return;
      }
      if (typeof command !== 'string' && 'view' in command) {
        options.track(show(scope, message, command.view, guard));
        return;
      }
      if (typeof command !== 'string') return;
      if (!message.isGroupChat) {
        options.track(channel.replyPrivateControl(message.userId, privateQuestionnaireHint, guard));
        return;
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
          options.track(
            message.isGroupChat
              ? channel.replyGroupControl(scope, text, guard)
              : channel.replyPrivateControl(message.userId, text, guard),
          );
        }
        return;
      }

      if (signal.aborted) return;
      const presentation = result.presentation;
      const work = actor.takePresentation(Date.now(), presentation);
      if (!work) return;
      const together = instructions + '\n\n' + work.text;
      const separate = Buffer.byteLength(together) > vkMessageLength.value;
      const presenting = () =>
        !signal.aborted && current() && actor.presenting(presentation, Date.now());
      const deliveryGuard = {
        ...guard,
        isCurrent: presenting,
        allow: async () => presenting() && (await allowed()) && presenting(),
      };
      async function deliver(
        stage: 'warning' | 'questions',
        text: string,
        receivedId?: (id: string) => void,
      ) {
        const sent = await channel.deliverQuestionnairePart(scope, text, {
          ...deliveryGuard,
          ...(receivedId ? { receivedId } : {}),
        });
        if (sent.kind === 'delivered')
          return actor.confirmPresentation(
            presentation,
            stage,
            sent.receipt,
            Date.now(),
            () => !signal.aborted && current(),
          );
        if (sent.kind === 'failed') {
          // Возврат в показ проверяет поколение и идентификатор показа после смены ревизии.
          const attemptScope = lifecycle.current(scope.chatId);
          if (attemptScope.generation === scope.generation)
            progress.participant(attemptScope, message.userId).deliveryFailed(presentation);
        }
        return false;
      }
      options.track(
        (async () => {
          let questions = separate ? work.text : together;
          if (separate && !work.warningDelivered) {
            if (!(await deliver('warning', instructions)) || !current()) return;
            const listing = actor.takePresentation(Date.now(), presentation);
            if (!listing) return;
            questions = listing.text;
          }
          await questionLists.send(scope, message.userId, questions, (receivedId) =>
            deliver('questions', questions, receivedId),
          );
        })(),
      );
    },
  };
}
