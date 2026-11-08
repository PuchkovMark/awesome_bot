import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { logger } from '../../logger/index.js';
import senderService, { nextRandomId } from '../sender/senderService.js';
import settingsService from '../settings/settingsService.js';
import {
  getLocalDateTime,
  getNextRecurringDate,
  isValidTimeZone,
  resolveReminderTimeZone,
  toUtcDateTime,
  type RecurrenceRule,
} from './reminderDateTime.js';
import { formatReminderDate, parseReminder, parseReminderTime } from './reminderParser.js';

const draftLifetimeMs = 30 * 60_000;
const maxDeliveryAttempts = 5;

interface ReminderContext {
  senderId: string;
  peerId: number;
  isChat: boolean;
  isBotAdmin: boolean;
  isConversationAdmin: (peerId: number, userId: number) => Promise<boolean>;
  resolveRecipient: (peerId: number, name: string) => Promise<string | null>;
}

interface ReminderDraftPayload {
  sourcePeerId: string;
  originalText: string;
  missing: string;
  isChat: boolean;
  reminderId?: string;
  groupRequested?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseRule(value: string | null): RecurrenceRule | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return undefined;
    if (parsed.type === 'interval' && typeof parsed.intervalMs === 'number') {
      return { type: 'interval', intervalMs: parsed.intervalMs };
    }
    if (
      parsed.type === 'weekly' &&
      Array.isArray(parsed.weekdays) &&
      parsed.weekdays.every((day) => typeof day === 'number')
    ) {
      return { type: 'weekly', weekdays: parsed.weekdays };
    }
    if (parsed.type === 'daily') return { type: 'daily' };
    if (parsed.type === 'monthly' && typeof parsed.day === 'number') {
      return { type: 'monthly', day: parsed.day };
    }
    if (
      parsed.type === 'yearly' &&
      typeof parsed.month === 'number' &&
      typeof parsed.day === 'number'
    ) {
      return { type: 'yearly', month: parsed.month, day: parsed.day };
    }
  } catch (error) {
    logger.error({ err: error }, 'Unable to parse reminder recurrence rule');
  }
  return undefined;
}

function looksLikeReminderRequest(text: string): boolean {
  return (
    /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:напомни|напоминай|напомнить|напоминание|не\s+забудь|не\s+забыть|мне\s+нужно\s+не\s+забыть|запланируй|напоминания)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
      text,
    ) ||
    /^\s*(?:пен(?:ё|е)к\s*[,!:—-]?\s*)?(?:завтра|послезавтра|сегодня|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|через\s+\S+)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])).*(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))\d{1,2}(?::\d{2}|\s*(?:утра|вечера|дня))(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
      text,
    )
  );
}

function confirmationText(
  content: string,
  dueAt: Date,
  timeZone: string,
  repeating: boolean,
): string {
  return `Хорошо, ${repeating ? 'буду напоминать' : 'напомню'}: «${content}» — ${formatReminderDate(dueAt, timeZone)}.`;
}

function reminderQuestion(missing: string): string {
  switch (missing) {
    case 'time':
      return 'Во сколько напомнить? Если время неоднозначно, укажи, пожалуйста, например: 10:00 или 10 утра.';
    case 'date':
      return 'На какую дату поставить напоминание?';
    case 'content':
      return 'Что именно нужно напомнить?';
    case 'recipient':
      return 'Кому именно напомнить? Отправь ссылку или VK ID участника.';
    case 'timeZone':
      return 'В каком часовом поясе поставить напоминание? Укажи часовой пояс, например Europe/Moscow.';
    default:
      return 'Уточни дату и время напоминания.';
  }
}

function isCancellation(text: string): boolean {
  return /^\s*(?:отмена|отмени|не надо|забудь|стоп)\s*[.!]?\s*$/iu.test(text);
}

function extractSearchTerms(text: string): string[] {
  return text
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length >= 3)
    .filter(
      (word) =>
        ![
          'напоминание',
          'напоминания',
          'напоминаний',
          'напоминание',
          'отмени',
          'удали',
          'перенеси',
          'перенести',
          'покажи',
          'список',
          'мои',
          'завтра',
          'сегодня',
          'напомни',
          'беседы',
        ].includes(word),
    );
}

/**
 * Создаёт и управляет личными и групповыми напоминаниями, уточняет запросы и доставляет их по расписанию.
 */
