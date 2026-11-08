import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THINKING_MODE,
  parseThinkingMode,
  thinkingModes,
} from '../src/services/ai/thinkingMode.js';

test('thinking modes select the configured OpenCode models and default to low', () => {
  assert.equal(DEFAULT_THINKING_MODE, 'low');
  assert.deepEqual(thinkingModes, {
    low: { label: 'низкий', model: 'deepseek-v4.1-flash' },
    medium: { label: 'средний', model: 'claude-haiku-5-5' },
    max: { label: 'максимальный', model: 'gemini-4-argon' },
  });
});

test('thinking mode accepts Russian labels and rejects unsupported values', () => {
  assert.equal(parseThinkingMode('низкий'), 'low');
  assert.equal(parseThinkingMode('medium'), 'medium');
  assert.equal(parseThinkingMode('МАКСИМАЛЬНЫЙ'), 'max');
  assert.equal(parseThinkingMode('high'), null);
});
