import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { fixture, mention } from './helpers/application-response-fixture';
import { createLlmClient } from '../src/llm/client';
import { tokenBudgetStore } from '../src/storage/token-budget-store';

const scenarios = [
  {
    id: 'simple',
    text: 'В этом тесте фонарь зелёный. Какого цвета фонарь? Ответь одним предложением.',
  },
  {
    id: 'compound',
    text: 'Нужны два независимых разбора синтетического расписания: извлеки требования участников и сравни варианты. Аня может только после 17:00, Борис только до 19:00. Зал А в 16:00, зал Б в 18:00. Назови оба требования и выбери зал с обоснованием.',
  },
  {
    id: 'missing',
    text: 'В условии сказано только «Встреча в четверг». Где и во сколько она будет? Отдели известное от неизвестного.',
  },
];
test.skipIf(process.env.RUN_DELEGATION_GO !== '1')(
  'сравнение на синтетических данных через Go',
  async () => {
    const apiKey = process.env.OPENCODE_API_KEY,
      model = process.env.LLM_MODEL,
      output = process.env.DELEGATION_REPORT;
    if (!apiKey || !model || !output) throw Error('Нужны настройки Go и новый путь отчёта.');
    const signal = AbortSignal.timeout(350_000);
    let count = 0;
    const client = createLlmClient(
      { provider: 'opencode', model, apiKey },
      {
        timeoutMs: 30000,
        fetch: (url, options) => {
          if (signal.aborted || count >= 18) throw Error('Окончен бюджет прогона.');
          count++;
          return fetch(url, {
            ...options,
            signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
          });
        },
      },
    );
    const rows = [];
    for (const scenario of scenarios)
      for (const mode of ['direct', 'delegate']) {
        if (signal.aborted || count >= 18) break;
        const app = await fixture();
        try {
          const attempts: {
            kind: string;
            helper: boolean;
            input: number | null;
            output: number | null;
          }[] = [];
          tokenBudgetStore(app.storage).update(app.scope, true, { total: 50000 }, app.start);
          app.complete.mockImplementation(async (request) => {
            const { tools, ...rest } = request;
            const helper = request.system.includes('Выполни указанную подзадачу');
            const result = await client.complete(
              mode === 'direct' ? rest : { ...rest, ...(tools ? { tools } : {}) },
            );
            attempts.push({
              kind: result.kind,
              helper,
              input: 'usage' in result ? result.usage.input : null,
              output: 'usage' in result ? result.usage.output : null,
            });
            if (mode === 'direct' && result.kind === 'tool_calls')
              return { kind: 'refused', usage: result.usage };
            return result;
          });
          const start = process.hrtime.bigint();
          const id = app.submit(mention + ' ' + scenario.text);
          await expect
            .poll(() => app.sends.length, { timeout: 125000, interval: 50 })
            .toBeGreaterThan(0);
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
          const trace = await app.trace(id);
          rows.push({
            id: scenario.id,
            mode,
            model,
            elapsedMs: Math.round(elapsedMs),
            answer: app.sends.at(-1)?.text,
            kind: trace.payload.resultKind,
            tools: trace.payload.tools,
            attempts,
          });
        } finally {
          await app.close();
        }
      }
    await writeFile(output, JSON.stringify({ model, requests: count, rows }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    expect(rows).toHaveLength(6);
  },
  360000,
);
