import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { cleanHistoryText } from '../memory/historyText.js';

export type HistorySnapshotRequest = {
  conversationId: string;
  from: Date;
  to: Date;
  count?: number;
  participantUserIds?: string[];
  includeBot?: boolean;
};

export type HistorySnapshot = {
  ids: string[];
  conversationId: string;
};

function hasVoiceAttachment(attachments: string | null): boolean {
  try {
    const value: unknown = attachments ? JSON.parse(attachments) : [];
    return Array.isArray(value) && value.includes('audio_message');
  } catch {
    return false;
  }
}

export async function createHistorySnapshot(
  request: HistorySnapshotRequest,
): Promise<HistorySnapshot> {
  const userIds = request.participantUserIds ?? [];
  const roles: Prisma.MessageWhereInput =
    userIds.length === 0 && !request.includeBot
      ? { role: { in: ['user', 'assistant'] } }
      : {
          OR: [
            ...(userIds.length ? [{ role: 'user', userId: { in: userIds } }] : []),
            ...(request.includeBot ? [{ role: 'assistant' }] : []),
          ],
        };
  const range = { gte: request.from, lt: request.to };
  const rows = await prisma.message.findMany({
    where: {
      conversationId: request.conversationId,
      AND: [roles, { OR: [{ sentAt: range }, { sentAt: null, createdAt: range }] }],
    },
    select: { id: true, sentAt: true, createdAt: true },
  });
  rows.sort(
    (a, b) =>
      (a.sentAt ?? a.createdAt).getTime() - (b.sentAt ?? b.createdAt).getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const selected = request.count === undefined ? rows : rows.slice(-request.count);
  return { conversationId: request.conversationId, ids: selected.map((row) => row.id) };
}

export async function readHistorySnapshotPage(snapshot: HistorySnapshot, ids: readonly string[]) {
  const rows = await prisma.message.findMany({
    where: { conversationId: snapshot.conversationId, id: { in: [...ids] } },
    include: { user: { select: { vkId: true, displayName: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const replyIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.replyToConversationMessageId === null ? [] : [row.replyToConversationMessageId],
      ),
    ),
  ];
  const replies = replyIds.length
    ? await prisma.message.findMany({
        where: { conversationId: snapshot.conversationId, conversationMessageId: { in: replyIds } },
        select: {
          id: true,
          conversationMessageId: true,
          content: true,
          authorName: true,
          attachments: true,
        },
      })
    : [];
  const snapshotIds = new Set(snapshot.ids);
  const repliesById = new Map(
    replies
      .filter((reply) => snapshotIds.has(reply.id))
      .map((reply) => [reply.conversationMessageId, reply]),
  );
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) return { id, missing: true as const };
    const reply = repliesById.get(row.replyToConversationMessageId);
    const replyContent =
      row.replyToText ?? (reply && !hasVoiceAttachment(reply.attachments) ? reply.content : '');
    return {
      id,
      missing: false as const,
      text: hasVoiceAttachment(row.attachments) ? '' : cleanHistoryText(row.content),
      replyText: replyContent ? cleanHistoryText(replyContent) : '',
      replyId: row.replyToConversationMessageId,
      replyAuthor: row.replyToAuthorName ?? reply?.authorName ?? null,
      messageId: row.conversationMessageId,
      author: row.authorName ?? row.user?.displayName ?? row.user?.vkId ?? 'Участник',
      time: row.sentAt ?? row.createdAt,
      approximateTime: row.sentAt === null,
    };
  });
}
