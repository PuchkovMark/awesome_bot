import type {
  Attachment,
  ChatId,
  IncomingMessage,
  KnownBoolean,
  MembershipEvent,
} from '../../contracts/index';

const chatPeerStart = 2_000_000_000;
const attachmentKinds = new Set([
  'audio',
  'audio_message',
  'call',
  'doc',
  'gift',
  'graffiti',
  'link',
  'market',
  'market_album',
  'photo',
  'poll',
  'sticker',
  'story',
  'video',
  'wall',
  'wall_reply',
]);
const membershipActions = new Set([
  'chat_invite_user',
  'chat_invite_user_by_link',
  'chat_invite_user_by_message_request',
  'chat_kick_user',
]);

export interface VkReply {
  readonly cmid: number;
  readonly authorId: number | undefined;
  readonly date: number | undefined;
  readonly text?: string;
}

export interface VkIncoming {
  readonly peerId: number;
  readonly authorId: number;
  readonly cmid: number;
  readonly timestamp: number;
  readonly text: string;
  readonly literalText?: string;
  readonly isMentioned: boolean;
  readonly soleBotMention?: boolean;
  readonly hasOtherAddress?: boolean;
  readonly hasReply?: boolean;
  readonly hasForwarded?: boolean;
  readonly attachments: readonly Attachment[];
  readonly reply: VkReply | undefined;
}

type ParseResult =
  | { readonly kind: 'message'; readonly message: VkIncoming }
  | {
      readonly kind: 'membership';
      readonly chatId: ChatId;
      readonly event: MembershipEvent | undefined;
      readonly affectsConnection: boolean;
      readonly signalKey: string | undefined;
    }
  | { readonly kind: 'ignored' | 'invalid' };

export interface VkEnrichment {
  readonly authorName?: string;
  readonly isAdmin?: KnownBoolean;
  readonly isBot?: KnownBoolean;
  readonly verifiedReply?: Pick<VkReply, 'cmid' | 'authorId'> & { readonly text?: string };
}

export function vkRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function vkId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0
    ? value
    : undefined;
}

export function vkCmid(value: unknown): number | undefined {
  const id = vkId(value);
  return id !== undefined && id > 0 ? id : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isSafeInteger(value * 1000)
    ? value * 1000
    : undefined;
}

export function isVkGroupChat(peerId: number): boolean {
  return peerId >= chatPeerStart;
}

export function isVkGroupChatId(chatId: string): boolean {
  if (!chatId.startsWith('vk:')) return false;
  const id = vkId(Number(chatId.slice(3)));
  return id !== undefined && chatId === `vk:${id}` && isVkGroupChat(id);
}

export function vkChatId(peerId: number): `vk:${number}` {
  return `vk:${peerId}`;
}

export function vkMentionCommand(literal: string, groupId: number): string | undefined {
  const leading = /^\s*\[(?:club|public)(\d+)\|[^[\]\r\n]+\]\s*,?\s*(\/[\s\S]*)$/u.exec(literal);
  return leading && Number(leading[1]) === groupId ? leading[2] : undefined;
}

function parseReply(value: unknown): VkReply | undefined {
  const row = vkRecord(value);
  const cmid = vkCmid(row?.conversation_message_id);
  if (!row || !cmid) return undefined;
  return {
    cmid,
    authorId: vkId(row.from_id),
    date: toTimestamp(row.date),
    ...(typeof row.text === 'string' ? { text: row.text } : {}),
  };
}

function parseAttachments(value: unknown): readonly Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((attachment) => {
    const type = vkRecord(attachment)?.type;
    return { kind: typeof type === 'string' && attachmentKinds.has(type) ? type : 'unknown' };
  });
}

function membershipChange(
  type: string,
  actor: number | undefined,
  subject: number | undefined,
): MembershipEvent['change'] {
  switch (type) {
    case 'chat_invite_user':
      return 'invited';
    case 'chat_invite_user_by_link':
      return 'joined';
    case 'chat_kick_user':
      if (actor === undefined || subject === undefined) return 'unknown';
      return actor === subject ? 'left' : 'removed';
    default:
      return 'unknown';
  }
}

function parseMembership(
  row: Record<string, unknown>,
  action: Record<string, unknown>,
  type: string,
  peerId: number,
  groupId: number,
  platformEventId: unknown,
): ParseResult {
  const actor = vkId(row.from_id);
  const subject =
    vkId(action.member_id) ?? (type === 'chat_invite_user_by_link' ? actor : undefined);
  const affectsConnection = subject === -groupId;
  const timestamp = toTimestamp(row.date);
  if (timestamp === undefined && !affectsConnection) return { kind: 'invalid' };

  const chatId = vkChatId(peerId);
  const cmid = vkCmid(row.conversation_message_id);
  const eventId =
    typeof platformEventId === 'string' && platformEventId.trim()
      ? platformEventId
      : cmid?.toString();
  return {
    kind: 'membership',
    chatId,
    affectsConnection,
    // Локальный номер идентифицирует служебное сообщение в пределах беседы.
    signalKey: cmid === undefined ? undefined : String(cmid),
    event:
      timestamp === undefined
        ? undefined
        : {
            kind: 'membership',
            chatId,
            timestamp,
            ...(eventId === undefined ? {} : { eventId }),
            subjectId: subject === undefined ? null : `vk:${subject}`,
            actorId: actor === undefined ? null : `vk:${actor}`,
            change: membershipChange(type, actor, subject),
          },
  };
}

