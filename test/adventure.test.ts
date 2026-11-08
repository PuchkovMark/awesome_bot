import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import {
  extractJson,
  requestAdventureJson,
  default as adventureService,
} from '../src/services/games/adventureService.js';
import type { AIProvider } from '../src/services/ai/AIProvider.js';

test('adventure JSON extraction handles nested values, braces in strings and code fences', () => {
  assert.deepEqual(
    extractJson('```json\n{"scene":"Ключ {старый}","options":["A",{"next":"B"}]}\n```'),
    { scene: 'Ключ {старый}', options: ['A', { next: 'B' }] },
  );
  assert.throws(() => extractJson('ответ без JSON'), /без JSON-структуры/u);
  assert.throws(() => extractJson('{"scene":"обрыв'), /неполную JSON-структуру/u);
  assert.throws(() => extractJson('{"scene":}'), SyntaxError);
});

test('adventure retries a malformed AI JSON response once', async () => {
  const contents = ['{"scene":', '{"scene":"готово","location":"Лес","options":[]}'];
  let callCount = 0;
  const provider: AIProvider = {
    name: 'test',
    async send() {
      callCount += 1;
      return { content: contents.shift() ?? '' };
    },
  };

  assert.deepEqual(await requestAdventureJson(provider, [{ role: 'user', content: 'начни' }]), {
    scene: 'готово',
    location: 'Лес',
    options: [],
  });
  assert.equal(callCount, 2);
});

test('adventure abort removes the session without saving it to the journal', async () => {
  const conversationId = `adventure-abort-${randomUUID()}`;
  const state = {
    version: 1,
    players: [{ vkUserId: 'player-1' }, { vkUserId: 'player-2' }],
    journal: [],
    images: [],
    options: [],
    settings: {},
    hostId: 'player-1',
  };
  try {
    await prisma.conversation.create({
      data: { id: conversationId, isGroup: true },
    });
    await prisma.gameSession.create({
      data: { conversationId, game: 'ai_adventure', data: JSON.stringify(state) },
    });

    const denied = await adventureService.handleCommand(
      conversationId,
      'player-2',
      'player-2',
      true,
      'abort',
    );
    assert.match(denied.text, /только ведущий/u);
    assert.equal(await prisma.gameSession.count({ where: { conversationId } }), 1);

    const aborted = await adventureService.handleCommand(
      conversationId,
      'player-1',
      'player-1',
      true,
      'abort',
    );
    assert.equal(aborted.text, 'Приключение прекращено без сохранения.');
    assert.equal(await prisma.gameSession.count({ where: { conversationId } }), 0);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
  }
});

test('adventure vote updates are serialized and a tie opens a fresh vote', async () => {
  const conversationId = `adventure-test-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const player = (vkUserId: string) => ({
    vkUserId,
    name: vkUserId,
    characterName: vkUserId,
    description: '',
    role: 'путешественник',
    skills: [],
    health: 100,
    hunger: 0,
    thirst: 0,
    energy: 100,
    inventory: [],
    joinedAt: startedAt,
    actions: [],
  });
  const state = {
    version: 1,
    genre: 'fantasy',
    isChat: true,
    settings: {
      difficulty: 'normal',
      duration: 'normal',
      decisionMode: 'vote',
      imageMode: 'off',
      imageStyle: 'cinematic',
      imageFrequency: 3,
      randomEvents: false,
      danger: 50,
      combat: true,
      hints: true,
      horrorIntensity: 30,
      voteMinutes: 5,
      hostCanEndVote: true,
    },
    hostId: 'player-1',
    players: [player('player-1'), player('player-2')],
    turn: 1,
    title: 'Проверка голосования',
    location: 'Зал',
    scene: 'Перед вами дверь.',
    options: ['Открыть дверь', 'Осмотреть комнату'],
    summary: '',
    journal: [],
    visitedLocations: ['Зал'],
    knownClues: [],
    npcs: [],
    images: [],
    imageCount: 0,
    secret: '',
    votes: [],
    voteStartedAt: startedAt,
    ended: false,
  };
  try {
    await prisma.conversation.create({
      data: { id: conversationId, isGroup: true },
    });
    await prisma.gameSession.create({
      data: { conversationId, game: 'ai_adventure', data: JSON.stringify(state) },
    });

    const firstVote = await adventureService.submitAction(conversationId, 'player-1', '1', true);
    assert.match(firstVote?.text ?? '', /Голос учтён/u);

    const secondVote = await adventureService.submitAction(conversationId, 'player-2', '2', true);
    assert.match(secondVote?.text ?? '', /Ничья/u);

    const session = await prisma.gameSession.findFirstOrThrow({
      where: { conversationId, game: 'ai_adventure' },
    });
    const savedState = JSON.parse(session.data) as typeof state;
    assert.deepEqual(savedState.votes, []);
    assert.ok(Date.parse(savedState.voteStartedAt) >= Date.parse(startedAt));

    await prisma.gameSession.update({
      where: { id: session.id },
      data: {
        data: JSON.stringify({
          ...savedState,
          settings: { ...savedState.settings, decisionMode: 'consensus' },
        }),
      },
    });
    const firstConsensusVote = await adventureService.handleCommand(
      conversationId,
      'player-1',
      'player-1',
      true,
      'vote 1',
    );
    assert.match(firstConsensusVote.text, /решение сохранено/u);

    const conflictingConsensusVote = await adventureService.handleCommand(
      conversationId,
      'player-2',
      'player-2',
      true,
      'vote 2',
    );
    assert.match(conflictingConsensusVote.text, /разные решения/u);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
  }
});
