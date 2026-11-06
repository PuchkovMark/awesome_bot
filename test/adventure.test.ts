import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import adventureService from '../src/services/games/adventureService.js';

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
