import { expect, test } from 'vitest';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';

const approved = `Сколько лет?
Как к тебе обращаться? (Имя или позывной?)
Работаешь или учишься?
На кого/кем?
Семейное положение: в поиске своего счастья или уже есть вторая половинка?
Сколько в ВРН?
Где любишь гулять?
Кофе или чай?
Какие хобби?
Есть любимые фильмы?
Скинь пару любимых песен.
Ты за активный отдых или лучше фильмец дома глянуть?
Как относишься к алкоголю?
50/50 на первом свидании норм?
Что ждёшь от этой конфы?
Какой MBTI? Ссылка на тест: https://www.16personalities.com/ru`.split('\n');

test('первая редакция сохраняет все утверждённые вопросы, порядок и право пропуска', () => {
  expect(legacyQuestionnaire.key).toBe('legacy-introduction');
  expect(legacyQuestionnaire.revision).toBe(1);
  expect(legacyQuestionnaire.questions).toEqual(
    approved.map((text, i) => ({ position: i + 1, text, skippable: true })),
  );
  expect(Object.isFrozen(legacyQuestionnaire)).toBe(true);
  expect(Object.isFrozen(legacyQuestionnaire.questions)).toBe(true);
  expect(legacyQuestionnaire.questions.every(Object.isFrozen)).toBe(true);
});
