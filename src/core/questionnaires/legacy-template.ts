import type { QuestionnaireQuestion, QuestionnaireTemplate } from '../../contracts/questionnaire';

export function questionnaireQuestions(lines: readonly string[]): readonly QuestionnaireQuestion[] {
  return Object.freeze(
    lines.map((text, index) =>
      Object.freeze({ position: index + 1, text, skippable: true as const }),
    ),
  );
}

export const legacyQuestionnaire: QuestionnaireTemplate = Object.freeze({
  key: 'legacy-introduction',
  revision: 1,
  questions: questionnaireQuestions([
    'Сколько лет?',
    'Как к тебе обращаться? (Имя или позывной?)',
    'Работаешь или учишься?',
    'На кого/кем?',
    'Семейное положение: в поиске своего счастья или уже есть вторая половинка?',
    'Сколько в ВРН?',
    'Где любишь гулять?',
    'Кофе или чай?',
    'Какие хобби?',
    'Есть любимые фильмы?',
    'Скинь пару любимых песен.',
    'Ты за активный отдых или лучше фильмец дома глянуть?',
    'Как относишься к алкоголю?',
    '50/50 на первом свидании норм?',
    'Что ждёшь от этой конфы?',
    'Какой MBTI? Ссылка на тест: https://www.16personalities.com/ru',
  ]),
});
