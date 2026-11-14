import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TEXT_MODEL,
  normalizeTextModel,
  reasoningEffortForModel,
  resolveTextModel,
  TEXT_MODELS,
  textModelLabel,
} from '../src/services/ai/textModels.js';

test('text models normalize aliases and fall back to DeepSeek', () => {
  assert.equal(DEFAULT_TEXT_MODEL, 'deepseek-v4.1-flash');
  assert.equal(normalizeTextModel('deepseek'), 'deepseek-v4.1-flash');
  assert.equal(normalizeTextModel('дипсик'), 'deepseek-v4.1-flash');
  assert.equal(normalizeTextModel('argon'), 'gemini-4-argon');
  assert.equal(normalizeTextModel('аргон'), 'gemini-4-argon');
  assert.equal(normalizeTextModel('unknown'), undefined);
  assert.equal(resolveTextModel(undefined, ''), 'deepseek-v4.1-flash');
  assert.equal(resolveTextModel('unknown', 'gemini-4-argon'), 'gemini-4-argon');
  assert.equal(resolveTextModel(undefined, 'custom-model'), 'custom-model');
  assert.equal(resolveTextModel('argon', 'deepseek-v4.1-flash'), 'gemini-4-argon');
  assert.equal(TEXT_MODELS.length, 2);
  assert.equal(textModelLabel('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
});

test('DeepSeek high effort maps to the model maximum', () => {
  assert.equal(reasoningEffortForModel('deepseek-v4.1-flash', 'low'), 'low');
  assert.equal(reasoningEffortForModel('deepseek-v4.1-flash', 'medium'), 'high');
  assert.equal(reasoningEffortForModel('deepseek-v4.1-flash', 'high'), 'max');
});

test('Argon keeps the standard reasoning effort values', () => {
  assert.equal(reasoningEffortForModel('gemini-4-argon', 'low'), 'low');
  assert.equal(reasoningEffortForModel('gemini-4-argon', 'medium'), 'medium');
  assert.equal(reasoningEffortForModel('gemini-4-argon', 'high'), 'high');
});
