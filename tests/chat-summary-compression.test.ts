import { expect, test } from 'vitest';
import { loadApplicationConfig } from '../src/config/application';
import { createLlmClient } from '../src/llm/client';
import { compressTexts } from '../src/core/chat-summaries/compress';
test('сжатие отправляет фактический запрос в выбранный Haiku и отказывает при ошибке провайдера', async () => {
  const env = {
    VK_TOKEN: 'mock',
    VK_GROUP_ID: '1',
    BOT_OWNER_ID: 'vk:1',
    OPENCODE_API_KEY: 'test',
    LLM_MODEL: 'main',
    MODEL_CONTEXT_TOKENS: '16000',
    MESSAGE_RETENTION_DAYS: '30',
    DATABASE_PATH: 'test.sqlite',
    LLM_SESSION_SECRET: 'synthetic',
  };
  const { config } = loadApplicationConfig({ env, readFile: () => '' });
  const models: string[] = [];
  const client = createLlmClient(
    { ...config.llm, model: config.auxiliaryModel },
    {
      async fetch(_url, init) {
        models.push(JSON.parse(String(init.body)).model);
        return new Response('{}', { status: 503 });
      },
    },
  );
  await expect(
    compressTexts(['текст'], {
      signal: new AbortController().signal,
      sessionId: 'a'.repeat(64),
      inputLimit: 3500,
      outputLimit: 512,
      invoke: client.complete,
    }),
  ).rejects.toThrow('unavailable');
  expect(models).toEqual(['claude-haiku-5-5']);
  expect(() =>
    loadApplicationConfig({ env: { ...env, LLM_AUX_MODEL: '' }, readFile: () => '' }),
  ).toThrow();
});
