import { readFile } from 'node:fs/promises';
import type {
  loadApplicationConfig,
  loadPromptConfig,
  loadResolutionConfig,
} from '../config/application';
import type { ChatId, LifecycleSource } from '../contracts/index';
import { createLifecycleService, validateContextStartup } from '../core/index';
import type { ApplicationFailure } from '../logger/types';
import { catalogAdministration } from '../storage/catalog-admin';
import { openStorage } from '../storage/index';
import { disclosureStore, type DisclosureInput } from '../storage/chat-disclosure-store';
import { adminRecoveryStore } from '../storage/admin-recovery-store';
import { createVkChannel } from '../channels/index';
import { isVkGroupChat } from '../channels/vk/normalize';

export const unconfirmedLifecycleSource: LifecycleSource = {
  async observe() {
    return { confidence: 'unavailable', bot: 'unknown' };
  },
};

const initialPrompt = {
  area: 'global',
  kind: 'system_prompt',
  key: 'initial',
  version: 1,
} as const;

export async function initializePrompt(
  config: ReturnType<typeof loadPromptConfig>,
  path: string,
): Promise<ApplicationFailure | null> {
  const storage = await openStorage(config.databasePath, { versioning: config.versioning });
  try {
    const catalog = catalogAdministration(storage);
    const selected = await catalog.systemPrompt();
    if (selected) return validateContextStartup(selected, config.context);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await readFile(path),
      );
    } catch {
      return 'prompt_unreadable';
    }
    const version = { ref: initialPrompt, text, createdAt: Date.now() };
    const invalid = validateContextStartup(version, config.context);
    if (invalid) return invalid;

    const created = await catalog.append({
      text,
      createdAt: version.createdAt,
      kind: initialPrompt.kind,
      key: initialPrompt.key,
      expectedHead: null,
    });
    const candidate =
      created.status === 'created' ? created.value : await catalog.get(initialPrompt);
    if (candidate?.ref.area !== 'global' || candidate.text !== text) return 'prompt_conflict';
    const selection = await catalog.selectSystemPrompt(candidate.ref, null);
    if (selection.status === 'selected') return null;
    const concurrent = await catalog.systemPrompt();
    if (
      concurrent?.ref.area === 'global' &&
      concurrent.ref.key === candidate.ref.key &&
      concurrent.ref.version === candidate.ref.version
    )
      return null;
    return 'prompt_conflict';
  } finally {
    await storage.close();
  }
}

export function applicationChatId(value: string): ChatId | undefined {
  if (!value.startsWith('vk:')) return undefined;
  const id = Number(value.slice(3));
  return Number.isSafeInteger(id) && id !== 0 && value === `vk:${id}`
    ? (value as ChatId)
    : undefined;
}

export async function resolveApplicationChat(
  config: ReturnType<typeof loadResolutionConfig>,
  chatId: ChatId,
  decision: 'continue' | 'new',
) {
  const storage = await openStorage(config.databasePath);
  try {
    const lifecycle = createLifecycleService({
      storage,
      ownerId: config.ownerId,
      source: unconfirmedLifecycleSource,
    });
    return lifecycle.decide(lifecycle.owner(chatId, config.ownerId), decision);
  } finally {
    await storage.close();
  }
}

type LocalConfig = ReturnType<typeof loadResolutionConfig>;
export function applicationGroupId(value: string) {
  const id = applicationChatId(value);
  return id && isVkGroupChat(Number(id.slice(3))) ? id : undefined;
}

export async function configureDisclosure(config: LocalConfig, path: string) {
  const input = JSON.parse(await readFile(path, 'utf8')) as DisclosureInput;
  const storage = await openStorage(config.databasePath);
  try {
    return disclosureStore(storage).register(input, Date.now());
  } finally {
    await storage.close();
  }
}

export async function readOnboarding(config: LocalConfig, chatId?: ChatId) {
  const storage = await openStorage(config.databasePath);
  try {
    const store = disclosureStore(storage);
    return chatId ? store.status(chatId) : { states: store.diagnostics() };
  } finally {
    await storage.close();
  }
}

export async function readAdminRecovery(config: LocalConfig, chatId: ChatId) {
  const storage = await openStorage(config.databasePath);
  try {
    const store = adminRecoveryStore(storage);
    return {
      operations: store.status(chatId, config.ownerId),
      communityAdmin: store.communityRole(chatId),
    };
  } finally {
    await storage.close();
  }
}

export async function requestDisclosureUpdate(config: LocalConfig, chatId: ChatId) {
  const storage = await openStorage(config.databasePath);
  try {
    const lifecycle = createLifecycleService({
      storage,
      ownerId: config.ownerId,
      source: unconfirmedLifecycleSource,
    });
    const scope = lifecycle.admissionScope(chatId);
    const store = disclosureStore(storage);
    const current = store.latest();
    if (
      !current ||
      store.gate(scope).version !== null ||
      !store
        .publications(scope)
        .some((row) => row.kind === 'introduction' && row.state === 'delivered')
    )
      return false;
    store.ensure(scope, 'update', current.version);
    return true;
  } finally {
    await storage.close();
  }
}

export async function deleteApplicationChatData(
  config: LocalConfig,
  chatId: ChatId,
  generation: number,
) {
  const storage = await openStorage(config.databasePath);
  try {
    const lifecycle = createLifecycleService({
      storage,
      ownerId: config.ownerId,
      source: unconfirmedLifecycleSource,
    });
    lifecycle.deleteData(lifecycle.owner(chatId, config.ownerId), generation);
  } finally {
    await storage.close();
  }
}

export async function confirmApplicationDisclosure(
  config: ReturnType<typeof loadApplicationConfig>['config'],
  chatId: ChatId,
  receipt: string,
  version?: number,
) {
  const storage = await openStorage(config.databasePath);
  try {
    const lifecycle = createLifecycleService({
      storage,
      ownerId: config.authorization.ownerId,
      source: unconfirmedLifecycleSource,
    });
    const scope = lifecycle.admissionScope(chatId);
    const store = disclosureStore(storage);
    const row = store
      .publications(scope)
      .find(
        (item) =>
          item.state === 'unknown' &&
          (version === undefined
            ? item.kind === 'introduction'
            : item.kind === 'update' && item.version === version),
      );
    if (!row?.text || row.attemptedAt === null) return false;
    const signal = AbortSignal.timeout(10_000);
    const channel = createVkChannel({
      ...config.vk,
      owner: config.authorization.ownerId,
      lifecycle,
      chats: storage.chats,
      signal,
    });
    const guard = {
      signal,
      isCurrent: () => !signal.aborted && lifecycle.isAdmissionCurrent(scope),
    };
    if (!(await channel.introduction!.confirm(scope, row.text, receipt, row.attemptedAt, guard)))
      return false;
    return store.confirm(scope, row.id, receipt, Date.now());
  } finally {
    await storage.close();
  }
}
