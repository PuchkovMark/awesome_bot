import type { createVkChannel } from '../channels/vk/channel';
import { vkMessageLength } from '../channels/vk/outbound-text';
import type { AuthorizationContext, IncomingMessage } from '../contracts/index';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import type { createQuestionnaireProgress } from '../core/questionnaire/progress';
import { chatControlStore } from '../storage/chat-control-store';
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
  function commandOf(message: IncomingMessage) {
    return message.isBot === false && (message.isGroupChat || message.chatId === message.userId)
      ? parseQuestionnaireCommand(message.literalText ?? message.text)
      : null;
  }

  return {
    recognize(message: IncomingMessage) {
      return commandOf(message) ? ownCommand : null;
    },
    async execute(
      context: AuthorizationContext,
      message: IncomingMessage,
      accepted: () => boolean,
    ) {
      const command = commandOf(message);
      const scope = context.scope;
      const sequence = Number(message.messageId);
      if (
        !command ||
        message.hasForwarded ||
        message.attachments.length ||
        context.userId !== message.userId ||
        scope.chatId !== message.chatId ||
        !Number.isSafeInteger(sequence) ||
        sequence <= 0 ||
        String(sequence) !== message.messageId
      )
        return;
      const control = controls.capture(scope);
      const current = () => !signal.aborted && accepted() && control().ordinary;
      const allowed = async () =>
        current() &&
        (await authorization.check(context, ownCommand.action, message.userId)).allowed &&
        current();
      if (!(await allowed())) return;

      const actor = progress.participant(scope, message.userId);
      const result = actor.command(command, { sequence, at: message.timestamp }, Date.now());
      const guard = { signal, isCurrent: current, allow: allowed };
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
