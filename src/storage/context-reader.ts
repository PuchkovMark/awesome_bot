import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { historyBounds } from './history-retention-store';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { ContextMessage, ContextMessageReader, ContextRecord } from './context-types';
import { createMessageStore } from './messages';
import { requireInput } from './validation';
function positive(n: number, max = Number.MAX_SAFE_INTEGER) {
  requireInput(Number.isSafeInteger(n) && n > 0 && n <= max);
}
const columns = `m.id,m.chat_id AS chatId,m.platform_message_id AS messageId,m.user_id AS userId,m.role,
 m.reply_to_message_id AS replyToMessageId,m.timestamp,m.purpose,m.attachment_count AS attachmentCount,m.sender_bot AS senderBot`;
const projection = `${columns},
 coalesce(CAST(substr(CAST(m.text AS BLOB),1,?) AS TEXT),'') AS text,
 coalesce(CAST(substr(CAST(m.author_name AS BLOB),1,?) AS TEXT),'') AS authorName,
 length(CAST(m.text AS BLOB)) AS textBytes,length(CAST(m.author_name AS BLOB)) AS nameBytes`;
const authorJoin = `LEFT JOIN chat_author_labels a
 ON a.chat_id=m.chat_id AND a.generation=? AND a.user_id=m.user_id AND m.role='user'`;
const visible = `m.chat_id=? AND m.purpose='conversation' AND m.id>? AND m.timestamp>?`;
type MessageRow = Omit<ContextMessage, 'replyToMessageId' | 'authorNumber' | 'senderBot'> & {
  replyToMessageId: string | null;
  senderBot: number | null;
  authorNumber: number | null;
};
type Row = MessageRow & {
  textBytes: number;
  nameBytes: number;
};
function contextMessage(row: MessageRow): ContextMessage {
  const { replyToMessageId, authorNumber, senderBot, ...message } = row;
  return {
    ...message,
    ...(senderBot == null ? {} : { senderBot: senderBot !== 0 }),
    ...(replyToMessageId !== null ? { replyToMessageId } : {}),
    ...(authorNumber !== null ? { authorNumber } : {}),
  };
}
function result(row: Row, limit: number): ContextRecord {
  const { textBytes, nameBytes, ...rest } = row;
  const text = Array.from(row.text),
    name = Array.from(row.authorName);
  return {
    ...contextMessage(rest),
    text: text.slice(0, limit).join(''),
    authorName: name.slice(0, limit).join(''),
    truncated:
      text.length > limit || name.length > limit || textBytes > limit * 4 || nameBytes > limit * 4,
  };
}
export interface HistorySelection {
  readonly kind: 'search' | 'period';
  readonly cutoffId: number;
  readonly from?: number;
  readonly to?: number;
  readonly query?: string;
  readonly author?: UserId;
  readonly authorNumber?: number;
  readonly limit: number;
}

export interface HistorySnapshot {
  readonly found: number;
  readonly rows: readonly ContextRecord[];
  countsCurrent(): boolean;
}

function selectHistory(
  lifecycle: LifecycleBackend,
  scope: ConnectionScope,
  selection: HistorySelection,
): HistorySnapshot {
  const { kind, cutoffId, limit, from, to, query, author, authorNumber } = selection;
  positive(cutoffId);
  positive(limit, 40);
  requireInput(kind === 'search' || kind === 'period');
  if (kind === 'period') requireInput(from !== undefined && to !== undefined);
  if (from !== undefined) requireInput(Number.isSafeInteger(from));
  if (to !== undefined) requireInput(Number.isSafeInteger(to));
  if (from !== undefined && to !== undefined) requireInput(from < to);
  const filters = [visible, 'm.id<=?'];
  const values: (string | number)[] = [cutoffId];
  if (from !== undefined) {
    filters.push('m.timestamp>=?');
    values.push(from);
  }
  if (to !== undefined) {
    filters.push('m.timestamp<?');
    values.push(to);
  }
  if (author !== undefined) {
    filters.push('m.user_id=?');
    values.push(author);
  }
  if (authorNumber !== undefined) {
    positive(authorNumber);
    filters.push('a.author_number=?');
    values.push(authorNumber);
  }
  if (query !== undefined) {
    requireInput(query.trim().length > 0 && query.length <= 512 && !query.includes('\0'));
    filters.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
    values.push('"' + query.replaceAll('"', '""') + '"');
  }
  if (kind === 'search') {
    // SQLite lower() распознаёт только ASCII. Варианты русской реакции перечислены явно.
    filters.push("trim(m.text, ?) NOT IN ('', '+', '👍', 'ок', 'ОК', 'Ок', 'оК')");
    values.push(
      ' \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
    );
  }
  const source = `FROM personal_visible_messages m ${authorJoin} WHERE ${filters.join(' AND ')}`;
  function parameters(db: Database) {
    const bounds = historyBounds(db, scope.chatId);
    return [
      scope.generation,
      scope.chatId,
      bounds.clearedThrough,
      bounds.expiredThrough,
      ...values,
    ];
  }
  return lifecycle.transaction(scope, (db) => {
    const count = db.prepare('SELECT count(*) ' + source).pluck();
    const args = parameters(db);
    const found = count.get(...args) as number;
    const textLimit = 2048;
    const rows = db
      .prepare(
        `SELECT ${projection},a.author_number AS authorNumber ${source}
      ORDER BY m.timestamp DESC,m.id DESC LIMIT ?`,
      )
      .all(textLimit * 4, textLimit * 4, ...args, limit) as Row[];
    return {
      found,
      rows: rows.map((row) => result(row, textLimit)),
      countsCurrent: () =>
        lifecycle.transaction(scope, (db) => count.get(...parameters(db)) === found),
    };
  });
}

