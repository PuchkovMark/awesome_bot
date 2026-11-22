import { readFile } from 'node:fs/promises';
import type { loadPromptConfig, loadResolutionConfig } from '../config/application.js';
import type { ChatId, LifecycleSource } from '../contracts/index.js';
import { createLifecycleService, validateContextStartup } from '../core/index.js';
import type { ApplicationFailure } from '../logger/types.js';
import { catalogAdministration } from '../storage/catalog-admin.js';
import { openStorage } from '../storage/index.js';

export const unconfirmedLifecycleSource: LifecycleSource = {
  async observe() { return { confidence: 'unavailable', bot: 'unknown' }; },
};

const initialPrompt = { area: 'global', kind: 'system_prompt', key: 'initial', version: 1 } as const;

export async function initializePrompt(config: ReturnType<typeof loadPromptConfig>, path: string):
Promise<ApplicationFailure | null> {
  const storage = await openStorage(config.databasePath, { versioning: config.versioning });
  try {
    const catalog = catalogAdministration(storage);
    const selected = await catalog.systemPrompt();
    if (selected) return validateContextStartup(selected, config.context);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path)); }
    catch { return 'prompt_unreadable'; }
    const version = { ref: initialPrompt, text, createdAt: Date.now() };
    const invalid = validateContextStartup(version, config.context);
    if (invalid) return invalid;

    const created = await catalog.append({ text, createdAt: version.createdAt, kind: initialPrompt.kind,
      key: initialPrompt.key, expectedHead: null });
    const candidate = created.status === 'created' ? created.value : await catalog.get(initialPrompt);
    if (candidate?.ref.area !== 'global' || candidate.text !== text) return 'prompt_conflict';
    const selection = await catalog.selectSystemPrompt(candidate.ref, null);
    if (selection.status === 'selected') return null;
    const concurrent = await catalog.systemPrompt();
    if (concurrent?.ref.area === 'global' && concurrent.ref.key === candidate.ref.key
      && concurrent.ref.version === candidate.ref.version) return null;
    return 'prompt_conflict';
  } finally {
    await storage.close();
  }
}

export function applicationChatId(value: string): ChatId | undefined {
  if (!value.startsWith('vk:')) return undefined;
  const id = Number(value.slice(3));
  return Number.isSafeInteger(id) && id !== 0 && value === `vk:${id}` ? value as ChatId : undefined;
}

export async function resolveApplicationChat(
  config: ReturnType<typeof loadResolutionConfig>, chatId: ChatId, decision: 'continue' | 'new',
) {
  const storage = await openStorage(config.databasePath);
  try {
    const lifecycle = createLifecycleService({ storage, ownerId: config.ownerId, source: unconfirmedLifecycleSource });
    return lifecycle.decide(lifecycle.owner(chatId, config.ownerId), decision);
  } finally {
    await storage.close();
  }
}
