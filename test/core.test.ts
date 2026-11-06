import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimitService } from '../src/services/queue/rateLimitService.js';
import { SplitterService } from '../src/services/splitter/splitterService.js';
import { DetectorService } from '../src/services/detector/detectorService.js';
import { buildBotCapabilities } from '../src/services/ai/capabilityService.js';
import {
  buildRiddlePrompt,
  changeRiddleDifficulty,
  getRiddleDifficulty,
  getRiddleDifficultyLabel,
  normalizeGameAnswer,
  parseGeneratedRiddle,
} from '../src/services/games/riddleGeneration.js';
import {
  getSummaryHoursFromPayload,
  getSummaryHoursFromText,
  limitSentences,
} from '../src/services/command/summaryUtils.js';
import {
  buildPersonalityInstructions,
  isPersonalityId,
  normalizePersonalityId,
  personalities,
  validatePersonalitySettings,
} from '../src/services/settings/personalityService.js';
import {
  parseQuestionnaireQuestions,
  parseStoredQuestionnaireQuestions,
} from '../src/services/member/memberService.js';

test('message splitter preserves content and respects UTF-16 boundaries', () => {
  const text = 'первая строка\n' + 'слово '.repeat(15) + '😀 конец';
  const parts = new SplitterService(20).split(text);

  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => part.length <= 20));
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/u.test(part)));
});

test('rate limiter isolates users and reports when the window expires', () => {
  const limiter = new RateLimitService(2, 60_000);

  assert.equal(limiter.take('user-a', 1_000).allowed, true);
  assert.equal(limiter.take('user-a', 2_000).allowed, true);
  const limited = limiter.take('user-a', 3_000);
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterMs, 58_000);
  assert.equal(limiter.take('user-b', 3_000).allowed, true);
  assert.equal(limiter.take('user-a', 61_000).allowed, true);
});

test('active chat mode recognizes Russian requests without matching word fragments', () => {
  const detector = new DetectorService();

  assert.equal(detector.isActiveEvent('Пенек, помоги с задачей'), true);
  assert.equal(detector.isActiveEvent('посоветуй хороший фильм'), true);
  assert.equal(detector.isActiveEvent('это не вопросительный фрагмент'), false);
  assert.equal(detector.isActiveEvent('ты где?'), true);
  assert.equal(detector.isMentioned('Бот, привет'), false);
  assert.equal(detector.isMentioned('Пенёк, привет'), true);
  assert.equal(detector.isMentioned('пенечек привет'), true);
  assert.equal(detector.isAddressed('Бот, помоги с задачей'), false);
  assert.equal(detector.isActiveEvent('Бот, помоги с задачей'), false);
  assert.equal(detector.isAddressed('Пенёк, помоги с задачей'), true);
});

test('AI receives the current bot capabilities and access restrictions', () => {
  const capabilities = buildBotCapabilities({
    isAdmin: false,
    imageAccess: 'admins_only',
    chatMode: 'normal',
    personalityName: 'Дружелюбный помощник',
    personalityIds: ['friendly', 'funny', 'sarcastic'],
    provider: 'openai',
    voiceEnabledForUser: false,
  });

  assert.match(capabilities, /реальные возможности/u);
  assert.match(capabilities, /для этого пользователя ограничены администраторами/u);
  assert.match(capabilities, /режим normal/u);
  assert.match(capabilities, /Веб-поиск:/u);
  assert.match(capabilities, /Не заявляй о не реализованных возможностях/u);
  assert.match(capabilities, /Mark Puchkov \(VK ID 388581097\)/u);
});

test('AI distinguishes enabled voice feature from a missing provider key', () => {
  const capabilities = buildBotCapabilities({
    isAdmin: false,
    imageAccess: 'admins_only',
    chatMode: 'normal',
    personalityName: 'Дружелюбный помощник',
    personalityIds: ['friendly'],
    provider: 'openai',
    voiceEnabledForUser: false,
  });

  test('built-in AI characters have distinct prompts and retain legacy aliases', () => {
    assert.deepEqual(Object.keys(personalities).sort(), [
      'alex',
      'joker',
      'max',
      'socrates',
      'victor',
    ]);
    assert.equal(
      new Set(Object.values(personalities).map(({ systemPrompt }) => systemPrompt)).size,
      5,
    );
    assert.equal(normalizePersonalityId('friendly'), 'alex');
    assert.equal(normalizePersonalityId('sarcastic'), 'max');
    assert.equal(normalizePersonalityId('gamer'), 'joker');
    assert.equal(isPersonalityId('socrates'), true);
    assert.equal(personalities.alex.settings.length, 20);
    assert.equal(personalities.alex.settings.detail, 35);
    assert.equal(personalities.alex.settings.formality, 10);
    assert.match(personalities.alex.systemPrompt, /без лишних любезностей/u);
  });

  test('character sliders validate their range and are weighted by character', () => {
    assert.deepEqual(validatePersonalitySettings({ humor: 80, emoji: 0 }), { humor: 80, emoji: 0 });
    assert.throws(() => validatePersonalitySettings({ sarcasm: 101 }), /от 0 до 100/u);
    assert.throws(() => validatePersonalitySettings({ unknown: 20 }), /Неизвестная настройка/u);

    const maxPrompt = buildPersonalityInstructions(personalities.max, { sarcasm: 100 });
    const victorPrompt = buildPersonalityInstructions(personalities.victor, { sarcasm: 100 });
    assert.match(maxPrompt, /сарказм: 100%/u);
    assert.doesNotMatch(victorPrompt, /сарказм:/u);
  });

  assert.match(capabilities, /модуль включён в конфигурации/u);
  assert.match(capabilities, /OPENAI_API_KEY/u);
});

