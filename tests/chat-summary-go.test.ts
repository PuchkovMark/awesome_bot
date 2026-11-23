import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { createLlmClient } from '../src/llm/client';
import { evaluateChatSummary } from '../src/evals/chat-summaries';

test.skipIf(process.env.RUN_SUMMARY_GO !== '1')(
  'Haiku сохраняет выбор зала, автора обещания и исправленную дату',
  async () => {
    const apiKey = process.env.OPENCODE_API_KEY,
      path = process.env.SUMMARY_EVAL_REPORT;
    if (!apiKey || !path) throw Error('Требуются ключ Go и путь нового отчёта.');
    const model = 'claude-haiku-5-5';
    const result = await evaluateChatSummary(
      createLlmClient({ model, apiKey, provider: 'opencode' }),
      AbortSignal.timeout(100000),
    );
    await writeFile(path, JSON.stringify({ model, ...result }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    expect(result.passed).toBe(true);
  },
  110000,
);
