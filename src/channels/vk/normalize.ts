import type { Attachment, IncomingMessage, KnownBoolean } from '../../contracts/index.js';

const chatPeerStart = 2_000_000_000;
const attachmentKinds = new Set([
  'audio', 'audio_message', 'call', 'doc', 'gift', 'graffiti', 'link', 'market', 'market_album',
  'photo', 'poll', 'sticker', 'story', 'video', 'wall', 'wall_reply',
]);
const connectionActions = new Set([
  'chat_invite_user', 'chat_invite_user_by_link', 'chat_invite_user_by_message_request', 'chat_kick_user',
]);

export interface VkReply {
  readonly cmid: number;
  readonly authorId: number | undefined;
  readonly date: number | undefined;
}

export interface VkIncoming {
  readonly peerId: number;
  readonly authorId: number;
  readonly cmid: number;
  readonly timestamp: number;
  readonly text: string;
  readonly isMentioned: boolean;
  readonly attachments: readonly Attachment[];
  readonly reply: VkReply | undefined;
}

type ParseResult =
  | { readonly kind: 'message'; readonly message: VkIncoming }
  | { readonly kind: 'connection_changed'; readonly peerId: number }
  | { readonly kind: 'ignored' | 'invalid' };

export interface VkEnrichment {
  readonly authorName?: string;
  readonly isAdmin?: KnownBoolean;
  readonly isBot?: KnownBoolean;
  readonly verifiedReply?: Pick<VkReply, 'cmid' | 'authorId'>;
}

export function vkRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function vkId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : undefined;
}

export function vkCmid(value: unknown): number | undefined {
  const id = vkId(value);
  return id !== undefined && id > 0 ? id : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000)
    ? value * 1000
    : undefined;
}

export function isVkGroupChat(peerId: number): boolean {
  return peerId >= chatPeerStart;
}

export function vkChatId(peerId: number): `vk:${number}` {
  return `vk:${peerId}`;
}

function parseReply(value: unknown): VkReply | undefined {
  const row = vkRecord(value);
  const cmid = vkCmid(row?.conversation_message_id);
  if (!row || !cmid) return undefined;
  return {
    cmid,
    authorId: vkId(row.from_id),
    date: toTimestamp(row.date),
  };
}

function parseAttachments(value: unknown): readonly Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.map(attachment => {
    const type = vkRecord(attachment)?.type;
    return { kind: typeof type === 'string' && attachmentKinds.has(type) ? type : 'unknown' };
  });
}

export function parseVkIncoming(update: unknown, groupId: number): ParseResult {
  const event = vkRecord(update);
  if (!event || typeof event.type !== 'string') return { kind: 'invalid' };
  if (event.type !== 'message_new' || event.group_id !== groupId) return { kind: 'ignored' };
  const row = vkRecord(vkRecord(event.object)?.message);
  if (!row) return { kind: 'invalid' };
  const peerId = vkId(row.peer_id);
  const action = vkRecord(row.action);
  if (peerId && isVkGroupChat(peerId) && action?.member_id === -groupId
    && typeof action.type === 'string' && connectionActions.has(action.type)) {
    return { kind: 'connection_changed', peerId };
  }
  if (row.out === 1 || row.out === true || row.action != null) return { kind: 'ignored' };

  const authorId = vkId(row.from_id);
  const cmid = vkCmid(row.conversation_message_id);
  const timestamp = toTimestamp(row.date);
  if (!peerId || !authorId || !cmid || timestamp === undefined || typeof row.text !== 'string'
    || (row.out !== undefined && row.out !== 0 && row.out !== false)) return { kind: 'invalid' };

  const mention = new RegExp(`\\[(?:club|public)${groupId}\\|[^\\[\\]\\r\\n]+\\]`, 'gu');
  const withoutMention = row.text.replace(mention, '');
  const isMentioned = withoutMention !== row.text;
  const reply = parseReply(row.reply_message);
  return { kind: 'message', message: {
    peerId, authorId, cmid, timestamp, isMentioned,
    text: isMentioned ? withoutMention.trim() : row.text,
    attachments: parseAttachments(row.attachments),
    reply: reply && reply.cmid < cmid ? reply : undefined,
  } };
}

export function normalizeVkIncoming(message: VkIncoming, groupId: number, enrichment: VkEnrichment = {}): IncomingMessage {
  const reply = enrichment.verifiedReply?.cmid === message.reply?.cmid ? enrichment.verifiedReply : undefined;
  return {
    kind: 'message',
    chatId: vkChatId(message.peerId),
    userId: `vk:${message.authorId}`,
    authorName: enrichment.authorName ?? '',
    isGroupChat: isVkGroupChat(message.peerId),
    isAdmin: enrichment.isAdmin ?? 'unknown',
    isBot: enrichment.isBot ?? (message.authorId === -groupId ? true : 'unknown'),
    text: message.text,
    messageId: String(message.cmid),
    ...(reply ? { replyToMessageId: String(reply.cmid) } : {}),
    isReplyToBot: reply?.authorId === -groupId,
    isMentioned: message.isMentioned,
    timestamp: message.timestamp,
    attachments: message.attachments,
  };
}
