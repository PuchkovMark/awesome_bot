import type { ChatId } from '../contracts/index.js';
import type { Connection } from './connection.js';
import type { ChatInput, ChatPatch, ChatSettings, ChatStore } from './types.js';
import { compositeId, mode, nullableString, object, requireInput, timestamp, timezone } from './validation.js';

const patchFields = ['title', 'systemPrompt', 'responseMode', 'enabled', 'timezone'] as const;
const columns = `chat_id AS chatId, title, system_prompt AS systemPrompt,
  response_mode AS responseMode, timezone, enabled, created_at AS createdAt`;
type ChatRow = Omit<ChatSettings, 'enabled'> & { enabled: number };
function fromRow(row: ChatRow | undefined): ChatSettings | null {
  return row ? { ...row, enabled: row.enabled === 1 } : null;
}
function validatePatch(patch: ChatPatch): void {
  object(patch, patchFields);
  if ('title' in patch) nullableString(patch.title);
  if ('systemPrompt' in patch) nullableString(patch.systemPrompt);
  if ('responseMode' in patch) mode(patch.responseMode);
  if ('enabled' in patch) requireInput(typeof patch.enabled === 'boolean');
  if ('timezone' in patch) timezone(patch.timezone);
}
function validateCreate(input: ChatInput): void {
  object(input, [...patchFields, 'createdAt']);
  mode(input.responseMode); requireInput(typeof input.enabled === 'boolean'); timestamp(input.createdAt);
  const { createdAt, ...settings } = input;
  void createdAt;
  validatePatch(settings);
}
export function createChatStore(connection: Connection): ChatStore {
  function read(chatId: ChatId): ChatSettings | null {
    return connection.run((db) => fromRow(db.prepare(`SELECT ${columns} FROM chats WHERE chat_id = ?`).get(chatId) as ChatRow | undefined));
  }
  return {
    async get(chatId) {
      return connection.run(() => { compositeId(chatId); return read(chatId); });
    },
    async create(chatId, input) {
      return connection.run((db) => {
        compositeId(chatId); validateCreate(input);
        const result = db.prepare(`INSERT INTO chats
          (chat_id,title,system_prompt,response_mode,timezone,enabled,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chat_id) DO NOTHING`).run(
          chatId, input.title ?? null, input.systemPrompt ?? null, input.responseMode,
          input.timezone ?? 'Europe/Moscow', input.enabled ? 1 : 0, input.createdAt,
        );
        const settings = read(chatId);
        if (!settings) throw new Error('Missing stored settings');
        return { status: result.changes === 1 ? 'created' : 'existing', settings };
      });
    },
    async update(chatId, patch) {
      return connection.run((db) => {
        compositeId(chatId); validatePatch(patch);
        requireInput(Object.keys(patch).length > 0);
        // Имена колонок берутся только из внутреннего словаря.
        const mapping = { title: 'title', systemPrompt: 'system_prompt', responseMode: 'response_mode', enabled: 'enabled', timezone: 'timezone' } as const;
        const keys = patchFields.filter((key) => Object.hasOwn(patch, key));
        const values = keys.map((key) => key === 'enabled' ? (patch.enabled ? 1 : 0) : patch[key]);
        db.prepare(`UPDATE chats SET ${keys.map((key) => `${mapping[key]} = ?`).join(', ')} WHERE chat_id = ?`).run(...values, chatId);
        return read(chatId);
      });
    },
  };
}