test('summary period accepts only the 2-hour and 6-hour choices', () => {
  const detector = new DetectorService();

  assert.equal(detector.parseCommand('Пенек пересказ'), 'summary');
  assert.equal(detector.parseCommand('Бот пересказ'), null);
  assert.equal(detector.parseCommand('Пенечек пересказ'), 'summary');
  assert.equal(detector.parseCommand('/summary'), 'summary');
  assert.equal(getSummaryHoursFromPayload({ command: 'summary', hours: 2 }), 2);
  assert.equal(getSummaryHoursFromPayload('{"command":"summary","hours":6}'), 6);
  assert.equal(getSummaryHoursFromPayload({ command: 'provider', hours: 6 }), null);
  assert.equal(getSummaryHoursFromPayload({ command: 'summary', hours: 24 }), null);
  assert.equal(getSummaryHoursFromText('/summary за 6 часов'), 6);
  assert.equal(getSummaryHoursFromText('За 2 часа'), 2);
  assert.equal(getSummaryHoursFromText('/summary'), null);
});

test('summary output is capped at ten complete sentences', () => {
  const text = Array.from({ length: 12 }, (_, index) => `Предложение ${index + 1}.`).join(' ');
  const summary = limitSentences(text, 10);

  assert.equal(
    summary,
    Array.from({ length: 10 }, (_, index) => `Предложение ${index + 1}.`).join(' '),
  );
  assert.equal(
    Array.from(new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(summary)).length,
    10,
  );
});

test('AI-generated riddles are validated and keep the selected difficulty', () => {
  const generated = parseGeneratedRiddle(
    '{"text":"Что можно увидеть с закрытыми глазами?","answers":["сон","сновидение"]}',
    3,
  );
  assert.deepEqual(generated, {
    text: 'Что можно увидеть с закрытыми глазами?',
    answers: ['сон', 'сновидение'],
    difficulty: 3,
  });
  assert.throws(() => parseGeneratedRiddle('not json', 3), /invalid riddle JSON/u);
  assert.throws(
    () => parseGeneratedRiddle('{"text":"Коротко","answers":["ответ"]}', 3),
    /invalid text or answers/u,
  );
});

test('riddle difficulty changes within supported bounds and guides generation', () => {
  assert.equal(changeRiddleDifficulty(2, 1), 3);
  assert.equal(changeRiddleDifficulty(1, -1), 1);
  assert.equal(changeRiddleDifficulty(5, 1), 5);
  assert.equal(getRiddleDifficulty(4), 4);
  assert.equal(getRiddleDifficulty('4'), 2);
  assert.equal(getRiddleDifficultyLabel(3), 'средняя');
  assert.match(buildRiddlePrompt(5, ['Старая загадка']), /Сложность 5\/5/u);
  assert.match(buildRiddlePrompt(5, ['Старая загадка']), /Старая загадка/u);
  assert.equal(normalizeGameAnswer('  Ёж!  '), 'еж');
});

test('questionnaire configuration validates question count, length, and persisted JSON', () => {
  assert.deepEqual(parseQuestionnaireQuestions('Как зовут? | Чем увлекаешься?'), [
    'Как зовут?',
    'Чем увлекаешься?',
  ]);
  assert.throws(() => parseQuestionnaireQuestions(' | '), /от 1 до 8 вопросов/u);
  assert.throws(
    () => parseQuestionnaireQuestions(Array(9).fill('Вопрос').join('|')),
    /от 1 до 8 вопросов/u,
  );
  assert.throws(() => parseQuestionnaireQuestions('x'.repeat(201)), /не длиннее 200 символов/u);
  assert.deepEqual(parseStoredQuestionnaireQuestions('["Вопрос?"]'), ['Вопрос?']);
  assert.throws(() => parseStoredQuestionnaireQuestions('not json'), /Не удалось прочитать/u);
});
