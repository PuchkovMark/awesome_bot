import { assessQuestionnaire, questionnaireCases } from './questionnaire';
import { lstat, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLlmClient } from '../llm/index';
import { groupReplyModel } from '../core/message-router/group-reply-gate';
import { groupReplyScenarios } from './group-reply-gate';
import { runProfileUpdateMocks, runProfileUpdateModel } from './profile-updates';
import { formatVkChecklist } from './checklist';
import { writeLocalReport } from './report';
import { runLocalChatSummary, runScenario } from './runner';
import { historySearchScenarios, scenarios } from './scenarios';
import type { EvaluationResult } from './types';

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--checklist') {
    process.stdout.write(formatVkChecklist(scenarios));
    return 0;
  }
  const profileModel = args[0] === '--profile-model';
  const historyModel = args[0] === '--history-model';
  const groupReplyRun = args[0] === '--group-reply-gate-model';
  const modelRun = profileModel || historyModel || groupReplyRun;
  const single = profileModel && args[1] === '--case';
  const caseId = single ? args[2] : undefined;
  const [flag, output, ...extra] = modelRun ? args.slice(single ? 3 : 1) : args;
  if (extra.length || flag !== '--out' || !output?.trim() || output.startsWith('--')) {
    process.stderr.write(
      'Укажите --out <новый файл JSON>, --profile-model [--case <сценарий>] --out <новый файл JSON>, --history-model --out <новый файл JSON>, --group-reply-gate-model --out <новый файл JSON> или --checklist.\n',
    );
    return 1;
  }
  try {
    await lstat(output);
    process.stderr.write('Файл отчёта уже существует.\n');
    return 1;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      process.stderr.write('Не удалось сохранить отчёт по указанному пути.\n');
      return 1;
    }
  }
  try {
    if (!(await stat(dirname(output))).isDirectory()) throw Error('report_directory');
  } catch {
    process.stderr.write('Не удалось сохранить отчёт по указанному пути.\n');
    return 1;
  }

  let results: EvaluationResult[] = [];
  if (modelRun) {
    const { LLM_MODEL: model, OPENCODE_API_KEY: apiKey } = process.env;
    try {
      if (!model || !apiKey) throw Error('model_eval_config');
      const client = createLlmClient({ provider: 'opencode', apiKey, model });
      if (profileModel) results = await runProfileUpdateModel(client, model, caseId);
      else if (groupReplyRun) {
        const groupReplyClient = createLlmClient({
          provider: 'opencode',
          apiKey,
          model: groupReplyModel,
        });
        for (const scenario of groupReplyScenarios)
          results.push(
            await runScenario(scenario, client, {
              modelName: model,
              timeoutMs: 60_000,
              groupReplyClient,
            }),
          );
      } else
        for (const scenario of historySearchScenarios)
          results.push(
            await runScenario(scenario, client, { modelName: model, timeoutMs: 60_000 }),
          );
    } catch {
      process.stderr.write(
        'Не удалось выполнить оценку модели. Проверьте настройки и лимит прогона.\n',
      );
      return 1;
    }
  } else {
    for (const scenario of scenarios) results.push(await runScenario(scenario));
    for (const sample of questionnaireCases)
      results.push(assessQuestionnaire(sample, sample.mockOutput));
    results.push(...runProfileUpdateMocks(), await runLocalChatSummary());
  }
  try {
    await writeLocalReport(output, results, new Date(), modelRun ? 'model' : 'local');
  } catch (error) {
    const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
    process.stderr.write(
      exists ? 'Файл отчёта уже существует.\n' : 'Не удалось сохранить отчёт по указанному пути.\n',
    );
    return 1;
  }
  const passed = results.filter((result) => result.outcome === 'passed').length;
  const failed = results.filter((result) => result.outcome === 'failed').length;
  process.stdout.write(
    `${modelRun ? 'Оценка модели на синтетических репликах' : 'Локальная оценка на подменах'}. Пройдено ${passed}, нарушений ${failed}, технических сбоев ${results.length - passed - failed}.\n`,
  );
  return passed === results.length ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
