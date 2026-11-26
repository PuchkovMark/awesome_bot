import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { EvaluationResult, GroupReplyObservation } from './types';

function modelSample({
  model,
  attempts,
  latencyMs,
  inputTokens,
  outputTokens,
  unknownInput,
  unknownOutput,
}: GroupReplyObservation['gate']) {
  return { model, attempts, latencyMs, inputTokens, outputTokens, unknownInput, unknownOutput };
}

function groupReplyRun(row: GroupReplyObservation) {
  return {
    expected: row.expected,
    decision: row.decision,
    instruction: row.instruction,
    ...(row.comparison ? { comparison: row.comparison } : {}),
    mainStartMs: row.mainStartMs,
    gate: modelSample(row.gate),
    main: modelSample(row.main),
    delivered: row.delivered,
  };
}

function groupReplySummary(results: readonly EvaluationResult[]) {
  const observed = results.flatMap(({ groupReply, outcome }) =>
    groupReply ? [{ ...groupReply, outcome }] : [],
  );
  if (!observed.length) return undefined;
  const matched = observed.filter(({ outcome }) => outcome !== 'technical_error');
  const wanted = matched.filter(({ expected }) => expected === 'answer');
  const silent = matched.filter(
    ({ expected, comparison }) => expected !== 'answer' && comparison !== 'direct',
  );
  const direct = matched.find(({ comparison }) => comparison === 'direct');
  const name = matched.find(({ comparison }) => comparison === 'name');
  return {
    examples: observed.length,
    technicalErrors: observed.length - matched.length,
    expectedAnswers: wanted.length,
    missedAnswers: wanted.filter(({ decision }) => decision !== 'answer').length,
    expectedSilences: silent.length,
    unwantedReplies: silent.filter(({ decision, delivered }) => decision === 'answer' || delivered)
      .length,
    comparison:
      direct?.mainStartMs != null && name?.mainStartMs != null
        ? {
            directMs: direct.mainStartMs,
            nameMs: name.mainStartMs,
            addedMs: name.mainStartMs - direct.mainStartMs,
            assessmentMs: name.gate.latencyMs,
          }
        : null,
  };
}

export async function writeLocalReport(
  path: string,
  results: readonly EvaluationResult[],
  now = new Date(),
  kind: 'local' | 'model' = 'local',
): Promise<void> {
  const attempts = new Map<string, number>();
  const runs = results.map(
    ({
      scenarioId,
      scenarioRevision,
      model,
      prompt,
      persona,
      outcome,
      reason,
      criteria,
      extraction,
      groupReply,
    }) => {
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
        ...(persona === undefined
          ? {}
          : {
              persona: persona && {
                area: persona.area,
                kind: persona.kind,
                key: persona.key,
                version: persona.version,
              },
            }),
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
        ...(groupReply ? { groupReply: groupReplyRun(groupReply) } : {}),
        outcome,
        reason,
        criteria: criteria.map(({ id, outcome, reason }) => ({ id, outcome, reason })),
      };
    },
  );
  const summary = groupReplySummary(results);
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    kind,
    runs,
    ...(summary ? { groupReply: summary } : {}),
  };
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