export function parseVkIncoming(update: unknown, groupId: number): ParseResult {
  const event = vkRecord(update);
  if (!event || typeof event.type !== 'string') return { kind: 'invalid' };
  if (event.type !== 'message_new' || event.group_id !== groupId) return { kind: 'ignored' };
  const row = vkRecord(vkRecord(event.object)?.message);
  if (!row) return { kind: 'invalid' };
  const peerId = vkId(row.peer_id);
  const action = vkRecord(row.action);
  if (action && typeof action.type === 'string' && membershipActions.has(action.type)) {
    if (peerId === undefined) return { kind: 'invalid' };
    if (isVkGroupChat(peerId))
      return parseMembership(row, action, action.type, peerId, groupId, event.event_id);
  }
  if (row.out === 1 || row.out === true || row.action != null) return { kind: 'ignored' };

  const authorId = vkId(row.from_id);
  const cmid = vkCmid(row.conversation_message_id);
  const timestamp = toTimestamp(row.date);
  if (
    !peerId ||
    !authorId ||
    !cmid ||
    timestamp === undefined ||
    typeof row.text !== 'string' ||
    (row.out !== undefined && row.out !== 0 && row.out !== false)
  )
    return { kind: 'invalid' };

  const recipients = new Set<number>();
  const firstText = row.text.search(/\S/u);
  // Для slash-команды адресацию отдельно проверяет vkMentionCommand по исходному тексту.
  const withoutMention = row.text.replace(
    /\[(id|club|public)([0-9]+)\|[^[\]\r\n]+\]([^\S\r\n]*,(?!\s*\/))?/gu,
    (match: string, type: string, id: string, comma: string | undefined, offset: number) => {
      const recipient = vkId(Number(id) * (type === 'id' ? 1 : -1));
      if (recipient === undefined) return match;
      recipients.add(recipient);
      if (recipient !== -groupId) return match;
      return offset === firstText ? '' : (comma ?? '');
    },
  );
  const isMentioned = recipients.has(-groupId);
  const reply = parseReply(row.reply_message);
  const forwarded = row.fwd_messages;
  const hasForwarded = forwarded != null && (!Array.isArray(forwarded) || forwarded.length > 0);
  return {
    kind: 'message',
    message: {
      peerId,
      authorId,
      cmid,
      timestamp,
      isMentioned,
      soleBotMention: isMentioned && recipients.size === 1,
      ...(recipients.size > Number(isMentioned) ? { hasOtherAddress: true } : {}),
      ...(row.reply_message !== undefined ? { hasReply: true } : {}),
      ...(hasForwarded ? { hasForwarded: true } : {}),
      text: isMentioned ? withoutMention.trim() : row.text,
      ...(isMentioned ? { literalText: row.text } : {}),
      attachments: parseAttachments(row.attachments),
      reply: reply && reply.cmid < cmid ? reply : undefined,
    },
  };
}

export function normalizeVkIncoming(
  message: VkIncoming,
  groupId: number,
  enrichment: VkEnrichment = {},
): IncomingMessage {
  const reply =
    enrichment.verifiedReply?.cmid === message.reply?.cmid ? enrichment.verifiedReply : undefined;
  const botQuote = reply ?? message.reply;
  return {
    kind: 'message',
    chatId: vkChatId(message.peerId),
    userId: `vk:${message.authorId}`,
    authorName: enrichment.authorName ?? '',
    isGroupChat: isVkGroupChat(message.peerId),
    isAdmin: enrichment.isAdmin ?? 'unknown',
    isBot: enrichment.isBot ?? (message.authorId < 0 ? true : 'unknown'),
    text: message.text,
    ...(message.literalText === undefined ? {} : { literalText: message.literalText }),
    messageId: String(message.cmid),
    ...(reply
      ? { replyToMessageId: String(reply.cmid) }
      : message.reply
        ? { unverifiedReplyToMessageId: String(message.reply.cmid) }
        : {}),
    isReplyToBot: reply?.authorId === -groupId,
    ...(botQuote?.authorId === -groupId && botQuote.text !== undefined
      ? { botReplyText: botQuote.text }
      : {}),
    ...(message.hasReply || message.reply
      ? {
          replyAddress:
            reply?.authorId === undefined
              ? 'unknown'
              : reply.authorId === -groupId
                ? 'bot'
                : 'other',
        }
      : {}),
    isMentioned: message.isMentioned,
    ...(message.soleBotMention === undefined ? {} : { soleBotMention: message.soleBotMention }),
    ...(message.hasOtherAddress ? { hasOtherAddress: true } : {}),
    ...(message.hasForwarded ? { hasForwarded: true } : {}),
    timestamp: message.timestamp,
    attachments: message.attachments,
  };
}
