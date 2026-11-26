import type { ConnectionScope, IncomingMessage, UserId } from '../contracts/index';
import type { createLifecycleService } from '../core/index';
import type { createVkChannel } from '../channels/index';
import { splitVkText } from '../channels/vk/outbound-text';
import { incomingReminderCommand } from '../core/reminders/commands';
import {
  extractReminderTime,
  formatReminderTime,
  reminderTimezone,
  resolveReminderTime,
} from '../core/reminders/time';
import { chatControlStore } from '../storage/chat-control-store';
import { StorageError } from '../storage/errors';
import type { Storage } from '../storage/index';
import type { TrackPublication } from './control-publications';
import {
  reminderGraceMs,
  reminderStore,
  type ReminderDraft,
  type ReminderFields,
} from '../storage/reminder-store';

type Store = ReturnType<typeof reminderStore>;
type Reminder = ReturnType<Store['list']>[number];
type Lease = NonNullable<ReturnType<Store['claimDelivery']>>;
type Channel = ReturnType<typeof createVkChannel>;
type Lifecycle = ReturnType<typeof createLifecycleService>;

const missing = 'Напоминание не найдено.';
const closed = 'Чтобы получить напоминание, разрешите сообщения от сообщества и повторите просьбу.';
const recoveryHint = 'Проверить напоминание можно в личке по команде «Мои напоминания».';
const display = {
  delivered: 'доставлено',
  cancelled: 'отменено',
  missed: 'срок пропущен',
  unknown: 'доставка не подтверждена',
  sending: 'отправка уже началась',
} as const;
const confirmationText = {
  delivered: 'Подтверждение доставлено.',
  failed: 'Подтверждение не доставлено.',
  unknown: 'Доставка подтверждения неизвестна.',
} as const;

function confirmationParts(text: string, dueAt: number, timezone: string, copyId?: number) {
  const copy = copyId === undefined ? '' : ` Копия #${copyId}.`;
  return splitVkText(
    `Напомню вам в этой личке ${formatReminderTime(dueAt, timezone)} (${timezone}).${copy}\n${text}`,
  );
}

function fields(input: string, originAt: number, timezone?: string, edited?: Reminder) {
  const draft = edited?.draft;
  const forContent = draft?.needs === 'text';
  const timeInput = forContent ? '' : input.trim();
  const parsed = extractReminderTime(
    /^\d{1,2}:\d{2}(?:\s|$)/u.test(timeInput) ? 'в ' + timeInput : timeInput,
  );
  const choice = /^(?:первый|второй)$/iu.exec(timeInput)?.[0]?.toLowerCase();
  const suppliedZone = parsed.explicitTimezone ?? (reminderTimezone(timeInput) || undefined);
  const explicitTimezone = suppliedZone ?? draft?.explicitTimezone;
  const date = parsed.date ?? draft?.date;
  const found = parsed.schedule ?? draft?.schedule;
  const schedule = found?.kind === 'local' && date ? { ...found, date } : found;
  const chosenAt = forContent
    ? draft.chosenAt
    : choice && draft?.choices
      ? draft.choices[choice === 'первый' ? 0 : 1]
      : undefined;
  const resolved =
    chosenAt !== undefined && explicitTimezone
      ? { kind: 'scheduled' as const, dueAt: chosenAt, timezone: explicitTimezone }
      : resolveReminderTime({ originAt, schedule, explicitTimezone, timezone });
  const text = edited?.draft?.needs === 'text' ? input.trim() : (edited?.text ?? parsed.content);
  function clarify(
    needs: ReminderDraft['needs'],
    overrides: Partial<ReminderDraft> = {},
  ): ReminderFields {
    return { draft: { needs, date, schedule, explicitTimezone, ...overrides }, text };
  }
  if (parsed.ambiguous)
    return clarify('time', { schedule: undefined, timeExample: parsed.timeExample });
  if (resolved.kind === 'overlap')
    return clarify('overlap', { choices: resolved.choices, explicitTimezone: resolved.timezone });
  if (resolved.kind !== 'scheduled') return clarify(resolved.kind);
  if (resolved.dueAt <= Date.now())
    return clarify('time', { schedule: undefined, date: undefined });
  if (!text.trim())
    return clarify('text', { chosenAt: resolved.dueAt, explicitTimezone: resolved.timezone });
  const { dueAt, timezone: selected } = resolved;
  return {
    dueAt,
    timezone: selected,
    text,
    scheduleKey:
      schedule?.kind === 'relative'
        ? `relative:${schedule.minutes}`
        : `calendar:${dueAt}:${selected}`,
    confirmation: () => confirmationParts(text, dueAt, selected),
  };
}

