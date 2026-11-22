import { API } from 'vk-io';
import type { KnownBoolean } from '../../contracts/index.js';
import { isVkGroupChat, vkId, vkRecord } from './normalize.js';
import type { VkEnrichment, VkIncoming } from './normalize.js';

type ApiMethod = 'groups.getLongPollServer' | 'users.get'
  | 'messages.getConversationMembers' | 'messages.getByConversationMessageId';

export type VkApiCall = (method: ApiMethod, parameters: Record<string, string | number>) => Promise<unknown>;

export interface VkLongPollServer {
  readonly server: string;
  readonly key: string;
  readonly ts: string;
}

export class VkApiError extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined) {
    super(code === undefined ? 'VK API request failed' : `VK API error ${code}`);
    this.name = 'VkApiError';
    this.code = code;
  }
}

export function vkCursor(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{1,32}$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function personalProfiles(call: VkApiCall) {
  const ttl = 5 * 60_000;
  const cache = new Map<number, { name: string; expires: number }>();
  const pending = new Map<number, Promise<string | undefined>>();
  const requested = new Map<number, (name: string | undefined) => void>();

  async function fetchNames(batch: readonly [number, (name: string | undefined) => void][]) {
    const names = new Map<number, string>();
    try {
      const response = await call('users.get', { user_ids: batch.map(([id]) => id).join(',') });
      if (Array.isArray(response)) {
        for (const item of response) {
          const person = vkRecord(item);
          if (!person || typeof person.id !== 'number' || person.id <= 0 || person.deactivated != null) continue;
          const name = [person.first_name, person.last_name]
            .filter((part): part is string => typeof part === 'string')
            .map(part => part.trim()).filter(Boolean).join(' ');
          names.set(person.id, name);
        }
      }
    } catch {
      // Недоступный профиль оставляет признаки автора неизвестными.
    }
    for (const [id, resolve] of batch) {
      const name = names.get(id);
      if (name !== undefined) {
        if (cache.size >= 2048) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(id, { name, expires: Date.now() + ttl });
      }
      pending.delete(id);
      resolve(name);
    }
  }

  function flush() {
    const batch = [...requested];
    requested.clear();
    for (let offset = 0; offset < batch.length; offset += 100) {
      void fetchNames(batch.slice(offset, offset + 100));
    }
  }

  return function nameFor(id: number): Promise<string | undefined> {
    if (id <= 0) return Promise.resolve(undefined);
    const entry = cache.get(id);
    if (entry && entry.expires > Date.now()) return Promise.resolve(entry.name);
    cache.delete(id);
    const existing = pending.get(id);
    if (existing) return existing;
    if (requested.size === 0) queueMicrotask(flush);
    const result = new Promise<string | undefined>(resolve => requested.set(id, resolve));
    pending.set(id, result);
    return result;
  };
}

async function adminFor(call: VkApiCall, message: VkIncoming): Promise<KnownBoolean> {
  if (!isVkGroupChat(message.peerId)) return 'unknown';
  try {
    const response = vkRecord(await call('messages.getConversationMembers', {
      peer_id: message.peerId, member_ids: String(message.authorId),
    }));
    if (Array.isArray(response?.items)) {
      const member = response.items.map(vkRecord).find(row => row?.member_id === message.authorId);
      if (typeof member?.is_admin === 'boolean') return member.is_admin;
    }
  } catch {
    // Отказ доступа и отсутствие строки не подтверждают роль.
  }
  return 'unknown';
}

async function verifyReply(call: VkApiCall, message: VkIncoming): Promise<VkEnrichment['verifiedReply']> {
  const reply = message.reply;
  if (!reply) return undefined;
  try {
    const response = vkRecord(await call('messages.getByConversationMessageId', {
      peer_id: message.peerId, conversation_message_ids: `${message.cmid},${reply.cmid}`,
    }));
    if (!Array.isArray(response?.items)) return undefined;
    const local = response.items.map(vkRecord).filter(row => row?.peer_id === message.peerId);
    const current = local.find(row => row?.conversation_message_id === message.cmid);
    const parent = local.find(row => row?.conversation_message_id === reply.cmid);
    const embedded = vkRecord(current?.reply_message);
    const authorId = vkId(parent?.from_id);
    if (current?.from_id !== message.authorId || current.date !== message.timestamp / 1000
      || embedded?.conversation_message_id !== reply.cmid || typeof parent?.date !== 'number'
      || !Number.isSafeInteger(parent.date) || parent.date < 0 || parent.date > current.date
      || embedded.date !== parent.date || (embedded.peer_id != null && embedded.peer_id !== message.peerId)
      || (reply.date !== undefined && reply.date !== parent.date * 1000)
      || (reply.authorId !== undefined && reply.authorId !== authorId)
      || (embedded.from_id != null && embedded.from_id !== authorId)) return undefined;
    return { cmid: reply.cmid, authorId };
  } catch {
    return undefined;
  }
}

export function createVkApi(
  groupId: number,
  call: VkApiCall,
) {
  const nameFor = personalProfiles(call);
  return Object.freeze({
    async getLongPollServer(): Promise<VkLongPollServer> {
      let response: Record<string, unknown> | undefined;
      try {
        response = vkRecord(await call('groups.getLongPollServer', { group_id: groupId }));
      } catch (error) {
        const code = vkRecord(error)?.code;
        throw new VkApiError(typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? code : undefined);
      }
      const ts = vkCursor(response?.ts);
      if (!ts || typeof response?.server !== 'string' || !response.server || typeof response.key !== 'string' || !response.key) {
        throw new VkApiError(undefined);
      }
      return { server: response.server, key: response.key, ts };
    },
    async enrich(message: VkIncoming): Promise<VkEnrichment> {
      const [name, isAdmin, verifiedReply] = await Promise.all([
        nameFor(message.authorId), adminFor(call, message), verifyReply(call, message),
      ]);
      return {
        ...(name === undefined ? {} : { authorName: name }),
        isBot: message.authorId === -groupId ? true : name === undefined ? 'unknown' : false,
        isAdmin,
        ...(verifiedReply ? { verifiedReply } : {}),
      };
    },
  });
}

export type VkApi = ReturnType<typeof createVkApi>;

export function createVkSdkApi(groupId: number, token: string): VkApi {
  const sdk = new API({ token, apiBaseUrl: 'https://api.vk.ru/method', apiVersion: '5.199', apiLimit: 20 });
  return createVkApi(groupId, (method, parameters) => sdk.call<unknown>(method, parameters));
}
