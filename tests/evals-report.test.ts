import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeLocalReport } from '../src/evals/report';
import { runScenario } from '../src/evals/runner';
import { scenarios } from '../src/evals/scenarios';

test('отчёт сохраняет метаданные и каждый повтор, исходный файл защищён от перезаписи', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'awesome-eval-report-'));
  try {
    const output = join(directory, 'report.json');
    const result = await runScenario(scenarios[0]!, { async complete() {
      return { kind: 'error', code: 'network', message: 'PRIVATE_PROVIDER_TEXT' };
    } });
    const source = {
      ...result, raw: 'PRIVATE_CONTEXT',
      prompt: { ...result.prompt!, text: 'PRIVATE_PROMPT' },
      criteria: result.criteria.map(criterion => ({ ...criterion, details: 'PRIVATE_CRITERION' })),
    };
    const timestamp = new Date('2026-11-22T09:00:00+03:00');
    await writeLocalReport(output, [source, source], timestamp);
    const contents = await readFile(output, 'utf8');
    const record = { ...result, attempt: 1 };
    expect(JSON.parse(contents)).toEqual({
      schemaVersion: 1, generatedAt: '2026-11-22T06:00:00.000Z', kind: 'local',
      runs: [record, { ...record, attempt: 2 }],
    });
    expect(result.reason).toBe('network');
    expect(contents).not.toMatch(/PRIVATE_/);
    await expect(writeLocalReport(output, [])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe(contents);
    expect(await readdir(directory)).toEqual(['report.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
