import { StorageError } from '../storage/errors';
import type { createAuthorizationService } from '../core/authorization/service';
import type { Storage } from '../storage/index';
import { disclosureStore } from '../storage/chat-disclosure-store';
import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import type { createLifecycleService } from '../core/lifecycle/service';
import type { createChatOnboarding } from '../core/chat-onboarding/service';
import type { personalDataStore } from '../storage/personal-data-store';

const personalRequest =
  /^\/(мои-данные|отключить-профиль|удалить-мои-данные|статус-удаления)(?:\s+(vk:[1-9]\d*))?$/iu;
export function groupPersonalCommand(message: import('../contracts/index').IncomingMessage) {
  return message.isGroupChat &&
    message.isBot === false &&
    !message.replyToMessageId &&
    personalRequest.test(message.text.trim())
    ? ({ action: 'profile.self.manage', minimumRole: 'member' } as const)
    : null;
}

export function createPersonalCommands(options: {
  ownerId: import('../contracts/index').UserId;
  storage: Storage;
  authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  privacy: ReturnType<typeof personalDataStore>;
  channel: Pick<
    ReturnType<typeof createVkChannel>,
    'replyPrivateControl' | 'privateControlDelivery' | 'replyGroupControl' | 'sendPersonalFile'
  >;
  lifecycle: ReturnType<typeof createLifecycleService>;
  onboarding: ReturnType<typeof createChatOnboarding>;
  signal: AbortSignal;
}) {
  const { privacy, channel, lifecycle, onboarding, signal } = options;
  return function personalCommand(
    message: Pick<VkIncoming, 'authorId' | 'peerId' | 'text' | 'cmid' | 'reply' | 'hasForwarded'>,
    current: () => boolean,
  ): Promise<void> | undefined {
    const direct =
      message.peerId === message.authorId &&
      message.authorId > 0 &&
      !isVkGroupChat(message.authorId);
    if (message.authorId <= 0 || (!direct && !isVkGroupChat(message.peerId))) return;
    const sender = vkChatId(message.authorId);
    const match =
      !message.reply && !message.hasForwarded && personalRequest.exec(message.text.trim());
    const confirmation =
      direct &&
      !message.reply &&
      !message.hasForwarded &&
      /^\/подтверждаю-удаление ([a-f0-9]{24})$/u.exec(message.text.trim());
    const review =
      direct &&
      message.authorId > 0 &&
      sender === options.ownerId &&
      !message.reply &&
      !message.hasForwarded &&
      /^\/(спорные-записи|оставить-запись|удалить-запись) (vk:[1-9]\d*)(?: ([1-9]\d*))?$/u.exec(
        message.text.trim(),
      );
    const report =
      direct &&
      !message.reply &&
      !message.hasForwarded &&
      /^\/сообщить-упоминание (vk:[1-9]\d*) ([1-9]\d*)$/u.exec(message.text.trim());
    const edit =
      direct &&
      !message.reply &&
      !message.hasForwarded &&
      /^\/текст-уведомления ([\s\S]+)$/u.exec(message.text.trim());
    if (!match && !confirmation && !review && !report && !edit) return;
    return (async () => {
      let privateScope;
      if (direct && (edit || onboarding.configuredForProfiles())) {
        try {
          privateScope = lifecycle.admissionScope(sender);
        } catch (error) {
          if (error instanceof StorageError && error.code === 'stale_scope') {
            const verified = await lifecycle.verify(sender);
            if (verified.scope && current()) privateScope = lifecycle.admissionScope(sender);
          }
        }
        if (privateScope && onboarding.privatePending(privateScope))
          await onboarding.notifyPrivate(privateScope, current);
      }
      if (edit && current()) {
        if (!privateScope || sender !== options.ownerId) return;
        const scope = privateScope;
        await options.storage.chats.create(scope, {
          createdAt: Date.now(),
          responseMode: 'normal',
          enabled: true,
        });
        const ctx = options.authorization.context({ scope, userId: sender, kind: 'owner' });
        const allowed = await options.authorization.check(ctx, 'consent.edit');
        const store = disclosureStore(options.storage),
          version = store.latest();
        if (!current() || !allowed.allowed || !version || !lifecycle.isAdmissionCurrent(scope))
          return;
        const { provider, dataPolicy, storagePolicy, detailsText, detailsUrl, ownerContact } =
          version;
        const next = store.register(
          {
            provider,
            dataPolicy,
            storagePolicy,
            detailsText,
            detailsUrl,
            ownerContact,
            profileNotice: edit[1]!,
            change: 'material',
          },
          Date.now(),
        );
        await channel.replyPrivateControl(sender, 'Сохранена версия уведомления ' + next, {
          signal,
          isCurrent: current,
          allow: async () => current(),
        });
        return;
      }
      if ((review || report) && current()) {
        const target = (review ? review[2] : report && report[1]) as `vk:${number}`;
        const scope = lifecycle.admissionScope(target);
        const guard = {
          signal,
          isCurrent: current,
          allow: async () => current() && lifecycle.isAdmissionCurrent(scope),
        };
        if (!(await guard.allow())) return;
        if (report) {
          if (privacy.hasData(scope, sender)) privacy.reportMessage(scope, sender, report[2]!);
          await channel.replyPrivateControl(
            sender,
            'Запрос по указанному сообщению обработан.',
            guard,
          );
          return;
        }
        if (review) {
          if (review[1] === 'спорные-записи') {
            const ids = privacy.disputed(scope).map((r) => r.messageId);
            await channel.replyPrivateControl(
              sender,
              ids.length ? 'Сообщения на разбор: ' + ids.join(', ') : 'Спорных записей нет.',
              guard,
            );
          } else if (review[3]) {
            const done = privacy.resolveDisputed(
              scope,
              review[3],
              review[1] === 'оставить-запись' ? 'keep' : 'erase',
            );
            await channel.replyPrivateControl(
              sender,
              done ? 'Решение сохранено.' : 'Запись не найдена.',
              guard,
            );
          }
        }
        return;
      }
      if (confirmation && current() && !signal.aborted) {
        const code = confirmation[1]!;
        const target = privacy.deletionScope(sender, code);
        if (!target) return;
        const scope = lifecycle.admissionScope(target.chatId);
        const isCurrent = () => current() && !signal.aborted && lifecycle.isAdmissionCurrent(scope);
        if (scope.generation !== target.generation || !isCurrent()) return;
        const accepted = privacy.confirmDeletion(scope, sender, code, Date.now());
        await channel.replyPrivateControl(
          sender,
          accepted
            ? 'Удаление принято. Данные скрыты. Статус: /статус-удаления ' + scope.chatId
            : 'Подтверждение истекло или уже использовано.',
          { signal, isCurrent, allow: async () => isCurrent() },
        );
        return;
      }
      if (!match || !current() || signal.aborted) return;
      if (!direct && match[2] && match[2] !== vkChatId(message.peerId)) {
        const source = lifecycle.admissionScope(vkChatId(message.peerId));
        const isCurrent = () =>
          current() && !signal.aborted && lifecycle.isAdmissionCurrent(source);
        await channel.replyGroupControl(
          source,
          `Для другой беседы отправьте в личку сообщества ${match[0]}`,
          { signal, isCurrent, allow: async () => isCurrent() },
        );
        return;
      }
      const target = direct ? (match[2] ?? sender) : vkChatId(message.peerId);
      if (!/^vk:[1-9]\d*$/u.test(target)) return;
      const id = Number(target.slice(3));
      if (!Number.isSafeInteger(id) || (!isVkGroupChat(id) && target !== sender)) return;
      const scope = lifecycle.admissionScope(vkChatId(id));
      const isCurrent = () => current() && !signal.aborted && lifecycle.isAdmissionCurrent(scope);
      const guard = {
        signal,
        isCurrent,
        allow: async () => isCurrent() && privacy.hasData(scope, sender),
      };
      if (!(await guard.allow())) return;
      const commandName = match[1]!.toLowerCase();
      async function guideInGroup() {
        if (!direct && isCurrent()) {
          await channel.replyGroupControl(
            scope,
            `Разрешите сообщения сообщества и отправьте в личку /${commandName} ${scope.chatId}`,
            guard,
          );
        }
      }
      async function replyOrGuide(text: string) {
        if ((await channel.privateControlDelivery(sender, text, guard)) !== 'delivered')
          await guideInGroup();
      }
      if (commandName === 'удалить-мои-данные') {
        const request = privacy.requestDeletion(
          scope,
          sender,
          `${message.peerId}/${message.cmid}`,
          Date.now(),
        );
        await replyOrGuide(
          `Удалить анкету и остальные ваши данные из «${request.title ?? scope.chatId}» (${scope.chatId})? В течение 15 минут отправьте здесь /подтверждаю-удаление ${request.code}`,
        );
        return;
      }
      if (commandName === 'статус-удаления') {
        const status = privacy.status(scope, sender, Date.now());
        await replyOrGuide(status);
        return;
      }
      if (commandName === 'отключить-профиль') {
        const until = privacy.disable(scope, sender, Date.now());
        await replyOrGuide(
          `Профилирование в ${scope.chatId} отключено. Личная выгрузка профиля доступна до ${new Date(until).toISOString()}.`,
        );
        return;
      }
      const event = `${message.peerId}/${message.cmid}`;
      if (!privacy.beginExport(scope, sender, event)) return;
      const snapshot = privacy.export(scope, sender, Date.now());
      const data = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
      const fresh = async () => {
        if (!(await guard.allow())) return false;
        try {
          const updated = privacy.export(scope, sender, Date.now());
          return (
            JSON.stringify({ ...updated, generatedAt: snapshot.generatedAt }) ===
            JSON.stringify(snapshot)
          );
        } catch {
          return false;
        }
      };
      try {
        if (await channel.sendPersonalFile(sender, data, { signal, isCurrent, allow: fresh })) {
          privacy.finishExport(scope, sender, event);
          return;
        }
      } catch {
        /* Содержимое и ответ платформы исключены из диагностики. */
      } finally {
        data.fill(0);
      }
      if (direct)
        await channel.replyPrivateControl(
          sender,
          'Доставка личной выгрузки не подтверждена.',
          guard,
        );
      else await guideInGroup();
    })();
  };
}
