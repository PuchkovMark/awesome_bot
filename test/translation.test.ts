import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTranslationRequest } from '../src/services/command/commandService.js';

test('translation defaults to Russian for supplied text', () => {
  assert.deepEqual(parseTranslationRequest('Good morning'), {
    language: 'русский',
    text: 'Good morning',
    translateOnlyNonRussianParts: false,
  });
});

test('translation preserves explicit target languages', () => {
  assert.deepEqual(parseTranslationRequest('английский: Доброе утро'), {
    language: 'английский',
    text: 'Доброе утро',
    translateOnlyNonRussianParts: false,
  });
});

test('translation of a replied message targets only non-Russian parts', () => {
  assert.deepEqual(parseTranslationRequest('', ' Привет, good morning! '), {
    language: 'русский',
    text: 'Привет, good morning!',
    translateOnlyNonRussianParts: true,
  });
});

test('translation without text or a replied message reports missing input', () => {
  assert.equal(parseTranslationRequest('  ', '  '), null);
});
