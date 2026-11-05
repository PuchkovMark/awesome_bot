import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimitService } from '../src/services/queue/rateLimitService.js';
import { SplitterService } from '../src/services/splitter/splitterService.js';
import { DetectorService } from '../src/services/detector/detectorService.js';
import { buildBotCapabilities } from '../src/services/ai/capabilityService.js';
import {
  getSummaryHoursFromPayload,
  getSummaryHoursFromText,
  limitSentences,
} from '../src/services/command/summaryUtils.js';

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

  assert.match(capabilities, /модуль включён в конфигурации/u);
  assert.match(capabilities, /OPENAI_API_KEY/u);
});

test('summary period accepts only the 2-hour and 6-hour choices', () => {
  const detector = new DetectorService();

  assert.equal(detector.parseCommand('Пенек пересказ'), 'summary');
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
