import { historyBounds } from './history-retention-store';
import type { SyncStore } from './legacy-types';
import type { Connection } from './connection';
import type { MessageInput, MessageStore, StoredMessage } from './legacy-types';
import { compositeId, object, requireInput, string, timestamp } from './validation';

const fields = [
  'chatId',
  'messageId',
  'userId',
  'authorName',
  'role',
  'text',
  'replyToMessageId',
  'timestamp',
  'attachmentCount',
  'isGroupChat',
  'senderBot',
];
export function validateMessage(message: MessageInput): void {
  object(message, fields);
  compositeId(message.chatId);
  compositeId(message.userId);
  requireInput(
    message.chatId.slice(0, message.chatId.indexOf(':')) ===
      message.userId.slice(0, message.userId.indexOf(':')),
  );
  string(message.messageId, true);
  string(message.authorName);
  string(message.text);
  requireInput(message.role === 'user' || message.role === 'assistant');
  if (message.isGroupChat !== undefined) requireInput(typeof message.isGroupChat === 'boolean');
  if (message.senderBot !== undefined)
    requireInput([true, false, 'unknown'].includes(message.senderBot));
  timestamp(message.timestamp);
  if (message.attachmentCount !== undefined && message.attachmentCount !== null)
    requireInput(Number.isSafeInteger(message.attachmentCount) && message.attachmentCount >= 0);
  if ('replyToMessageId' in message) string(message.replyToMessageId, true);
}
const columns = `id, chat_id AS chatId, platform_message_id AS messageId,
  user_id AS userId, author_name AS authorName, role, text,
  reply_to_message_id AS replyToMessageId, timestamp, purpose, attachment_count AS attachmentCount`;
type MessageRow = Omit<StoredMessage, 'replyToMessageId'> & { replyToMessageId: string | null };
function fromRow(row: MessageRow): StoredMessage {
  const { replyToMessageId, ...message } = row;
  return replyToMessageId === null ? message : { ...message, replyToMessageId };
}

function assignAuthorNumber(db: import('better-sqlite3').Database, message: MessageInput) {
  db.prepare(
    `INSERT INTO chat_author_labels(chat_id,generation,user_id,author_number)
    SELECT c.chat_id,c.generation,@userId,(
      SELECT coalesce(max(a.author_number),0)+1 FROM chat_author_labels a
      WHERE a.chat_id=c.chat_id AND a.generation=c.generation
    )
    FROM chat_connections c WHERE c.chat_id=@chatId AND NOT EXISTS (
      SELECT 1 FROM chat_author_labels a
      WHERE a.chat_id=c.chat_id AND a.generation=c.generation AND a.user_id=@userId
    )`,
  ).run({ chatId: message.chatId, userId: message.userId });
}

export function createMessageStore(
  connection: Connection,
  contextOnly = false,
): SyncStore<MessageStore> {
  return {
    append(message) {
      return connection.run((db) => {
        validateMessage(message);
        const inserted = db
          .prepare(
            `INSERT INTO messages
          (chat_id, platform_message_id, user_id, author_name, role, text, reply_to_message_id, timestamp, attachment_count, sender_bot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id, platform_message_id) DO NOTHING RETURNING id`,
          )
          .get(
            message.chatId,
            message.messageId,
            message.userId,
            message.authorName,
            message.role,
            message.text,
            message.replyToMessageId ?? null,
            message.timestamp,
            message.attachmentCount ?? null,
            typeof message.senderBot === 'boolean' ? Number(message.senderBot) : null,
          ) as { id: number } | undefined;
        if (inserted) {
          if (message.isGroupChat && message.role === 'user') {
            requireInput(db.inTransaction);
            assignAuthorNumber(db, message);
          }
          return { status: 'inserted', id: inserted.id };
        }
        const existing = db
          .prepare('SELECT id FROM messages WHERE chat_id = ? AND platform_message_id = ?')
          .get(message.chatId, message.messageId) as { id: number };
        return { status: 'duplicate', id: existing.id };
      });
    },
    list(chatId, query) {
      return connection.run((db) => {
        compositeId(chatId);
        object(query, ['limit', 'from', 'to']);
        requireInput(Number.isSafeInteger(query.limit) && query.limit > 0);
        if ('from' in query) timestamp(query.from);
        if ('to' in query) timestamp(query.to);
        if (query.from !== undefined && query.to !== undefined) requireInput(query.from < query.to);
        const bounds = historyBounds(db, chatId);
        const rows = db
          .prepare(
            `SELECT ${columns} FROM messages WHERE chat_id = ? ${contextOnly ? "AND purpose='conversation'" : ''}
          AND id > ? AND timestamp > ?
          AND (? IS NULL OR timestamp >= ?) AND (? IS NULL OR timestamp < ?)
          ORDER BY timestamp DESC, id DESC LIMIT ?`,
          )
          .all(
            chatId,
            bounds.clearedThrough,
            bounds.expiredThrough,
            query.from ?? null,
            query.from ?? null,
            query.to ?? null,
            query.to ?? null,
            query.limit,
          ) as MessageRow[];
        return rows.reverse().map(fromRow);
      });
    },
  };
}

/** Ограниченное чтение по ссылке; проверку подлинной scope выполняет вызывающий backend. */
export function readMessage(
  db: import('better-sqlite3').Database,
  chatId: string,
  id: number,
): StoredMessage | null {
  requireInput(Number.isSafeInteger(id) && id > 0);
  const bounds = historyBounds(db, chatId);
  const row = db
    .prepare(`SELECT ${columns} FROM messages WHERE chat_id=? AND id=? AND id>? AND timestamp>?`)
    .get(chatId, id, bounds.clearedThrough, bounds.expiredThrough) as MessageRow | undefined;
  return row ? fromRow(row) : null;
}