function prompt(item: Reminder, proposedZone: string | undefined) {
  const lead = `Для напоминания #${item.id} `;
  const command = `«уточни напоминание #${item.id}`;
  switch (item.draft?.needs) {
    case 'zone':
      return (
        lead +
        `укажите часовой пояс, например ${command} Europe/Moscow».\n` +
        (proposedZone ? `Часовой пояс беседы — ${proposedZone}. Можно выбрать его.` : '')
      ).trim();
    case 'overlap': {
      const choices = item.draft.choices!;
      return (
        lead +
        `выберите один из двух моментов. Отправьте ${command} первый» (${formatReminderTime(choices[0], 'UTC')} UTC) ` +
        `или ${command} второй» (${formatReminderTime(choices[1], 'UTC')} UTC).`
      );
    }
    case 'skipped':
      return (
        lead +
        `укажите другое время. Этот местный час пропущен при переводе часов. Например, ${command} 03:30».`
      );
    case 'text':
      return lead + `укажите, о чём напомнить. Например, ${command} взять документы».`;
    case 'time':
      if (item.draft.timeExample)
        return (
          lead +
          `выберите один срок и укажите его полностью. Например, ${command} ${item.draft.timeExample}».`
        );
      if (item.draft.date && !item.draft.schedule)
        return lead + `укажите точное время по выбранной дате. Например, ${command} 18:00».`;
      return lead + `укажите точное время в будущем. Например, ${command} завтра в 18:00».`;
    default:
      return missing;
  }
}

function dueLabel(item: Reminder) {
  if (item.dueAt !== null && item.timezone !== null)
    return `${formatReminderTime(item.dueAt, item.timezone)} (${item.timezone})`;
}

function summary(item: Reminder, now: number) {
  const prefix = `#${item.id}`;
  if (item.state === 'draft') return `${prefix} · ожидается уточнение`;
  const parts = [prefix];
  const due = dueLabel(item);
  if (due) parts.push(due);
  parts.push(
    item.state === 'pending'
      ? item.deliveryUnknown
        ? display.unknown
        : item.deliveryStarted
          ? display.sending
          : item.text!
      : display[item.state],
  );
  if (item.state === 'pending' && !item.deliveryStarted) {
    parts.push(confirmationText[item.confirmation]);
    const lines = [parts.join(' · ')];
    const action = confirmationAction(item);
    if (action) lines.push(action);
    if (item.dueAt! > now) lines.push('Копия на тот же срок.', `Создать ещё одно #${item.id}`);
    return lines.join('\n');
  }
  return parts.join(' · ');
}

function confirmationAction(item: Reminder) {
  if (item.confirmation === 'failed') return `Повтори подтверждение #${item.id}`;
  if (item.confirmation === 'unknown') return `Проверь напоминание #${item.id}`;
}

function recoveryStatus(item: Reminder | undefined) {
  if (!item) return missing;
  if (item.state !== 'pending' || item.deliveryStarted) return summary(item, Date.now());
  return `Напоминание #${item.id} назначено на ${dueLabel(item)}. ${confirmationText[item.confirmation]}`;
}