export class ReminderService {
  async shouldHandleMessage(text: string, context: ReminderContext): Promise<boolean> {
    const existingDraft = await prisma.reminderDraft.findFirst({
      where: {
        creatorVkId: context.senderId,
        conversationId: String(context.peerId),
        expiresAt: { gt: new Date() },
      },
      select: { id: true, state: true, payload: true },
    });
    if (existingDraft) {
      const payload = this.readDraftPayload(existingDraft.payload);
      if (existingDraft.state === 'creating' && payload?.missing === 'timeZone') {
        await prisma.reminderDraft.deleteMany({ where: { id: existingDraft.id } });
        return looksLikeReminderRequest(text);
      }
      return true;
    }
    return looksLikeReminderRequest(text);
  }

  async handleMessage(text: string, context: ReminderContext): Promise<boolean> {
    const trimmed = text.trim();
    const conversationId = String(context.peerId);
    const draft = await prisma.reminderDraft.findFirst({
      where: {
        creatorVkId: context.senderId,
        conversationId,
        expiresAt: { gt: new Date() },
      },
    });

    if (draft?.state === 'delivery_consent') {
      await this.handleDeliveryConsent(trimmed, draft.payload, context);
      return true;
    }

    if (draft && isCancellation(trimmed)) {
      await prisma.reminderDraft.delete({ where: { id: draft.id } });
      await senderService.send(context.peerId, 'Хорошо, отменил создание напоминания.');
      return true;
    }

    if (this.isManagementRequest(trimmed)) {
      await this.handleManagement(trimmed, context);
      return true;
    }

    const draftPayload = this.readDraftPayload(draft?.payload);
    const sourcePeerId = draftPayload?.sourcePeerId ?? conversationId;
    let originalText =
      draftPayload?.missing === 'timeZone'
        ? draftPayload.originalText
        : draftPayload
          ? `${draftPayload.originalText} ${trimmed}`
          : trimmed;
    const userSettings = await settingsService.getUserSettings(context.senderId);
    const chatSettings = await settingsService.getChatSettings(sourcePeerId);
    const isChat = draftPayload?.isChat ?? context.isChat;
    const requestedSharedScope =
      draftPayload?.groupRequested ??
      (isChat &&
        /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:всем|всех|беседе|чату|группе|для\s+всех)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
          originalText,
        ));
    let timeZone = requestedSharedScope
      ? resolveReminderTimeZone(chatSettings.timeZone, chatSettings.locationTimeZone)
      : resolveReminderTimeZone(userSettings.timeZone, userSettings.locationTimeZone);

    if (draftPayload?.missing === 'timeZone') {
      const zoneCandidate = trimmed.match(
        /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)+(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/u,
      )?.[0];
      if (zoneCandidate && isValidTimeZone(zoneCandidate)) {
        timeZone = zoneCandidate;
        if (requestedSharedScope) {
          await settingsService.setChatTimeZone(sourcePeerId, zoneCandidate);
        } else {
          await settingsService.setUserTimeZone(context.senderId, zoneCandidate);
        }
      }
    }

    if (draftPayload?.missing === 'time') {
      const answerTime = parseReminderTime(trimmed);
      if (answerTime.time && !answerTime.ambiguous) {
        const baseText = draftPayload.originalText.replace(
          /(?:(?:в|к|на)\s*\d{1,2}(?::\d{2})?(?:\s*(?:утра|утром|дня|днём|днем|вечера|вечером|ночи))?|\d{1,2}\s*(?:утра|утром|дня|днём|днем|вечера|вечером|ночи))/giu,
          ' ',
        );
        const answer = /^(?:в|к|на)(?:\s|$)/iu.test(trimmed) ? trimmed : `в ${trimmed}`;
        originalText = `${baseText} ${answer}`;
      } else {
        const dayPart = trimmed.match(/^(утра|утром|дня|днём|днем|вечера|вечером|ночи)$/iu)?.[0];
        if (dayPart) {
          originalText = draftPayload.originalText.replace(
            /((?:в|к|на)\s*\d{1,2}(?::\d{2})?)/iu,
            `$1 ${dayPart}`,
          );
        }
      }
    }

    const parsed = parseReminder(originalText, new Date(), timeZone);
    const recipientName = originalText.match(
      /(?:напомни|напомнить)\s+([А-ЯЁ][а-яё-]{2,}(?:у|е|ым|ой))/u,
    )?.[1];
    const resolvedRecipientId =
      recipientName && isChat
        ? await context.resolveRecipient(Number(sourcePeerId), recipientName)
        : undefined;
    const recipientRequested =
      Boolean(recipientName) ||
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:ему|ей|им|участнику|пользователю)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        originalText,
      );
    const recipientVkId = parsed.recipientVkId ?? resolvedRecipientId ?? undefined;
    const missing = recipientRequested && !recipientVkId ? 'recipient' : parsed.missing;

    if (missing) {
      const payload: ReminderDraftPayload = {
        sourcePeerId,
        originalText,
        missing,
        isChat,
        groupRequested: requestedSharedScope,
      };
      await this.saveDraft(context.senderId, conversationId, 'creating', payload);
      await senderService.send(context.peerId, reminderQuestion(missing));
      return true;
    }

    const content = parsed.content.replace(recipientName ?? '', '').trim();
    if (!parsed.dueAt || !content) {
      await senderService.send(
        context.peerId,
        'Не удалось определить дату, время или текст напоминания. Уточни запрос, пожалуйста.',
      );
      return true;
    }
    if (parsed.dueAt <= new Date()) {
      await senderService.send(
        context.peerId,
        'Указанное время уже прошло. Укажи, пожалуйста, будущую дату и время.',
      );
      return true;
    }
    if (parsed.recurrenceEndAt && parsed.dueAt > parsed.recurrenceEndAt) {
      await senderService.send(
        context.peerId,
        'Дата окончания повторений наступает раньше первого напоминания. Уточни расписание.',
      );
      return true;
    }
    if (content.length > 1000) {
      await senderService.send(
        context.peerId,
        'Текст напоминания слишком длинный. Сократи его до 1000 символов.',
      );
      return true;
    }

    const groupRequested = parsed.groupRequested && isChat;
    const personalTarget = recipientVkId;
    const scope = groupRequested && !personalTarget ? 'group' : 'personal';
    const deliveryPeerId = scope === 'group' ? sourcePeerId : (personalTarget ?? context.senderId);
    const reminder = await prisma.reminder.create({
      data: {
        creatorVkId: context.senderId,
        recipientVkId: personalTarget ?? context.senderId,
        sourcePeerId,
        deliveryPeerId,
        scope,
        content,
        timeZone,
        nextRunAt: parsed.dueAt,
        recurrenceRule: parsed.recurrence ? JSON.stringify(parsed.recurrence) : null,
        recurrenceEndAt: parsed.recurrenceEndAt,
        deliveryMode: scope === 'group' ? 'group' : 'private',
      },
    });
    if (draft) await prisma.reminderDraft.delete({ where: { id: draft.id } });

    const confirmation = confirmationText(
      content,
      parsed.dueAt,
      timeZone,
      Boolean(parsed.recurrence),
    );
    if (scope === 'group') {
      await senderService.send(context.peerId, confirmation);
    } else if (isChat) {
      try {
        await senderService.send(Number(context.senderId), confirmation);
      } catch (error) {
        logger.warn(
          { err: error, reminderId: reminder.id, recipientVkId: deliveryPeerId },
          'Private reminder confirmation could not be delivered',
        );
      }
      await senderService.send(
        context.peerId,
        'Личное напоминание создано. Подробности доступны только получателю.',
      );
    } else {
      await senderService.send(context.peerId, confirmation);
    }
    return true;
  }

  async processDueReminders(): Promise<void> {
    const now = new Date();
    await prisma.reminderDelivery.updateMany({
      where: { status: 'sending', lockUntil: { lte: now } },
      data: { status: 'pending', lockUntil: null },
    });

    const due = await prisma.reminder.findMany({
      where: { status: 'active', nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: 100,
    });

    for (const reminder of due) {
      const occurrenceAt = reminder.nextRunAt;
      if (!occurrenceAt) continue;
      try {
        await prisma.$transaction(async (transaction) => {
          const claimed = await transaction.reminder.updateMany({
            where: {
              id: reminder.id,
              status: 'active',
              nextRunAt: occurrenceAt,
            },
            data: { status: 'processing', nextRunAt: null },
          });
          if (claimed.count === 0) return;
          await transaction.reminderDelivery.create({
            data: {
              reminderId: reminder.id,
              occurrenceAt,
              randomId: nextRandomId(),
            },
          });
        });
      } catch (error) {
        if (isRecord(error) && error.code === 'P2002') continue;
        logger.error({ err: error, reminderId: reminder.id }, 'Failed to queue due reminder');
      }
    }

    const pending = await prisma.reminderDelivery.findMany({
      where: {
        status: 'pending',
        nextAttemptAt: { lte: now },
        reminder: { status: 'processing' },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 100,
      include: { reminder: true },
    });
    for (const delivery of pending) {
      const claimed = await prisma.reminderDelivery.updateMany({
        where: {
          id: delivery.id,
          status: 'pending',
          nextAttemptAt: { lte: new Date() },
        },
        data: {
          status: 'sending',
          attempts: { increment: 1 },
          lockUntil: new Date(Date.now() + 2 * 60_000),
        },
      });
      if (claimed.count === 0) continue;

      try {
        await senderService.send(
          Number(delivery.reminder.deliveryPeerId),
          `Напоминание: ${delivery.reminder.content}`,
          { randomId: delivery.randomId },
        );
        await prisma.$transaction(async (transaction) => {
          await transaction.reminderDelivery.update({
            where: { id: delivery.id },
            data: { status: 'sent', lockUntil: null, lastError: null },
          });
          await this.completeOccurrence(transaction, delivery.reminder, delivery.occurrenceAt);
        });
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const errorMessage = errorText(error).slice(0, 1000);
        if (attempts < maxDeliveryAttempts) {
          const delayMs = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000][attempts - 1];
          await prisma.reminderDelivery.update({
            where: { id: delivery.id },
            data: {
              status: 'pending',
              nextAttemptAt: new Date(Date.now() + delayMs),
              lockUntil: null,
              lastError: errorMessage,
            },
          });
          logger.warn(
            { err: error, reminderId: delivery.reminderId, attempt: attempts },
            'Reminder delivery failed; retry scheduled',
          );
          continue;
        }

        await prisma.$transaction(async (transaction) => {
          await transaction.reminderDelivery.update({
            where: { id: delivery.id },
            data: { status: 'failed', lockUntil: null, lastError: errorMessage },
          });
          await this.handlePermanentFailure(transaction, delivery.reminder, delivery.occurrenceAt);
        });
        const failedReminder = await prisma.reminder.findUnique({
          where: { id: delivery.reminderId },
          select: { scope: true, sourcePeerId: true, fallbackState: true, status: true },
        });
        if (
          failedReminder?.scope === 'personal' &&
          failedReminder.status === 'processing' &&
          failedReminder.fallbackState === 'pending' &&
          Number(failedReminder.sourcePeerId) > 2_000_000_000
        ) {
          try {
            await senderService.send(
              Number(failedReminder.sourcePeerId),
              'Не удалось доставить личное напоминание. Разрешить отправить его в эту беседу? Ответь «да» или «нет».',
            );
          } catch (sendError) {
            logger.warn(
              { err: sendError, reminderId: delivery.reminderId },
              'Unable to ask for consent to deliver reminder in conversation',
            );
          }
        }
        logger.error(
          { err: error, reminderId: delivery.reminderId, attempts },
          'Reminder delivery failed permanently',
        );
      }
    }

    const expiredConsentDrafts = await prisma.reminderDraft.findMany({
      where: { state: 'delivery_consent', expiresAt: { lte: new Date() } },
      select: { payload: true },
    });
    for (const expiredDraft of expiredConsentDrafts) {
      const payload = this.readDraftPayload(expiredDraft.payload);
      if (payload?.reminderId) {
        const reminder = await prisma.reminder.findUnique({
          where: { id: payload.reminderId },
          select: {
            id: true,
            status: true,
            recurrenceRule: true,
            recurrenceEndAt: true,
            nextRunAt: true,
          },
        });
        if (reminder?.status === 'processing') {
          const recurring = Boolean(parseRule(reminder.recurrenceRule));
          const hasNextOccurrence =
            recurring &&
            reminder.nextRunAt !== null &&
            (!reminder.recurrenceEndAt || reminder.nextRunAt <= reminder.recurrenceEndAt);
          await prisma.reminder.updateMany({
            where: { id: reminder.id, status: 'processing', fallbackState: 'pending' },
            data: {
              status: hasNextOccurrence ? 'active' : 'failed',
              fallbackState: 'expired',
              nextRunAt: hasNextOccurrence ? reminder.nextRunAt : null,
            },
          });
        }
      }
    }
    await prisma.reminderDraft.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  }

  private isManagementRequest(text: string): boolean {
    return /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:покажи|какие у меня|список|мои напоминания|напоминания беседы|напоминания чата|отмени напоминание|удали напоминание|перенеси напоминание|перенеси|не напоминай|больше не напоминай|приостанови напоминание|пауза напоминания|поставь на паузу|возобнови напоминание|продолжи напоминание)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
      text,
    );
  }

  private async handleManagement(text: string, context: ReminderContext): Promise<void> {
    const lower = text.toLocaleLowerCase('ru-RU');
    const wantsGroup =
      context.isChat &&
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:беседы|беседе|чата|чате|общие|этой\s+беседы|этого\s+чата)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        lower,
      );
    const wantsPersonal =
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:мои|мне|личные)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        lower,
      ) || !wantsGroup;
    const personal = wantsPersonal
      ? await prisma.reminder.findMany({
          where: {
            creatorVkId: context.senderId,
            scope: 'personal',
            status: { in: ['active', 'paused', 'failed', 'processing'] },
          },
          orderBy: { nextRunAt: 'asc' },
          take: 50,
        })
      : [];
    const group = wantsGroup
      ? await prisma.reminder.findMany({
          where: {
            sourcePeerId: String(context.peerId),
            scope: 'group',
            status: { in: ['active', 'paused', 'failed', 'processing'] },
          },
          orderBy: { nextRunAt: 'asc' },
          take: 50,
        })
      : [];

    const action = this.getManagementAction(lower);
    if (action === 'list') {
      if (personal.length === 0 && group.length === 0) {
        await senderService.send(context.peerId, 'Активных напоминаний не нашёл.');
        return;
      }
      if (personal.length > 0) {
        const privateList = this.formatReminderList(personal, 'Твои личные напоминания');
        if (context.isChat) {
          try {
            await senderService.send(Number(context.senderId), privateList);
          } catch (error) {
            logger.warn(
              { err: error, senderId: context.senderId },
              'Unable to send private reminder list',
            );
            await senderService.send(
              context.peerId,
              'Личные напоминания есть, но список не удалось отправить в личные сообщения.',
            );
          }
        } else {
          await senderService.send(context.peerId, privateList);
        }
      }
      if (group.length > 0) {
        await senderService.send(
          context.peerId,
          this.formatReminderList(group, 'Общие напоминания беседы'),
        );
      }
      return;
    }

    const candidates = [...personal, ...group].filter((reminder) =>
      this.matchesReminder(reminder.content, text),
    );
    if (candidates.length !== 1) {
      await senderService.send(
        context.peerId,
        candidates.length === 0
          ? 'Не нашёл подходящее напоминание.'
          : 'Нашлось несколько похожих напоминаний. Уточни текст, чтобы я не изменил не то.',
      );
      return;
    }
    const reminder = candidates[0];
    if (!(await this.canManageReminder(reminder, context))) {
      await senderService.send(context.peerId, 'У тебя нет прав на изменение этого напоминания.');
      return;
    }

    if (action === 'delete') {
      await prisma.$transaction([
        prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'cancelled', nextRunAt: null },
        }),
        prisma.reminderDelivery.updateMany({
          where: { reminderId: reminder.id, status: 'pending' },
          data: { status: 'cancelled', lockUntil: null },
        }),
        prisma.reminderDelivery.updateMany({
          where: { reminderId: reminder.id, status: 'failed' },
          data: { status: 'cancelled' },
        }),
      ]);
      await senderService.send(context.peerId, 'Напоминание отменено.');
      return;
    }
    if (action === 'pause' || action === 'resume') {
      const status = action === 'pause' ? 'paused' : 'active';
      if (action === 'pause') {
        const pendingDelivery = await prisma.reminderDelivery.findFirst({
          where: { reminderId: reminder.id, status: 'pending' },
          orderBy: { occurrenceAt: 'asc' },
        });
        await prisma.$transaction([
          prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              status,
              ...(!reminder.nextRunAt && pendingDelivery
                ? { nextRunAt: pendingDelivery.occurrenceAt }
                : {}),
            },
          }),
          prisma.reminderDelivery.updateMany({
            where: { reminderId: reminder.id, status: 'pending' },
            data: { status: 'cancelled', lockUntil: null },
          }),
        ]);
      } else {
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            status,
            ...(!reminder.nextRunAt ? { nextRunAt: new Date(Date.now() + 60_000) } : {}),
          },
        });
      }
      await senderService.send(
        context.peerId,
        action === 'pause' ? 'Повторение приостановлено.' : 'Напоминание возобновлено.',
      );
      return;
    }

    const zone = reminder.timeZone;
    const parsed = parseReminder(`напомни ${text}`, new Date(), zone);
    const hasExplicitDate =
      /(?:сегодня|завтра|послезавтра|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|\d{1,2}[./]\d{1,2}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|конце\s+месяца)/iu.test(
        text,
      );
    const nextRunAt =
      hasExplicitDate && parsed.dueAt
        ? parsed.dueAt
        : parsed.time
          ? toUtcDateTime(
              {
                date: reminder.nextRunAt
                  ? getLocalDateTime(reminder.nextRunAt, zone).date
                  : getLocalDateTime(new Date(), zone).date,
                time: parsed.time,
              },
              zone,
            )
          : parsed.dueAt;
    if (!nextRunAt || nextRunAt <= new Date()) {
      await senderService.send(context.peerId, 'Укажи будущие дату и время переноса.');
      return;
    }
    await prisma.$transaction([
      prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          nextRunAt,
          status: 'active',
          ...(parsed.recurrence ? { recurrenceRule: JSON.stringify(parsed.recurrence) } : {}),
        },
      }),
      prisma.reminderDelivery.updateMany({
        where: { reminderId: reminder.id, status: 'pending' },
        data: { status: 'cancelled', lockUntil: null },
      }),
    ]);
    await senderService.send(
      context.peerId,
      `Перенёс напоминание на ${formatReminderDate(nextRunAt, zone)}.`,
    );
  }

  private getManagementAction(text: string): 'list' | 'delete' | 'pause' | 'resume' | 'move' {
    if (
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:отмени|удали|не напоминай|больше не напоминай)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        text,
      )
    )
      return 'delete';
    if (
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:приостанови|пауза|поставь на паузу)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        text,
      )
    )
      return 'pause';
    if (
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:возобнови|продолжи)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        text,
      )
    )
      return 'resume';
    if (
      /(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))(?:перенеси|измени|передвинь)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        text,
      )
    )
      return 'move';
    return 'list';
  }

  private matchesReminder(content: string, request: string): boolean {
    const terms = extractSearchTerms(request);
    if (terms.length === 0) return true;
    const normalizedContent = content.toLocaleLowerCase('ru-RU').split(/\s+/u);
    const matches = terms.filter((term) =>
      normalizedContent.some((word) => word.includes(term) || term.includes(word)),
    ).length;
    return matches > 0 && matches >= Math.ceil(terms.length / 2);
  }

  private async canManageReminder(
    reminder: { creatorVkId: string; scope: string; sourcePeerId: string },
    context: ReminderContext,
  ): Promise<boolean> {
    if (reminder.scope === 'personal') return reminder.creatorVkId === context.senderId;
    if (reminder.creatorVkId === context.senderId || context.isBotAdmin) return true;
    return (
      context.isChat &&
      reminder.sourcePeerId === String(context.peerId) &&
      (await context.isConversationAdmin(context.peerId, Number(context.senderId)))
    );
  }

  private formatReminderList(
    reminders: Array<{
      content: string;
      nextRunAt: Date | null;
      timeZone: string;
      recurrenceRule: string | null;
      status: string;
    }>,
    title: string,
  ): string {
    const lines = reminders.map((reminder, index) => {
      const when = reminder.nextRunAt
        ? formatReminderDate(reminder.nextRunAt, reminder.timeZone)
        : reminder.status === 'paused'
          ? 'приостановлено'
          : 'доставка не удалась';
      const recurring = reminder.recurrenceRule ? ' (повторяется)' : '';
      return `${index + 1}. ${reminder.content} — ${when}${recurring}`;
    });
    return `${title}:\n${lines.join('\n')}`;
  }

  private async saveDraft(
    creatorVkId: string,
    conversationId: string,
    state: string,
    payload: ReminderDraftPayload,
  ): Promise<void> {
    await prisma.reminderDraft.upsert({
      where: { creatorVkId_conversationId: { creatorVkId, conversationId } },
      create: {
        creatorVkId,
        conversationId,
        state,
        payload: JSON.stringify(payload),
        expiresAt: new Date(Date.now() + draftLifetimeMs),
      },
      update: {
        state,
        payload: JSON.stringify(payload),
        expiresAt: new Date(Date.now() + draftLifetimeMs),
      },
    });
  }

  private readDraftPayload(value: string | undefined): ReminderDraftPayload | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        isRecord(parsed) &&
        typeof parsed.sourcePeerId === 'string' &&
        typeof parsed.originalText === 'string' &&
        typeof parsed.missing === 'string' &&
        typeof parsed.isChat === 'boolean' &&
        (parsed.groupRequested === undefined || typeof parsed.groupRequested === 'boolean') &&
        (parsed.reminderId === undefined || typeof parsed.reminderId === 'string')
      ) {
        return {
          sourcePeerId: parsed.sourcePeerId,
          originalText: parsed.originalText,
          missing: parsed.missing,
          isChat: parsed.isChat,
          ...(typeof parsed.groupRequested === 'boolean'
            ? { groupRequested: parsed.groupRequested }
            : {}),
          ...(typeof parsed.reminderId === 'string' ? { reminderId: parsed.reminderId } : {}),
        };
      }
    } catch (error) {
      logger.error({ err: error }, 'Unable to parse reminder draft');
    }
    return undefined;
  }

  private async handleDeliveryConsent(
    text: string,
    payload: string,
    context: ReminderContext,
  ): Promise<void> {
    const parsed = this.readDraftPayload(payload);
    if (!parsed || typeof parsed.reminderId !== 'string') {
      await senderService.send(
        context.peerId,
        'Не удалось проверить запрос о доставке. Напоминание не публиковал.',
      );
      return;
    }
    const affirmative =
      /^(?:да|согласен|разрешаю|можно|давай)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        text,
      );
    const negative =
      /^(?:нет|не согласен|не разрешаю|отмена)(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))/iu.test(
        text,
      );
    if (!affirmative && !negative) {
      await senderService.send(
        context.peerId,
        'Ответь «да», чтобы разрешить доставку в беседу, или «нет», чтобы отказаться.',
      );
      return;
    }

    const reminder = await prisma.reminder.findUnique({ where: { id: parsed.reminderId } });
    if (!reminder || reminder.creatorVkId !== context.senderId) {
      await prisma.reminderDraft.deleteMany({
        where: { creatorVkId: context.senderId, conversationId: String(context.peerId) },
      });
      await senderService.send(context.peerId, 'Напоминание больше не доступно.');
      return;
    }
    if (affirmative) {
      const failedDelivery = await prisma.reminderDelivery.findFirst({
        where: { reminderId: reminder.id, status: 'failed' },
        orderBy: { occurrenceAt: 'desc' },
      });
      if (!failedDelivery) {
        await senderService.send(
          context.peerId,
          'Не нашёл ожидающую доставки попытку. Напоминание не публиковал.',
        );
        return;
      }
      const updated = await prisma.$transaction(async (transaction) => {
        const reminderUpdate = await transaction.reminder.updateMany({
          where: {
            id: reminder.id,
            creatorVkId: context.senderId,
            status: 'processing',
            fallbackState: 'pending',
          },
          data: {
            deliveryMode: 'group',
            deliveryPeerId: reminder.sourcePeerId,
            fallbackState: 'approved',
            status: 'processing',
          },
        });
        if (reminderUpdate.count === 0) return false;
        const deliveryUpdate = await transaction.reminderDelivery.updateMany({
          where: { id: failedDelivery.id, status: 'failed' },
          data: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
            randomId: randomInt(1, 0x7fffffff),
            lastError: null,
          },
        });
        return deliveryUpdate.count > 0;
      });
      if (!updated) {
        await prisma.reminderDraft.deleteMany({
          where: { creatorVkId: context.senderId, conversationId: String(context.peerId) },
        });
        await senderService.send(context.peerId, 'Запрос на изменение доставки уже недоступен.');
        return;
      }
      await senderService.send(
        context.peerId,
        'Хорошо, после согласия напоминание будет отправлено в эту беседу.',
      );
    } else {
      const failedDelivery = await prisma.reminderDelivery.findFirst({
        where: { reminderId: reminder.id, status: 'failed' },
        orderBy: { occurrenceAt: 'desc' },
      });
      const rule = parseRule(reminder.recurrenceRule);
      const nextRunAt =
        rule && reminder.nextRunAt
          ? reminder.nextRunAt
          : rule && failedDelivery
            ? this.nextOccurrence(
                failedDelivery.occurrenceAt,
                reminder.timeZone,
                getLocalDateTime(failedDelivery.occurrenceAt, reminder.timeZone).time,
                rule,
              )
            : null;
      const endReached = Boolean(
        nextRunAt && reminder.recurrenceEndAt && nextRunAt > reminder.recurrenceEndAt,
      );
      const updated = await prisma.reminder.updateMany({
        where: {
          id: reminder.id,
          creatorVkId: context.senderId,
          status: 'processing',
          fallbackState: 'pending',
        },
        data: {
          fallbackState: 'declined',
          status: nextRunAt && !endReached ? 'active' : 'failed',
          nextRunAt: endReached ? null : nextRunAt,
        },
      });
      if (updated.count === 0) {
        await prisma.reminderDraft.deleteMany({
          where: { creatorVkId: context.senderId, conversationId: String(context.peerId) },
        });
        await senderService.send(context.peerId, 'Запрос на изменение доставки уже недоступен.');
        return;
      }
      await senderService.send(
        context.peerId,
        'Понял. Не буду публиковать напоминание в беседе; личная доставка не гарантирована.',
      );
    }
    await prisma.reminderDraft.deleteMany({
      where: { creatorVkId: context.senderId, conversationId: String(context.peerId) },
    });
  }

  private async completeOccurrence(
    transaction: Prisma.TransactionClient,
    reminder: {
      id: string;
      recurrenceRule: string | null;
      recurrenceEndAt: Date | null;
      timeZone: string;
      nextRunAt: Date | null;
    },
    occurrenceAt: Date,
  ): Promise<void> {
    const rule = parseRule(reminder.recurrenceRule);
    if (!rule) {
      await transaction.reminder.updateMany({
        where: { id: reminder.id, status: 'processing' },
        data: { status: 'completed', nextRunAt: null },
      });
      return;
    }
    const localTime = getLocalDateTime(occurrenceAt, reminder.timeZone).time;
    const nextRunAt = this.nextOccurrence(occurrenceAt, reminder.timeZone, localTime, rule);
    const finished = reminder.recurrenceEndAt && nextRunAt > reminder.recurrenceEndAt;
    await transaction.reminder.updateMany({
      where: { id: reminder.id, status: 'processing' },
      data: { status: finished ? 'completed' : 'active', nextRunAt: finished ? null : nextRunAt },
    });
  }

  private async handlePermanentFailure(
    transaction: Prisma.TransactionClient,
    reminder: {
      id: string;
      creatorVkId: string;
      sourcePeerId: string;
      scope: string;
      recurrenceRule: string | null;
      recurrenceEndAt: Date | null;
      timeZone: string;
      fallbackState: string;
    },
    occurrenceAt: Date,
  ): Promise<void> {
    const current = await transaction.reminder.findUnique({
      where: { id: reminder.id },
      select: { status: true },
    });
    if (!current || current.status !== 'processing') return;

    const rule = parseRule(reminder.recurrenceRule);
    const needsConsent =
      reminder.scope === 'personal' &&
      Number(reminder.sourcePeerId) > 2_000_000_000 &&
      reminder.fallbackState !== 'approved' &&
      reminder.fallbackState !== 'declined';
    if (needsConsent) {
      const localTime = getLocalDateTime(occurrenceAt, reminder.timeZone).time;
      const nextRunAt = rule
        ? this.nextOccurrence(occurrenceAt, reminder.timeZone, localTime, rule)
        : null;
      const nextIsAfterEnd =
        nextRunAt && reminder.recurrenceEndAt && nextRunAt > reminder.recurrenceEndAt;
      await transaction.reminder.update({
        where: { id: reminder.id },
        data: {
          status: 'processing',
          fallbackState: 'pending',
          nextRunAt: nextIsAfterEnd ? null : nextRunAt,
        },
      });
      await transaction.reminderDraft.upsert({
        where: {
          creatorVkId_conversationId: {
            creatorVkId: reminder.creatorVkId,
            conversationId: reminder.sourcePeerId,
          },
        },
        create: {
          creatorVkId: reminder.creatorVkId,
          conversationId: reminder.sourcePeerId,
          state: 'delivery_consent',
          payload: JSON.stringify({
            sourcePeerId: reminder.sourcePeerId,
            originalText: '',
            missing: '',
            isChat: true,
            reminderId: reminder.id,
          }),
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
        update: {
          state: 'delivery_consent',
          payload: JSON.stringify({
            sourcePeerId: reminder.sourcePeerId,
            originalText: '',
            missing: '',
            isChat: true,
            reminderId: reminder.id,
          }),
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      });
      return;
    }

    if (rule) {
      const localTime = getLocalDateTime(occurrenceAt, reminder.timeZone).time;
      const nextRunAt = this.nextOccurrence(occurrenceAt, reminder.timeZone, localTime, rule);
      const finished = reminder.recurrenceEndAt && nextRunAt > reminder.recurrenceEndAt;
      await transaction.reminder.update({
        where: { id: reminder.id },
        data: { status: finished ? 'completed' : 'active', nextRunAt: finished ? null : nextRunAt },
      });
      return;
    }

    await transaction.reminder.update({
      where: { id: reminder.id },
      data: { status: 'failed', nextRunAt: null },
    });
  }

  private nextOccurrence(
    occurrenceAt: Date,
    timeZone: string,
    time: string,
    rule: RecurrenceRule,
  ): Date {
    if (rule.type !== 'interval') {
      return getNextRecurringDate(new Date(), timeZone, time, rule);
    }
    let next = occurrenceAt.getTime() + rule.intervalMs;
    const now = Date.now();
    if (next <= now) next += (Math.floor((now - next) / rule.intervalMs) + 1) * rule.intervalMs;
    return new Date(next);
  }
}

const reminderService = new ReminderService();
export default reminderService;
