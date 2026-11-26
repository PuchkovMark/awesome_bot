import { questionnaireCases } from '../src/evals/questionnaire';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { historySearchScenarios, profileUpdateCases, scenarios } from '../src/evals/scenarios';

function cli(directory: string, args: string[], before = '', timeoutMs = 10_000) {
  const importHook = `data:text/javascript,${encodeURIComponent(before)}`;
  const result = spawnSync(
    process.execPath,
    ['--import', importHook, resolve('dist/evals/cli.js'), ...args],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {},
      timeout: timeoutMs,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

test('собранная команда запускает набор, а чек-лист читает тот же каталог без открытия SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-evals-cli-'));
  try {
    const out = cli(
      directory,
      ['--out', 'results.json'],
      `globalThis.fetch=()=>{throw Error('NETWORK');};`,
      60_000,
    );
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(
      `Пройдено ${scenarios.length + questionnaireCases.length + profileUpdateCases.length + 1}`,
    );
    const report = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
    expect(report).toMatchObject({ kind: 'local', schemaVersion: 1 });
    expect(report.runs).toHaveLength(
      scenarios.length + questionnaireCases.length + profileUpdateCases.length + 1,
    );
    const checklist = cli(
      directory,
      ['--checklist'],
      `
      import {registerHooks} from 'node:module';
      registerHooks({resolve(id, context, next){
        if(id==='better-sqlite3')throw Error('SQLITE_DURING_CHECKLIST');
        return next(id,context);
      }});
    `,
    );
    expect(checklist.status, checklist.stderr).toBe(0);
    expect(checklist.stdout).toContain('тестовом сообществе VK');
    for (const [index, scenario] of scenarios.entries()) {
      expect(report.runs[index]).toMatchObject({
        scenarioId: scenario.id,
        scenarioRevision: scenario.revision,
        attempt: 1,
        outcome: 'passed',
      });
      if (scenario.persona)
        expect(report.runs[index].persona).toEqual({
          area: 'global',
          kind: 'persona',
          key: scenario.persona.id,
          version: 1,
        });
      expect(checklist.stdout).toContain(`${scenario.id} (ревизия ${scenario.revision})`);
      expect(checklist.stdout).toContain(scenario.input.text);
      for (const criterion of scenario.criteria) expect(checklist.stdout).toContain(criterion.id);
    }
    const overwrite = cli(directory, ['--out', 'results.json']);
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toBe('Файл отчёта уже существует.\n');
    expect(cli(directory, ['--out']).status).toBe(1);
    expect(cli(directory, ['--out', 'missing-parent/report.json']).stderr).toBe(
      'Не удалось сохранить отчёт по указанному пути.\n',
    );
    expect(readdirSync(directory)).toEqual(['results.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test('отдельная оценка фиксирует качество модели и токены в пределах семи попыток', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-evals-profile-model-'));
  try {
    const transport = `
      process.env.LLM_MODEL = 'synthetic-model';
      process.env.OPENCODE_API_KEY = 'synthetic-secret';
      globalThis.fetch = async () => Response.json({
        choices: [{ message: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      });
    `;
    const out = cli(directory, ['--profile-model', '--out', 'model.json'], transport);
    expect(out.status, out.stderr).toBe(1);
    expect(out.stdout).toContain('Пройдено 4, нарушений 3, технических сбоев 0');
    const contents = readFileSync(join(directory, 'model.json'), 'utf8');
    expect(contents).not.toMatch(/synthetic-secret|космодрома|виолончель/);
    const report = JSON.parse(contents) as {
      kind: string;
      runs: {
        model: string;
        extraction: {
          requestRevision: number;
          inputEstimate: number;
          outputReserve: number;
          inputTokens: number;
          outputTokens: number;
        };
      }[];
    };
    expect(report.kind).toBe('model');
    expect(report.runs).toHaveLength(7);
    for (const run of report.runs) {
      expect(run.model).toBe('synthetic-model');
      expect(run.extraction).toMatchObject({ requestRevision: 2, inputTokens: 9, outputTokens: 2 });
    }
    expect(
      report.runs.reduce(
        (sum, { extraction }) => sum + extraction.inputEstimate + extraction.outputReserve,
        0,
      ),
    ).toBeLessThanOrEqual(7500);
    const repeated = cli(
      directory,
      ['--profile-model', '--case', 'explicit-custom-field', '--out', 'one.json'],
      transport,
    );
    expect(repeated.stdout).toContain('Пройдено 0, нарушений 1, технических сбоев 0');
    const { runs: one } = JSON.parse(
      readFileSync(join(directory, 'one.json'), 'utf8'),
    ) as typeof report;
    expect(one).toHaveLength(1);
    expect(one[0]!.extraction.outputReserve).toBe(800);
    expect(one[0]!.extraction.outputReserve + one[0]!.extraction.inputEstimate).toBeLessThanOrEqual(
      1500,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('оценка модели по истории делает два запроса на случай и сохраняет исходы с версией промпта', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-evals-history-model-'));
  try {
    const transport = `
      process.env.LLM_MODEL = 'synthetic-history-model';
      process.env.OPENCODE_API_KEY = 'synthetic-history-secret';
      let requests = 0;
      process.on('exit', () => { if (requests !== 6) process.exitCode = 2; });
      function respond(message, finish_reason) {
        return Response.json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] });
      }
      globalThis.fetch = async (_url, { body }) => {
        requests++;
        const request = JSON.parse(body);
        if (request.model !== 'synthetic-history-model') throw Error('WRONG_MODEL');
        const feedback = request.messages.find(({ role }) => role === 'tool');
        if (!feedback) {
          if (!request.tools.some(({ function: tool }) => tool.name === 'history_search'))
            throw Error('MISSING_SEARCH');
          return respond({
            content: null,
            tool_calls: [{
              type: 'function',
              id: 'mock-search',
              function: {
                name: 'history_search',
                arguments: JSON.stringify({
                  query: 'встреча', from: '2026-11-23T00:00:00+03:00', to: '2026-11-24T00:00:00+03:00',
                }),
              },
            }],
          }, 'tool_calls');
        }
        if (feedback.tool_call_id !== 'mock-search') throw Error('WRONG_CALL');
        const result = JSON.parse(feedback.content);
        const content = result.error === 'tool_failed'
          ? 'Сейчас не удалось проверить переписку.'
          : result.messages[0]?.text ?? 'В доступном журнале за вчера совпадений нет.';
        return respond({ content }, 'stop');
      };
    `;
    const out = cli(directory, ['--history-model', '--out', 'history.json'], transport);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('Пройдено 3, нарушений 0, технических сбоев 0');
    const contents = readFileSync(join(directory, 'history.json'), 'utf8');
    expect(contents).not.toMatch(/synthetic-history-secret|фонтан|mock-search|tool_failed/);
    expect(JSON.parse(contents)).toMatchObject({
      kind: 'model',
      runs: historySearchScenarios.map(({ id }) => ({
        scenarioId: id,
        model: 'synthetic-history-model',
        prompt: { key: 'history-search-completeness', version: 1 },
        outcome: 'passed',
      })),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
