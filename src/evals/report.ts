import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { EvaluationResult } from './types';

export async function writeLocalReport(
  path: string,
  results: readonly EvaluationResult[],
  now = new Date(),
  kind: 'local' | 'model' = 'local',
): Promise<void> {
  const attempts = new Map<string, number>();
  const runs = results.map(
    ({ scenarioId, scenarioRevision, model, prompt, outcome, reason, criteria, extraction }) => {
      const key = `${scenarioId}:${scenarioRevision}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      return {
        scenarioId,
        scenarioRevision,
        attempt,
        model,
        prompt: prompt && {
          area: prompt.area,
          kind: prompt.kind,
          key: prompt.key,
          version: prompt.version,
        },
        ...(extraction
          ? {
              extraction: {
                requestRevision: extraction.requestRevision,
                inputEstimate: extraction.inputEstimate,
                outputReserve: extraction.outputReserve,
                inputTokens: extraction.inputTokens,
                outputTokens: extraction.outputTokens,
              },
            }
          : {}),
        outcome,
        reason,
        criteria: criteria.map(({ id, outcome, reason }) => ({ id, outcome, reason })),
      };
    },
  );
  const report = { schemaVersion: 1, generatedAt: now.toISOString(), kind, runs };
  const target = resolve(path);
  const temporary = await mkdtemp(join(dirname(target), '.eval-report-'));
  try {
    const staged = join(temporary, 'report.json');
    await writeFile(staged, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    // Публикация в том же каталоге целиком, с отказом при занятом пути.
    await link(staged, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
