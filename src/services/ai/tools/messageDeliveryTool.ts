import { logger } from '../../../logger/index.js';
import { MAX_VK_MESSAGE_LENGTH } from '../../splitter/splitterService.js';
import { matchesVkPersonName } from '../../vk/vkMention.js';
import type { AITool } from '../AIProvider.js';
import {
  LOOKUP_PAGE_SIZE,
  MAX_LOOKUP_PAGES,
  matchesParticipant,
  participantId,
  participantPage,
  type Participant,
} from './vkInfoTool.js';

export type MessageReplyOptions = {
  replyTo?: number;
  conversationMessageId?: number;
};

type QuotedMessage = MessageReplyOptions & { peerId: number };
type ToolAccess = { allowed: true } | { allowed: false; message: string };
type DeliveryResult = { status: 'result' | 'uncertain'; message: string };

export type MessageDeliveryContext = {
  peerId: number;
  senderId: string;
  isChat: boolean;
  currentMessage: MessageReplyOptions;
  quotedMessage?: QuotedMessage;
  checkAccess: () => Promise<ToolAccess>;
  beginAction: () => string | null;
  getAnchorMessageId: () => Promise<number | undefined>;
  getMembers: (offset: number, count: number) => Promise<unknown>;
  getMessages: (ids: number[]) => Promise<unknown>;
  deliver: (text: string, options: MessageReplyOptions) => Promise<DeliveryResult>;
  now?: () => number;
};

const modes = [
  'reply_to_current',
  'reply_to_quoted',
  'reply_to_member',
  'mention_member',
  'send',
] as const;
const RECENT_MESSAGE_LIMIT = 20;
const RECENT_MESSAGE_MAX_AGE_MS = 30 * 60_000;

export class AiMessageDeliveryGuard {
  private attempted = false;

  get hasAttempted(): boolean {
    return this.attempted;
  }

  async attempt<T>(send: () => Promise<T>): Promise<T> {
    if (this.attempted) throw new Error('An AI message delivery was already attempted');
    this.attempted = true;
    return send();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function replyOptions(message: MessageReplyOptions): MessageReplyOptions | undefined {
  if (positiveInteger(message.conversationMessageId)) {
    return { conversationMessageId: message.conversationMessageId };
  }
  if (positiveInteger(message.replyTo)) return { replyTo: message.replyTo };
  return undefined;
}

function hasRawMention(text: string): boolean {
  return (
    /\[(?:id|club|public)\d+\|[^\]]*\]/iu.test(text) ||
    /(?<![\p{L}\p{N}_@])@[a-z\d_.]+/iu.test(text)
  );
}

type MemberLookup =
  { status: 'found'; member: Participant } | { status: 'ambiguous' | 'not_found' | 'incomplete' };

async function findMember(
  context: MessageDeliveryContext,
  reference: string,
): Promise<MemberLookup> {
  const id = participantId(reference);
  if (id === null || (id !== undefined && id <= 0)) return { status: 'not_found' };

  const exactMatches = new Map<number, Participant>();
  const inflectedMatches = new Map<number, Participant>();
  const seen = new Set<number>();
  let offset = 0;
  let expectedCount: number | undefined;
  let missingProfiles = false;

  for (let pageNumber = 0; pageNumber < MAX_LOOKUP_PAGES; pageNumber += 1) {
    const page = participantPage(await context.getMembers(offset, LOOKUP_PAGE_SIZE));
    if (
      page.items.length > LOOKUP_PAGE_SIZE ||
      offset + page.items.length > page.count ||
      (expectedCount !== undefined && page.count !== expectedCount) ||
      (page.items.length === 0 && offset < page.count)
    ) {
      throw new Error('VK returned an incomplete participant list');
    }
    expectedCount = page.count;
    for (const member of page.items) {
      if (seen.has(member.id)) throw new Error('VK returned duplicate participants');
      seen.add(member.id);
      if (member.type !== 'user') continue;
      if (!member.first_name) missingProfiles = true;
      if (id !== undefined) {
        if (member.id === id) return { status: 'found', member };
      } else if (matchesParticipant(member, reference)) {
        exactMatches.set(member.id, member);
      } else if (
        member.first_name &&
        matchesVkPersonName(member.first_name, member.last_name ?? '', reference)
      ) {
        inflectedMatches.set(member.id, member);
      }
    }
    if (exactMatches.size > 1) return { status: 'ambiguous' };
    offset += page.items.length;
    if (offset >= page.count) {
      if (id === undefined && missingProfiles) return { status: 'incomplete' };
      const matches = exactMatches.size > 0 ? exactMatches : inflectedMatches;
      if (matches.size > 1) return { status: 'ambiguous' };
      const member = matches.values().next().value;
      return member ? { status: 'found', member } : { status: 'not_found' };
    }
  }
  return { status: 'incomplete' };
}

function memberMention(member: Participant): string {
  const label =
    (member.name ?? member.first_name ?? 'участник')
      .replace(/[\]|\r\n]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 120) || 'участник';
  return `[id${member.id}|${label}]`;
}

