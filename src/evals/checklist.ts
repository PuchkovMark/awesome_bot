import type { Scenario } from './types.js';

export function formatVkChecklist(scenarios: readonly Scenario[]): string {
  const lines = [
    '# Ручная оценка в тестовом сообществе VK', '',
    'Запускайте после подключения бота в F3.5 и разрешённой проверки провайдера.',
    'Согласуйте модель, синтетические данные, число попыток, критерии и предел расходов.',
    'Для каждого повтора запишите идентификатор, ревизию, модель, версию тестового промпта и исходы критериев.',
    'Если состояние или наблюдение недоступно, укажите «не проверен» и причину.', '',
  ];
  for (const scenario of scenarios) {
    lines.push(`## ${scenario.title} — ${scenario.id} (ревизия ${scenario.revision})`, '',
      `Выберите тестовый промпт: «${scenario.prompt}»`, '');
    scenario.vkSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push('', 'Критерии для отчёта', '');
    for (const criterion of scenario.criteria) {
      lines.push(`- ${criterion.id} — ${criterion.vk ?? 'Проверяется локально по снимку запроса.'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
