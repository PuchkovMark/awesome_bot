import { expect, test } from 'vitest';
import { chatLimits } from '../src/core/chat-limits/config';

test('лимиты используют утверждённые значения и снимок конфигурации', () => {
  expect(chatLimits()).toEqual({
    userRequests: 3, userWindowMs: 60_000, chatRequests: 10, chatWindowMs: 60_000,
    autonomousPerHour: 2, autonomousPerDay: 6, autonomousIntervalMs: 1_200_000,
  });
  const input = { userRequests: 1 };
  const limits = chatLimits(input);
  input.userRequests = 2;
  expect(limits.userRequests).toBe(1);
  expect(Object.isFrozen(limits)).toBe(true);
});

test.each([{ userRequests: 0 }, { chatRequests: 1.5 }, { chatWindowMs: Infinity },
  { autonomousIntervalMs: Number.MAX_SAFE_INTEGER }, { unknown: 1 }])('отклоняет недопустимые настройки %j', input => {
  expect(() => chatLimits(input as Parameters<typeof chatLimits>[0])).toThrow('invalid_configuration');
});
