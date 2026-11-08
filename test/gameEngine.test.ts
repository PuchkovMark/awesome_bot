import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectGameStartRequest,
  gameModes,
  parseGameAction,
  parseGameKind,
  parseGameStartOptions,
  parseGeneratedQuestion,
  pointsForCorrectAnswer,
  settingsForDifficulty,
} from '../src/services/games/gameEngine.js';

test('all interactive game modes have launchable aliases', () => {
  assert.equal(Object.keys(gameModes).length, 10);
  for (const mode of Object.values(gameModes)) {
    for (const alias of mode.aliases) assert.equal(parseGameKind(alias), mode.id);
  }
});

test('natural game requests retain supported settings', () => {
  const request = detectGameStartRequest(
    'Давай сыграем в викторину на тему истории, сложный уровень, 3 раунда',
  );
  assert.ok(request);
  assert.equal(request.kind, 'quiz');
  assert.equal(request.settings.difficulty, 3);
  assert.equal(request.settings.rounds, 3);
  assert.equal(request.settings.category, 'истории');
  assert.equal(detectGameStartRequest('Пенёк, угадай песню').kind, 'songfilm');
  assert.equal(detectGameStartRequest('Давай обсудим, кто только что вступил в беседу'), null);
  assert.equal(detectGameStartRequest('Давай сыграем в кто вероятнее всего')?.kind, 'who');
  assert.equal(detectGameStartRequest('Пенёк, давай викторину', false), null);
});

test('game actions recognize natural-language controls', () => {
  assert.deepEqual(parseGameAction('Сделай игру сложнее'), {
    type: 'change-difficulty',
    difficulty: 3,
  });
  assert.deepEqual(parseGameAction('давай теперь лёгкие вопросы'), {
    type: 'change-difficulty',
    difficulty: 1,
  });
  assert.deepEqual(parseGameAction('поставь игру на паузу'), { type: 'pause' });
  assert.deepEqual(parseGameAction('продолжай игру'), { type: 'resume' });
  assert.deepEqual(parseGameAction('пропустить вопрос'), { type: 'skip' });
  assert.deepEqual(parseGameAction('присоединиться'), { type: 'join' });
  assert.deepEqual(parseGameAction('за'), { type: 'vote-difficulty', direction: 'up' });
  assert.equal(parseGameAction('это сложный вопрос'), null);
  assert.deepEqual(parseGameAction('измени сложность на 4'), {
    type: 'change-difficulty',
    difficulty: 4,
  });
  assert.deepEqual(parseGameAction('передаю ход'), { type: 'pass' });
  assert.deepEqual(parseGameAction('назначь капитаном 123'), { type: 'captain' });
});

test('difficulty settings are bounded and adjust time, hints, attempts, and score', () => {
  const easy = settingsForDifficulty(1, { rounds: 99, maxParticipants: 0 });
  const expert = settingsForDifficulty(4);
  assert.equal(easy.rounds, 20);
  assert.equal(easy.maxParticipants, 1);
  assert.ok(easy.timeLimitSeconds > expert.timeLimitSeconds);
  assert.ok(easy.hintsPerRound > expert.hintsPerRound);
  assert.ok(easy.attemptsPerPlayer > expert.attemptsPerPlayer);
  assert.ok(pointsForCorrectAnswer(4, 1, 0, 0) > pointsForCorrectAnswer(1, 0, 0, 0));
  assert.ok(pointsForCorrectAnswer(2, 0, 2, 0) < pointsForCorrectAnswer(2, 0, 0, 0));
  assert.deepEqual(parseGameStartOptions('rounds 4 players 8 team time 30 hints 1 attempts 2'), {
    rounds: 4,
    maxParticipants: 8,
    timeLimitSeconds: 30,
    hintsPerRound: 1,
    attemptsPerPlayer: 2,
    playMode: 'team',
  });
});

test('generated questions reject answer leakage and repeated prompts', () => {
  const valid = parseGeneratedQuestion(
    JSON.stringify({
      text: 'Как называется столица Франции?',
      answers: ['Париж'],
      hints: ['Город на Сене'],
    }),
    'география',
    [],
  );
  assert.equal(valid.category, 'география');
  assert.deepEqual(valid.answers, ['париж']);

  const multipleChoice = parseGeneratedQuestion(
    JSON.stringify({
      text: 'Как называется столица Франции?',
      answers: ['Париж'],
      choices: ['Рим', 'Париж', 'Осло', 'Прага'],
      hints: [],
    }),
    'география',
    [],
  );
  assert.equal(multipleChoice.choices?.length, 4);
  assert.throws(() =>
    parseGeneratedQuestion(
      JSON.stringify({
        text: 'Как называется столица Франции?',
        answers: ['Париж'],
        choices: ['Рим', 'Осло', 'Прага', 'Берлин'],
        hints: [],
      }),
      'география',
      [],
    ),
  );

  assert.throws(() =>
    parseGeneratedQuestion(
      JSON.stringify({ text: 'Ответ — Париж. Какой это город?', answers: ['Париж'], hints: [] }),
      'география',
      [],
    ),
  );
  assert.throws(() =>
    parseGeneratedQuestion(
      JSON.stringify({ text: 'Как называется столица Франции?', answers: ['Париж'], hints: [] }),
      'география',
      ['Как называется столица Франции?'],
    ),
  );
});
