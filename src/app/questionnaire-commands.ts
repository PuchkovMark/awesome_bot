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
  questionnaireAccessStore,
  questionnaireMessageSequence,
  type QuestionnaireAccessDecision,
} from '../storage/questionnaire-access-store';
import type { QuestionnaireCommand } from '../storage/questionnaire-progress-store';
import {
  questionnairePresentationStore,
  type QuestionnairePresentationGrant,
} from '../storage/questionnaire-presentation-store';
import { questionnaireViewStore } from '../storage/questionnaire-view-store';
import type { Storage } from '../storage/types';
import type { PublicationGuard } from '../core/message-router/publication-service';
import { questionnaireListText } from '../core/questionnaire/text';

export const openQuestionnaire = '/анкета';
const cancelQuestionnaire = '/анкета отмена';
export function parseQuestionnaireCommand(text: string): QuestionnaireCommand | null {
  switch (text.trim()) {
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

function accessCommand(text: string): QuestionnaireAccessDecision | null {
  if (text === '/анкета открыть') return 'open';
  if (text === '/анкета закрыть') return 'closed';
  return null;
}

function accessReply(text: string): QuestionnaireAccessDecision | null {
  const choice = text.toLowerCase();
  if (choice === 'разрешить' || choice === 'да') return 'open';
  if (choice === 'закрыть' || choice === 'нет') return 'closed';
  return null;
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
const controlAccess = { ...ownCommand, action: 'profile.self.manage' } as const;

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
  const access = questionnaireAccessStore(options.storage);
  const presentations = questionnairePresentationStore(options.storage);
  const views = questionnaireViewStore(options.storage);
  function commandOf(scope: ConnectionScope, message: IncomingMessage) {
    if (message.isBot !== false || (!message.isGroupChat && message.chatId !== message.userId))
      return null;
    const text = (message.literalText ?? message.text).trim();
    const progress = parseQuestionnaireCommand(text);
    if (progress) return progress;
    const view = parseQuestionnaireView(text);
    if (view) return { view: view[1] ?? '' };
    if (text === '/анкета представить') return { present: true };
    if (!message.isGroupChat) return null;
    const direct = accessCommand(text);
    if (direct) return { access: direct };
    const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
    if (!receipt) return null;
    const viewChoice = accessReply(text);
    const presentChoice = text.toLowerCase();
    const isPresentationChoice =
      presentChoice === 'представить' || presentChoice === 'не представлять';
    if (!viewChoice && !isPresentationChoice) return null;
    if (access.hasPrompt(scope, receipt))
      return viewChoice ? { access: viewChoice, receipt } : { ignored: true };
    if (presentations.hasPrompt(scope, receipt))
      return isPresentationChoice
        ? { present: presentChoice === 'представить', receipt }
        : { ignored: true };
    return null;
  }

  async function show(
    delivery: ConnectionScope,
    message: IncomingMessage,
    args: string,
    guard: PublicationGuard,
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
    const text = view.pairs.length
      ? questionnaireListText(view.pairs, 'Анкета')
      : 'В анкете нет доступных ответов.';
    for (const part of splitVkText(text)) {
      if (!current()) return;
      const result = await channel.deliverQuestionnairePart(delivery, part, deliveryGuard);
      if (result.kind !== 'delivered') return;
    }
  }

  return {
    recognize(scope: ConnectionScope, message: IncomingMessage) {
      const command = commandOf(scope, message);
      return command
        ? typeof command !== 'string' && 'access' in command
          ? controlAccess
          : ownCommand
        : null;
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
      const changesAccess = typeof command !== 'string' && 'access' in command;
      const current = () =>
        !signal.aborted && accepted() && (changesAccess ? control().journal : control().ordinary);
      const action = changesAccess ? controlAccess.action : ownCommand.action;
      const allowed = async () =>
        current() &&
        (await authorization.check(context, action, message.userId)).allowed &&
        current();
      if (!(await allowed())) return;

      const guard = { signal, isCurrent: current, allow: allowed };
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
        const result = access.decide(scope, message.userId, command.access, event);
        if (result === 'ignored') return;
        const text =
          result === 'unavailable'
            ? 'У вас пока нет заполненной анкеты в этой беседе.'
            : command.access === 'open'
              ? 'Просмотр вашей анкеты открыт для участников этой беседы.'
              : 'Просмотр вашей анкеты закрыт.';
        const replying = () => current() && control().ordinary;
        if (replying())
          await channel.replyGroupControl(scope, text, {
            ...guard,
            isCurrent: replying,
            allow: async () => replying() && (await allowed()) && replying(),
          });
        return;
      }

      const actor = progress.participant(scope, message.userId);
      const result = actor.command(command, { sequence, at: message.timestamp }, Date.now());
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
