import type { ChatId, ConnectionScope, UserId } from '../../src/contracts/index';
import { createAuthorizationService } from '../../src/core/index';
import { disclosureStore, type DisclosureInput } from '../../src/storage/chat-disclosure-store';
import { participantRegistryStore } from '../../src/storage/participant-registry';
import { profileInference } from '../../src/storage/profile-fact-store';
import type { ProfileFactChange } from '../../src/storage/participant-types';
import { authConfig } from './authorization-fixture';
import { openStorage, scopeFor } from './connection-scope';
import { storageFixture } from './storage-fixture';

export const alice = 'vk:41';
export const twin = 'vk:42';
export const admin = 'vk:43';
export const group = 'vk:2000000043';
export const neighbor = 'vk:2000000044';

export function set(
  fieldKey: string,
  value: string,
  reliability: 'unverified' | 'confirmed' = 'unverified',
): Extract<ProfileFactChange, { kind: 'set' }> {
  return { kind: 'set', fieldKey, value, reliability };
}

export const profileNotice = {
  profileNotice: 'Действует выбор использования профиля.',
  provider: 'Синтетический провайдер',
  dataPolicy: 'Синтетические сообщения',
  storagePolicy: 'Временная база',
  detailsText: 'Настройки проверяются в SQLite.',
  detailsUrl: 'https://example.test/privacy',
  ownerContact: 'Владелец теста',
  change: 'material',
} as const;

export async function profileFixture() {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  const createAuth = () =>
    createAuthorizationService({ config: authConfig, store: storage.authorization });
  let auth = await createAuth();
  async function chat(chatId: ChatId = group, users: readonly UserId[] = [alice, twin, admin]) {
    const scope = scopeFor(storage, chatId);
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    for (const userId of users)
      participantRegistryStore(storage).observe(scope, {
        kind: 'membership',
        chatId,
        change: 'joined',
        timestamp: 1,
        subjectId: userId,
        actorId: userId,
        eventId: 'join-' + userId,
      });
    return scope;
  }
  function deliver(
    scope: ConnectionScope,
    at = 10,
    notice: DisclosureInput & { readonly profileNotice: string } = profileNotice,
  ) {
    const disclosures = disclosureStore(storage);
    const version = disclosures.register(notice, 1);
    const pending = disclosures.ensure(scope, at === 10 ? 'introduction' : 'update', version);
    const claim = disclosures.claim(scope, pending.id, notice.profileNotice, at);
    if (!claim || !disclosures.finish(scope, claim, 'delivered', at, null, 'notice'))
      throw Error('Уведомление не доставлено.');
  }
  async function message(
    scope: ConnectionScope,
    userId: UserId,
    serial: string,
    timestamp: number,
    senderBot = false,
  ) {
    const { id } = await storage.messages.append(scope, {
      chatId: scope.chatId,
      userId,
      messageId: serial,
      role: 'user',
      text: 'Синтетическая реплика',
      authorName: 'Саша Иванов',
      senderBot,
      timestamp,
    });
    return id;
  }
  return {
    chat,
    deliver,
    message,
    get storage() {
      return storage;
    },
    get auth() {
      return auth;
    },
    get path() {
      return files.path;
    },
    change(
      scope: ConnectionScope,
      actor: UserId,
      subjectId: UserId,
      messageId: number,
      change: ProfileFactChange,
    ) {
      return auth.changeProfileFact(auth.context({ scope, userId: actor }), {
        subjectId,
        messageId,
        change,
      });
    },
    infer(scope: ConnectionScope, subjectId: UserId, messageId: number, change: ProfileFactChange) {
      return profileInference(storage)(scope, { subjectId, messageId, change });
    },
    async reopen() {
      auth.dispose();
      await storage.close();
      storage = await openStorage(files.path);
      auth = await createAuth();
    },
    async close() {
      auth.dispose();
      await storage.close();
      files.cleanup();
    },
  };
}
