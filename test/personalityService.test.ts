import assert from 'node:assert/strict';
import { test } from 'node:test';
import characterService from '../src/services/settings/characterService.js';
import {
  isPersonalityId,
  isRetiredPersonalityId,
  normalizePersonalityId,
  personalities,
} from '../src/services/settings/personalityService.js';

test('the built-in character catalog contains Nikon instead of Joker', () => {
  assert.ok(personalities.nikon);
  assert.equal(personalities.joker, undefined);
  assert.equal(Object.keys(personalities).length, 6);
  assert.equal(isPersonalityId('nikon'), true);
  assert.equal(isPersonalityId('joker'), false);
  assert.equal(personalities.nikon.influences.formality, 100);
  assert.equal(personalities.nikon.settings.emoji, 0);
});

test('Joker, funny and gamer are retired and do not resolve through legacy aliases', () => {
  for (const id of ['joker', 'funny', 'gamer']) {
    assert.equal(normalizePersonalityId(id), id);
    assert.equal(isPersonalityId(id), false);
    assert.equal(isRetiredPersonalityId(id), true);
  }
});

test('unrelated legacy aliases keep working', () => {
  assert.equal(normalizePersonalityId('friendly'), 'alex');
  assert.equal(normalizePersonalityId('sarcastic'), 'max');
  assert.equal(normalizePersonalityId('philosopher'), 'socrates');
  assert.equal(normalizePersonalityId('consultant'), 'victor');
  assert.equal(normalizePersonalityId('default'), 'chipsik');
});

test('retired personality IDs cannot be recreated by admins', async () => {
  await assert.rejects(
    () =>
      characterService.createProfile(
        'joker',
        'Джокер',
        'Описание',
        'Пример',
        'Системная инструкция',
        'test',
      ),
    /удалён и зарезервирован/u,
  );
});
