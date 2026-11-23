import type { createVkChannel } from '../channels/vk/channel';
import { vkMessageLength } from '../channels/vk/outbound-text';
import type { AuthorizationContext, ConnectionScope, IncomingMessage } from '../contracts/index';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import type { createQuestionnaireProgress } from '../core/questionnaire/progress';
import { chatControlStore } from '../storage/chat-control-store';
import {
  questionnaireAccessStore,
  questionnaireMessageSequence,
  type QuestionnaireAccessDecision,
} from '../storage/questionnaire-access-store';
import type { QuestionnaireCommand } from '../storage/questionnaire-progress-store';
import type { Storage } from '../storage/types';

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
  readonly lifecycle: Pick<ReturnType<typeof createLifecycleService>, 'current'>;
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    'deliverQuestionnairePart' | 'replyGroupControl' | 'replyPrivateControl'
  >;
  readonly signal: AbortSignal;
}) {
  const { channel, progress, authorization, lifecycle, signal } = options;
  const controls = chatControlStore(options.storage);
  const access = questionnaireAccessStore(options.storage);
  function commandOf(scope: ConnectionScope, message: IncomingMessage) {
    if (message.isBot !== false || (!message.isGroupChat && message.chatId !== message.userId))
      return null;
    const text = (message.literalText ?? message.text).trim();
    const progress = parseQuestionnaireCommand(text);
    if (progress) return progress;
    if (!message.isGroupChat) return null;
    const direct = accessCommand(text);
    if (direct) return { access: direct };
    const reply = accessReply(text);
    const receipt = message.replyToMessageId ?? message.unverifiedReplyToMessageId;
    return reply && receipt && access.hasPrompt(scope, receipt) ? { access: reply, receipt } : null;
  }

  return {
    recognize(scope: ConnectionScope, message: IncomingMessage) {
      return commandOf(scope, message) ? ownCommand : null;
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
      if (typeof command !== 'string') {
        const receipt = command.receipt ? questionnaireMessageSequence(command.receipt) : null;
        if (
          command.receipt &&
          (receipt === null ||
            message.replyAddress !== 'bot' ||
            message.replyToMessageId !== command.receipt)
        )
          return;
        const result = access.decide(scope, message.userId, command.access, {
          sequence,
          at: message.timestamp,
          receipt,
        });
        if (result === 'ignored') return;
        const text =
          result === 'unavailable'
            ? 'У вас пока нет заполненной анкеты в этой беседе.'
            : command.access === 'open'
              ? 'Просмотр вашей анкеты открыт для участников этой беседы.'
              : 'Просмотр вашей анкеты закрыт.';
        await channel.replyGroupControl(scope, text, guard);
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