export interface ContextSearch {
  history(scope: ConnectionScope, selection: HistorySelection): HistorySnapshot;
  search(
    scope: import('../contracts/index').ConnectionScope,
    query: string,
    limit: number,
    textLimit: number,
  ): Promise<readonly ContextRecord[]>;
}
export function createContextReader(
  connection: Connection,
  lifecycle: LifecycleBackend,
): ContextMessageReader & ContextSearch {
  const reader = createMessageStore(connection, true);
  return Object.freeze({
    history(scope, selection) {
      return selectHistory(lifecycle, scope, selection);
    },
    async get(scope, id) {
      return lifecycle.transaction(scope, (db) => {
        positive(id);
        const bounds = historyBounds(db, scope.chatId);
        const row = db
          .prepare(
            `SELECT ${columns},m.text,m.author_name AS authorName,a.author_number AS authorNumber
            FROM personal_visible_messages m ${authorJoin} WHERE ${visible} AND m.id=?`,
          )
          .get(scope.generation, scope.chatId, bounds.clearedThrough, bounds.expiredThrough, id) as
          MessageRow | undefined;
        return row ? contextMessage(row) : null;
      });
    },
    async list(scope, query) {
      return lifecycle.transaction(scope, () => reader.list(scope.chatId, query));
    },
    async page(scope, q) {
      return lifecycle.transaction(scope, (db) => {
        positive(q.cutoffId);
        positive(q.limit, 256);
        positive(q.textLimit, 16384);
        if (q.beforeId !== undefined) positive(q.beforeId);
        const bounds = historyBounds(db, scope.chatId);
        const rows = db
          .prepare(
            `SELECT ${projection},a.author_number AS authorNumber FROM personal_visible_messages m ${authorJoin}
            WHERE ${visible} AND m.id<=? AND m.id<? ORDER BY m.id DESC LIMIT ?`,
          )
          .all(
            q.textLimit * 4,
            q.textLimit * 4,
            scope.generation,
            scope.chatId,
            bounds.clearedThrough,
            bounds.expiredThrough,
            q.cutoffId,
            q.beforeId ?? Number.MAX_SAFE_INTEGER,
            q.limit,
          ) as Row[];
        return rows.map((r) => result(r, q.textLimit));
      });
    },
    async reply(scope, id, cutoff, limit) {
      return lifecycle.transaction(scope, (db) => {
        positive(cutoff);
        positive(limit, 16384);
        requireInput(typeof id === 'string' && id.length > 0);
        const bounds = historyBounds(db, scope.chatId);
        const row = db
          .prepare(
            `SELECT ${projection},a.author_number AS authorNumber FROM personal_visible_messages m ${authorJoin}
            WHERE ${visible} AND m.platform_message_id=? AND m.id<=?`,
          )
          .get(
            limit * 4,
            limit * 4,
            scope.generation,
            scope.chatId,
            bounds.clearedThrough,
            bounds.expiredThrough,
            id,
            cutoff,
          ) as Row | undefined;
        return row ? result(row, limit) : null;
      });
    },
    async search(scope, query, limit, textLimit) {
      return lifecycle.transaction(scope, (db) => {
        positive(limit, 100);
        positive(textLimit, 16384);
        requireInput(typeof query === 'string' && query.trim().length > 0 && query.length <= 512);
        const bounds = historyBounds(db, scope.chatId);
        const phrase = '"' + query.replaceAll('"', '""') + '"';
        const rows = db
          .prepare(
            `SELECT ${projection},NULL AS authorNumber FROM personal_visible_messages m WHERE m.id IN (
     SELECT messages_fts.rowid FROM messages_fts JOIN personal_visible_messages m ON m.id=messages_fts.rowid
     WHERE messages_fts MATCH ? AND m.chat_id=? AND m.purpose='conversation' AND m.id>? AND m.timestamp>?
     ORDER BY messages_fts.rowid DESC LIMIT ?
   ) ORDER BY m.id DESC`,
          )
          .all(
            textLimit * 4,
            textLimit * 4,
            phrase,
            scope.chatId,
            bounds.clearedThrough,
            bounds.expiredThrough,
            limit,
          ) as Row[];
        return rows.map((row) => result(row, textLimit));
      });
    },
  } satisfies ContextMessageReader & ContextSearch);
}
