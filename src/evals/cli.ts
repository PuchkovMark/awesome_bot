import { formatVkChecklist } from './checklist.js';
import { writeLocalReport } from './report.js';
import { runScenario } from './runner.js';
import { scenarios } from './scenarios.js';
import type { EvaluationResult } from './types.js';

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--checklist') {
    process.stdout.write(formatVkChecklist(scenarios));
    return 0;
  }
  const output = args[1];
  if (args.length !== 2 || args[0] !== '--out' || !output?.trim() || output.startsWith('--')) {
    process.stderr.write('Укажите --out <новый файл JSON> или --checklist.\n');
    return 1;
  }

  const results: EvaluationResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario));
  try {
    await writeLocalReport(output, results);
  } catch (error) {
    const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
    process.stderr.write(exists ? 'Файл отчёта уже существует.\n' : 'Не удалось сохранить отчёт по указанному пути.\n');
    return 1;
  }
  const passed = results.filter(result => result.outcome === 'passed').length;
  const failed = results.filter(result => result.outcome === 'failed').length;
  process.stdout.write(`Локальная оценка на подменах. Пройдено ${passed}, нарушений ${failed}, технических сбоев ${results.length - passed - failed}.\n`);
  return passed === results.length ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
