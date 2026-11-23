import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup';
import { loadApplicationConfig, loadPromptConfig, loadResolutionConfig } from '../src/config/application';
import { createLifecycleService } from '../src/core/index';
import { catalogAdministration } from '../src/storage/catalog-admin';
import { openStorage } from '../src/storage/index';
import { storageFixture } from './helpers/storage-fixture';

test('настройка приложения редактирует оба значения секрета и проверяет данные до запуска', () => {
  const env = {
    VK_TOKEN: 'test-vk', OPENCODE_API_KEY: 'test-opencode', LLM_MODEL: 'test-model', BOT_OWNER_ID: 'vk:73',
    VK_GROUP_ID: '314', DATABASE_PATH: 'bot.sqlite', MODEL_CONTEXT_TOKENS: '16000',
    MESSAGE_RETENTION_DAYS: '30', LLM_SESSION_SECRET: 'secret-from-environment',
  };
  const options = { env, cwd: '/tmp', readFile: () => 'LLM_SESSION_SECRET=secret-from-file' };
  const loaded = loadApplicationConfig(options);
  expect(loaded.config).toMatchObject({ databasePath: '/tmp/bot.sqlite', vk: { groupId: 314 },
    context: { modelContextTokens: 16000 }, tracing: { messageRetentionDays: 30 } });
  expect(loaded.redact('secret-from-environment secret-from-file test-vk test-opencode')).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  expect(() => loadApplicationConfig({ ...options, env: { ...env, LLM_SESSION_SECRET: env.VK_TOKEN } })).toThrow('LLM_SESSION_SECRET');
  expect(() => loadApplicationConfig({ ...options, env: { ...env, MODEL_CONTEXT_TOKENS: '5' } })).toThrow('MODEL_CONTEXT_TOKENS');
  expect(() => loadApplicationConfig({ ...options, env: { ...env, MESSAGE_RETENTION_DAYS: '7' } })).toThrow('MESSAGE_RETENTION_DAYS');
  expect(() => loadApplicationConfig({ ...options, env: { ...env, DATABASE_PATH: ':memory:' } })).toThrow('DATABASE_PATH');
});

test('первичная версия использует прежний текст после прерывания и сохраняет сделанный выбор', async () => {
  const fixture = storageFixture();
  const file = join(fixture.directory, 'prompt.txt');
  const config = loadPromptConfig({ env: { DATABASE_PATH: fixture.path, MODEL_CONTEXT_TOKENS: '16000' }, readFile: () => '' });
  try {
    await writeFile(file, 'я'.repeat(5000));
    expect(await initializePrompt(config, file)).toBe('static_budget_too_small');
    let storage = await openStorage(fixture.path);
    expect(await catalogAdministration(storage).systemPrompt()).toBeNull();
    await catalogAdministration(storage).append({
      key: 'initial', kind: 'system_prompt', text: 'Первый промпт', createdAt: 0, expectedHead: null,
    });
    await storage.close();

    await writeFile(file, 'Новый текст');
    expect(await initializePrompt(config, file)).toBe('prompt_conflict');
    await writeFile(file, 'Первый промпт');
    expect(await initializePrompt(config, file)).toBeNull();
    await writeFile(file, 'Другой текст');
    expect(await initializePrompt(config, file)).toBeNull();
    storage = await openStorage(fixture.path);
    try {
      expect(await catalogAdministration(storage).systemPrompt()).toMatchObject({ text: 'Первый промпт', ref: { version: 1 } });
    } finally { await storage.close(); }
  } finally { fixture.cleanup(); }
});

test('решение владельца с отдельного соединения продолжает и сбрасывает только указанное подключение', async () => {
  const fixture = storageFixture();
  const config = loadResolutionConfig({ env: { DATABASE_PATH: fixture.path, BOT_OWNER_ID: 'vk:73' }, readFile: () => '' });
  const storage = await openStorage(fixture.path);
  try {
    const life = createLifecycleService({
      storage, ownerId: 'vk:73', source: { async observe() { return { confidence: 'confirmed', bot: 'present' }; } },
    });
    const other = await life.verify('vk:2');
    await life.verify('vk:1', 'observation_lost');
    const continued = await resolveApplicationChat(config, 'vk:1', 'continue');
    expect(life.current('vk:1').generation).toBe(continued.generation);
    const replacement = await resolveApplicationChat(config, 'vk:1', 'new');
    expect(replacement.generation).not.toBe(continued.generation);
    expect(life.current('vk:2').generation).toBe(other.scope?.generation);
  } finally { await storage.close(); fixture.cleanup(); }
});
