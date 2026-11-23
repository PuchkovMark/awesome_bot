import { expect, test } from 'vitest';
import { formatGreeting } from '../src/core/greetings/text';

test('согласованные формулировки и отсутствие имени', () => {
  expect(formatGreeting({ count: 1, returning: false, name: 'Саша' })).toBe(
    'Привет, Саша! Добро пожаловать в беседу!',
  );
  expect(formatGreeting({ count: 1, returning: false })).toBe('Привет! Добро пожаловать в беседу!');
  expect(formatGreeting({ count: 1, returning: true, name: 'Саша' })).toBe('С возвращением, Саша!');
  expect(formatGreeting({ count: 1, returning: true })).toBe('С возвращением!');
  expect(formatGreeting({ count: 2, returning: true, name: 'Саша' })).toBe(
    'Всем привет! Добро пожаловать в беседу!',
  );
});

test('шаблон подставляет только доступные материалы и убирает прежнюю подстановку анкеты', () => {
  const options = {
    count: 1,
    returning: false,
    name: '{персонаж}',
    template: '{приветствие}\n{персонаж}. {правила}\n{профиль}\n{анкета}{анкета}',
    persona: 'Лесной сторож',
    rules: 'Берегите лес.',
    facts: [{ fieldKey: 'interest', value: 'шахматы' }],
  };
  const text =
    'Привет, {персонаж}! Добро пожаловать в беседу!\nЛесной сторож. Берегите лес.\ninterest: шахматы';
  expect(formatGreeting(options)).toBe(text);
  expect(formatGreeting({ ...options, template: 'x'.repeat(4000) })).toBe(
    'Привет, {персонаж}! Добро пожаловать в беседу!',
  );
});
