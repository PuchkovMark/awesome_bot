import type { SyncStore } from './legacy-types.js';
import type { Connection } from './connection.js';
import type { MessageInput, MessageStore, StoredMessage } from './legacy-types.js';
import { compositeId, object, requireInput, string, timestamp } from './validation.js';

const fields = ['chatId', 'messageId', 'userId', 'authorName', 'role', 'text', 'replyToMessageId', 'timestamp'];
function validateMessage(message: MessageInput): void {
  object(message, fields);
  compositeId(message.chatId); compositeId(message.userId);
  requireInput(message.chatId.slice(0, message.chatId.indexOf(':')) === message.userId.slice(0, message.userId.indexOf(':')));
  string(message.messageId, true); string(message.authorName); string(message.text);
  requireInput(message.role === 'user' || message.role === 'assistant');
  timestamp(message.timestamp);
  if ('replyToMessageId' in message) string(message.replyToMessageId, true);
}
const columns = `id, chat_id AS chatId, platform_message_id AS messageId,
  user_id AS userId, author_name AS authorName, role, text,
  reply_to_message_id AS replyToMessageId, timestamp`;
type MessageRow = Omit<StoredMessage, 'replyToMessageId'> & { replyToMessageId: string | null };
function fromRow(row: MessageRow): StoredMessage {
  const { replyToMessageId, ...message } = row;
  return replyToMessageId === null ? message : { ...message, replyToMessageId };
}
export function createMessageStore(connection: Connection): SyncStore<MessageStore> {
  return {
    append(message) {
      return connection.run((db) => {
        validateMessage(message);
        const inserted = db.prepare(`INSERT INTO messages
          (chat_id, platform_message_id, user_id, author_name, role, text, reply_to_message_id, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id, platform_message_id) DO NOTHING RETURNING id`).get(
          message.chatId, message.messageId, message.userId, message.authorName, message.role,
          message.text, message.replyToMessageId ?? null, message.timestamp,
        ) as { id: number } | undefined;
        if (inserted) return { status: 'inserted', id: inserted.id };
        const existing = db.prepare('SELECT id FROM messages WHERE chat_id = ? AND platform_message_id = ?')
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
        const rows = db.prepare(`SELECT ${columns} FROM messages WHERE chat_id = ?
          AND (? IS NULL OR timestamp >= ?) AND (? IS NULL OR timestamp < ?)
          ORDER BY timestamp DESC, id DESC LIMIT ?`).all(
          chatId, query.from ?? null, query.from ?? null, query.to ?? null, query.to ?? null, query.limit,
        ) as MessageRow[];
        return rows.reverse().map(fromRow);
      });
    },
  };
}

/** Ограниченное чтение по ссылке; проверку подлинной scope выполняет вызывающий backend. */
export function readMessage(db: import('better-sqlite3').Database, chatId: string, id: number): StoredMessage | null {
  requireInput(Number.isSafeInteger(id) && id > 0);
  const row = db.prepare(`SELECT ${columns} FROM messages WHERE chat_id=? AND id=?`).get(chatId, id) as MessageRow | undefined;
  return row ? fromRow(row) : null;
}