export function createReminderHandlers(options: {
  readonly storage: Storage;
  readonly channel: Channel;
  readonly lifecycle: Lifecycle;
  readonly signal: AbortSignal;
  readonly track: TrackPublication;
}) {
  const { storage, channel, lifecycle, signal } = options;
  const store = reminderStore(storage);
  const controls = chatControlStore(storage);

  async function recipient(userId: UserId, isCurrent: () => boolean) {
    const endpoint = channel.reminderDelivery(userId);
    if (!(await endpoint.canWrite({ signal, isCurrent })) || !isCurrent()) return undefined;
    try {
      return { userId, scope: lifecycle.admissionScope(userId) };
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'stale_scope') return undefined;
    }
    const verified = await lifecycle.verify(userId);
    return verified.scope && isCurrent()
      ? { userId, scope: lifecycle.admissionScope(userId) }
      : undefined;
  }

  async function deliver(lease: Lease, scope: ConnectionScope, originCurrent: () => boolean) {
    const endpoint = channel.reminderDelivery(scope.chatId);
    const isCurrent = () =>
      !signal.aborted &&
      scope.generation === lease.generation &&
      originCurrent() &&
      lifecycle.isAdmissionCurrent(scope);
    for (;;) {
      const part = store.getPart(lease, Date.now());
      if (!part) return;
      const guard = { signal, isCurrent };
      let outcome;
      if (part.state === 'ready') {
        outcome = await endpoint.publish(
          part.text,
          part.send_id,
          (receipt) => store.receipt(lease, part, receipt),
          { ...guard, beforeSend: () => isCurrent() && store.beginPart(lease, part, Date.now()) },
          lease.stage === 'delivery'
            ? Math.min(lease.leaseUntil, lease.dueAt + reminderGraceMs + 1)
            : lease.leaseUntil,
        );
      } else if (
        part.receipt &&
        part.attempted_at !== null &&
        (await endpoint.confirm(part.text, part.receipt, part.attempted_at, guard))
      ) {
        outcome = 'delivered' as const;
      } else {
        outcome = 'unknown' as const;
      }
      if (!store.settle(lease, part, outcome, Date.now())) return outcome;
    }
  }

  return Object.freeze({
    recognize(message: IncomingMessage) {
      const command = incomingReminderCommand(message);
      return command
        ? ({
            action: 'reminder.manage',
            minimumRole: 'member',
            replayRequest:
              command.kind === 'create' || command.kind === 'clarify' || command.kind === 'copy',
          } as const)
        : null;
    },
    async execute(
      scope: ConnectionScope,
      event: IncomingMessage,
      current: () => boolean,
      replayOnly?: boolean,
    ) {
      const command = incomingReminderCommand(event);
      if (!command) return;
      function isCurrent() {
        if (signal.aborted || !current()) return false;
        try {
          const state = controls.read(scope);
          return state.enabled && state.mode !== 'silent';
        } catch {
          return false;
        }
      }
      if (!isCurrent()) return;
      const target = event.isGroupChat
        ? await recipient(event.userId, isCurrent)
        : (await channel.reminderDelivery(event.userId).canWrite({ signal, isCurrent }))
          ? { scope, userId: event.userId }
          : undefined;
      if (!isCurrent()) return;
      if (!target) {
        if (event.isGroupChat && !replayOnly)
          options.track(
            channel.replyGroupControl(scope, closed, {
              signal,
              isCurrent,
              allow: async () => isCurrent(),
            }),
          );
        return;
      }
      const recipientCurrent = () => isCurrent() && lifecycle.isAdmissionCurrent(target.scope);
      const privateGuard = {
        signal,
        isCurrent: recipientCurrent,
        allow: async () => recipientCurrent(),
      };
      const reply = (text: string) =>
        options.track(channel.replyPrivateControl(target.userId, text, privateGuard));
      const now = Date.now();
      if (command.kind === 'cancel-options') {
        const items = store.list(target, now, 'cancellable');
        const choices = items.map((item) => {
          const text = Array.from(
            item.text?.replace(/\s+/gu, ' ').trim() || 'поручение пока не указано',
          );
          const description = text.length > 120 ? text.slice(0, 120).join('') + '…' : text.join('');
          return (
            (dueLabel(item) ?? 'Черновик') + ' · ' + description + '\nОтмени напоминание ' + item.id
          );
        });
        reply(choices.join('\n\n') || 'Сейчас нечего отменять.');
        return;
      }
      if (command.kind === 'list') {
        const items = store.list(target, now);
        reply(
          items.length
            ? items.map((item) => summary(item, now)).join('\n\n')
            : 'Напоминаний пока нет.',
        );
        return;
      }
      if (command.kind === 'retry-confirmation') {
        const lease = store.claimConfirmation(target, command.id, now, true);
        if (!lease) {
          reply(recoveryStatus(store.inspectConfirmation(target, command.id, now)?.item));
          return;
        }
        options.track(
          deliver(lease, target.scope, recipientCurrent).then((outcome) => {
            if (outcome !== 'delivered' && recipientCurrent())
              reply(
                recoveryStatus(store.inspectConfirmation(target, command.id, Date.now())?.item),
              );
          }),
        );
        return;
      }
      if (command.kind === 'check-confirmation') {
        const inspected = store.inspectConfirmation(target, command.id, now);
        if (!inspected?.parts.length) {
          reply(recoveryStatus(inspected?.item));
          return;
        }
        const id = command.id;
        const endpoint = channel.reminderDelivery(target.userId);
        options.track(
          (async () => {
            for (const part of inspected.parts) {
              if (!recipientCurrent()) return;
              const found = await endpoint.confirm(
                part.text,
                part.receipt,
                part.attempted_at,
                privateGuard,
              );
              if (!recipientCurrent()) return;
              if (found) store.confirmObservedPart(target, id, part, Date.now());
            }
            reply(recoveryStatus(store.inspectConfirmation(target, id, Date.now())?.item));
          })(),
        );
        return;
      }
      if (command.kind === 'cancel') {
        const state = store.cancel(target, command.id, now);
        reply(state === 'missing' ? missing : `#${command.id} · ${display[state]}`);
        return;
      }
      if (command.kind === 'timezone') {
        const zone = command.input ? reminderTimezone(command.input) : store.timezone(target);
        if (zone && command.input) store.timezone(target, zone);
        reply(
          zone
            ? `Ваш часовой пояс напоминаний — ${zone}.`
            : 'Укажите часовой пояс, например /пояс-напоминаний Europe/Moscow.',
        );
        return;
      }
      const origin = { scope, messageId: event.messageId, originAt: event.timestamp };
      let item: Reminder | null | undefined;
      if (replayOnly) {
        item = store.replay(target, origin, now);
        if (item?.state !== 'draft') return;
      } else if (command.kind === 'create') {
        const assignment = store.create(
          target,
          origin,
          fields(command.input, event.timestamp, store.timezone(target)),
          now,
        );
        if (!assignment) return;
        if (assignment.kind === 'choose') {
          const candidates = assignment.items.map(({ id }) => `#${id}`).join(', ');
          reply(
            `С этой просьбой могут совпадать напоминания ${candidates}. Откройте «Мои напоминания» и выберите нужное по номеру.`,
          );
          return;
        }
        item = assignment.item;
        if (assignment.kind === 'existing' && item.state !== 'draft') {
          const action =
            item.state === 'pending' && !item.deliveryStarted && confirmationAction(item);
          reply(recoveryStatus(item) + (action ? '\n' + action : ''));
          return;
        }
      } else if (command.kind === 'copy') {
        const copy = store.copy(target, origin, command.id, Date.now, confirmationParts);
        if (!copy) {
          reply(missing);
          return;
        }
        if (copy.kind === 'replayed') return;
        item = copy.item;
        if (copy.kind === 'unavailable') {
          const next = copy.deadlineReached
            ? '\nДля нового напоминания отправьте просьбу с новым сроком.'
            : '';
          reply(recoveryStatus(item) + next);
          return;
        }
      } else {
        const drafts = store.list(target, now).filter(({ state }) => state === 'draft');
        const selected =
          command.id === undefined
            ? drafts.length === 1
              ? drafts[0]
              : undefined
            : drafts.find(({ id }) => id === command.id);
        if (!selected) {
          reply(
            command.id === undefined && drafts.length > 1
              ? `Укажите номер черновика: ${drafts.map(({ id }) => '#' + id).join(', ')}.`
              : missing,
          );
          return;
        }
        item = store.revise(
          target,
          origin,
          selected.id,
          fields(command.input, selected.originAt, store.timezone(target), selected),
          now,
        );
      }
      if (!item || !isCurrent()) return;
      if (item.state === 'draft') {
        const proposed = event.isGroupChat ? controls.read(scope).timezone : undefined;
        reply(prompt(item, proposed));
        return;
      }
      if (item.state === 'pending') {
        const lease = store.claimConfirmation(target, item.id, Date.now());
        if (lease)
          options.track(
            deliver(lease, target.scope, recipientCurrent).then(async (outcome) => {
              if (
                event.isGroupChat &&
                (outcome === 'failed' || outcome === 'unknown') &&
                recipientCurrent() &&
                store.claimRecoveryHint(target, origin, lease.id)
              )
                await channel.replyGroupControl(scope, recoveryHint, {
                  signal,
                  isCurrent: recipientCurrent,
                  allow: async () => recipientCurrent(),
                });
            }),
          );
      }
    },
    async due() {
      const lease = store.claimDelivery(Date.now(), (text, late) =>
        splitVkText((late ? 'Напоминание с опозданием.\n' : 'Напоминание.\n') + text),
      );
      if (!lease) return false;
      let scope: ConnectionScope;
      try {
        scope = lifecycle.admissionScope(lease.chatId);
      } catch {
        const part = store.getPart(lease, Date.now());
        if (part)
          store.settle(lease, part, part.state === 'ready' ? 'failed' : 'unknown', Date.now());
        return true;
      }
      await deliver(lease, scope, () => true);
      return true;
    },
  });
}
