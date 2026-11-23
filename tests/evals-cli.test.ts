import { questionnaireCases } from '../src/evals/questionnaire';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { scenarios } from '../src/evals/scenarios';

function cli(directory: string, args: string[], before = '') {
  const importHook = `data:text/javascript,${encodeURIComponent(before)}`;
  const result = spawnSync(
    process.execPath,
    ['--import', importHook, resolve('dist/evals/cli.js'), ...args],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {},
      timeout: 10_000,
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
    );
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(`Пройдено ${scenarios.length + questionnaireCases.length}`);
    const report = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
    expect(report).toMatchObject({ kind: 'local', schemaVersion: 1 });
    expect(report.runs).toHaveLength(scenarios.length + questionnaireCases.length);
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
}, 30_000);