async function findRecentMessage(
  context: MessageDeliveryContext,
  memberId: number,
): Promise<{ id?: number; unavailable: boolean }> {
  try {
    const anchor = await context.getAnchorMessageId();
    if (!positiveInteger(anchor)) throw new Error('Current VK message ID is unavailable');
    const count = Math.min(RECENT_MESSAGE_LIMIT, anchor - 1);
    if (count === 0) return { unavailable: false };
    const ids = Array.from({ length: count }, (_, index) => anchor - index - 1);
    const requested = new Set(ids);
    const page = await context.getMessages(ids);
    if (!isRecord(page) || !Array.isArray(page.items)) {
      throw new Error('VK returned an invalid recent message batch');
    }
    const seen = new Set<number>();
    let newest: number | undefined;
    const now = (context.now ?? Date.now)();
    for (const message of page.items) {
      if (
        !isRecord(message) ||
        message.peer_id !== context.peerId ||
        !positiveInteger(message.conversation_message_id) ||
        !requested.has(message.conversation_message_id) ||
        seen.has(message.conversation_message_id) ||
        typeof message.from_id !== 'number' ||
        !Number.isSafeInteger(message.from_id) ||
        typeof message.date !== 'number' ||
        !Number.isSafeInteger(message.date) ||
        message.date < 0
      ) {
        throw new Error('VK returned an invalid recent message');
      }
      seen.add(message.conversation_message_id);
      if (
        message.from_id === memberId &&
        message.is_hidden !== true &&
        message.is_hidden !== 1 &&
        message.date * 1000 >= now - RECENT_MESSAGE_MAX_AGE_MS &&
        message.date * 1000 <= now + 60_000 &&
        (newest === undefined || message.conversation_message_id > newest)
      ) {
        newest = message.conversation_message_id;
      }
    }
    return { id: newest, unavailable: false };
  } catch (error) {
    logger.warn(
      {
        peerId: context.peerId,
        senderId: context.senderId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Unable to inspect recent VK messages; the participant will be mentioned instead',
    );
    return { unavailable: true };
  }
}

/**
 * Отправляет одно сообщение только в текущий диалог и проверяет адресата через VK.
 */
export function createMessageDeliveryTool(context: MessageDeliveryContext): AITool {
  let attempted = false;
  let ambiguousMember = false;
  const reportResolutionProblem = async (
    message: string,
    status: 'clarification_requested' | 'error',
  ): Promise<string> => {
    const access = await context.checkAccess();
    if (!access.allowed) return JSON.stringify({ status: 'not_executed', message: access.message });
    const actionError = context.beginAction();
    if (actionError) return JSON.stringify({ status: 'not_executed', message: actionError });
    attempted = true;
    const result = await context.deliver(message, replyOptions(context.currentMessage) ?? {});
    return JSON.stringify(
      result.status === 'uncertain'
        ? result
        : { status, message: 'Уведомление об адресате отправлено в текущий диалог.' },
    );
  };
  return {
    name: 'send_vk_message',
    description: [
      'Отправь одно сообщение только в текущий диалог. После отправки приложение не отправит твой итоговый текст повторно.',
      'При обычном обращении по имени или ответе на сообщение бота используй reply_to_current: ответ пойдёт на текущее сообщение.',
      'reply_to_quoted — ответить на сообщение, процитированное автором; send — отдельное сообщение без ответа.',
      'Для просьбы передать слова участнику используй reply_to_member: приложение найдёт участника и ответит на его недавнее сообщение либо отметит его в отдельном сообщении.',
      'mention_member всегда отмечает участника отдельно. Для этих режимов укажи recipient: имя в именительном падеже, полное имя или VK-упоминание.',
      'Текст должен быть окончательным, без VK-упоминаний и повторного обращения по имени: приложение добавит отметку само, если потребуется. При неоднозначности не угадывай и попроси уточнить адресата.',
      'После чтения полной истории или сведений VK действие недоступно; для поиска адресата сразу вызывай этот инструмент.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: modes },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_VK_MESSAGE_LENGTH,
          description: 'Готовый текст сообщения без VK-упоминаний.',
        },
        recipient: {
          type: 'string',
          maxLength: 200,
          description: 'Только для reply_to_member или mention_member: участник текущей беседы.',
        },
      },
      required: ['mode', 'text'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== 'mode' && key !== 'text' && key !== 'recipient') ||
        typeof input.mode !== 'string' ||
        !modes.some((mode) => mode === input.mode) ||
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > MAX_VK_MESSAGE_LENGTH ||
        hasRawMention(input.text) ||
        (input.mode === 'reply_to_member' || input.mode === 'mention_member'
          ? typeof input.recipient !== 'string' ||
            !input.recipient.trim() ||
            input.recipient.length > 200
          : input.recipient !== undefined)
      ) {
        logger.warn(
          { peerId: context.peerId, senderId: context.senderId },
          'Invalid AI message delivery request',
        );
        return JSON.stringify({
          status: 'not_executed',
          message:
            'Укажите режим и непустой текст до 4000 символов без упоминаний; адресата передавайте только в recipient.',
        });
      }
      const senderId = Number(context.senderId);
      if (
        !positiveInteger(senderId) ||
        !positiveInteger(context.peerId) ||
        (context.isChat ? context.peerId <= 2_000_000_000 : context.peerId !== senderId)
      ) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'Не удалось определить текущий диалог VK.',
        });
      }
      if (attempted) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'Отправка уже была начата; не повторяй её.',
        });
      }
      if (ambiguousMember) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'Адресат не определён однозначно. Дождись уточнения пользователя.',
        });
      }

      const access = await context.checkAccess();
      if (!access.allowed)
        return JSON.stringify({ status: 'not_executed', message: access.message });

      let text = input.text.trim();
      let options: MessageReplyOptions = {};
      let delivery = input.mode;
      let recentUnavailable = false;
      if (input.mode === 'reply_to_current') {
        const reply = replyOptions(context.currentMessage);
        if (!reply) {
          return JSON.stringify({
            status: 'not_executed',
            message: 'VK не предоставил идентификатор текущего сообщения для ответа.',
          });
        }
        options = reply;
      } else if (input.mode === 'reply_to_quoted') {
        const quoted = context.quotedMessage;
        const reply = quoted?.peerId === context.peerId ? replyOptions(quoted) : undefined;
        if (!reply) {
          return JSON.stringify({
            status: 'not_executed',
            message: 'Нет доступного цитируемого сообщения в текущем диалоге.',
          });
        }
        options = reply;
      } else if (input.mode === 'reply_to_member' || input.mode === 'mention_member') {
        if (!context.isChat) {
          return JSON.stringify({
            status: 'not_executed',
            message: 'Обращение к другому участнику доступно только в текущей групповой беседе.',
          });
        }
        if (typeof input.recipient !== 'string') throw new Error('Validated recipient is missing');
        let lookup: MemberLookup;
        try {
          lookup = await findMember(context, input.recipient.trim());
        } catch (error) {
          logger.warn(
            {
              peerId: context.peerId,
              senderId: context.senderId,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            },
            'Unable to verify an AI message recipient',
          );
          ambiguousMember = true;
          return reportResolutionProblem(
            'Не удалось проверить участников беседы в VK; сообщение адресату не отправлено.',
            'error',
          );
        }
        if (lookup.status === 'ambiguous') {
          ambiguousMember = true;
          return reportResolutionProblem(
            'В беседе несколько участников с таким именем. Уточните полное имя или VK-упоминание.',
            'clarification_requested',
          );
        }
        if (lookup.status !== 'found') {
          ambiguousMember = true;
          return reportResolutionProblem(
            lookup.status === 'incomplete'
              ? 'Не удалось полностью проверить участников VK. Укажите VK-упоминание адресата.'
              : 'Участник не найден в текущей беседе. Уточните имя или VK-упоминание.',
            'clarification_requested',
          );
        }
        if (input.mode === 'reply_to_member') {
          const recent = await findRecentMessage(context, lookup.member.id);
          recentUnavailable = recent.unavailable;
          if (recent.id) options = { conversationMessageId: recent.id };
          else {
            delivery = 'mention_member';
            text = `${memberMention(lookup.member)} ${text}`;
          }
        } else {
          text = `${memberMention(lookup.member)} ${text}`;
        }
      }

      const finalAccess = await context.checkAccess();
      if (!finalAccess.allowed) {
        return JSON.stringify({ status: 'not_executed', message: finalAccess.message });
      }
      const actionError = context.beginAction();
      if (actionError) return JSON.stringify({ status: 'not_executed', message: actionError });
      attempted = true;
      const result = await context.deliver(text, options);
      return JSON.stringify({
        ...result,
        delivery,
        ...(recentUnavailable
          ? { limitation: 'Недавние сообщения проверить не удалось; использовано упоминание.' }
          : {}),
      });
    },
  };
}
