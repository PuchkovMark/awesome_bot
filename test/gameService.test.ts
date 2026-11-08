import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const databasePath = join(tmpdir(), `awesome-bot-games-${process.pid}.db`);
process.env.DATABASE_URL = `file:${databasePath}`;

let prisma: typeof import('../src/db/client.js').prisma;
let gameService: typeof import('../src/services/games/gameService.js').default;

before(async () => {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    stdio: 'pipe',
  });
  ({ prisma } = await import('../src/db/client.js'));
  ({ default: gameService } = await import('../src/services/games/gameService.js'));
});

after(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-journal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
});

test('game sessions persist, pause/resume timers, deduplicate events, and record results', async () => {
  const conversationId = `game-test-${randomUUID()}`;
  const userId = `game-user-${randomUUID()}`;

  try {
    const started = await gameService.start(conversationId, userId, 'association', {
      name: 'Тестовый игрок',
      settings: { rounds: 2, timeLimitSeconds: 60 },
    });
    assert.match(started, /Ассоциации/u);

    const paused = await gameService.handleNaturalMessage(
      conversationId,
      userId,
      'поставь игру на паузу',
      { eventId: 'pause-event' },
    );
    assert.match(paused ?? '', /на паузе/u);
    const session = await prisma.gameSession.findFirstOrThrow({
      where: { conversationId, game: 'association' },
    });
    const pausedState = JSON.parse(session.data) as {
      deadlineAt: number | null;
      remainingMs: number | null;
    };
    assert.equal(session.state, 'paused');
    assert.equal(pausedState.deadlineAt, null);
    assert.ok((pausedState.remainingMs ?? 0) > 0);

    assert.equal(
      await gameService.handleNaturalMessage(conversationId, userId, 'поставь игру на паузу', {
        eventId: 'pause-event',
      }),
      null,
    );
    const resumed = await gameService.handleNaturalMessage(
      conversationId,
      userId,
      'продолжай игру',
      { eventId: 'resume-event' },
    );
    assert.match(resumed ?? '', /продолжается/u);
    const active = await prisma.gameSession.findUniqueOrThrow({ where: { id: session.id } });
    const activeState = JSON.parse(active.data) as {
      deadlineAt: number | null;
      remainingMs: number | null;
    };
    assert.equal(active.state, 'active');
    assert.ok((activeState.deadlineAt ?? 0) > Date.now());
    assert.equal(activeState.remainingMs, null);

    const finished = await gameService.handleNaturalMessage(
      conversationId,
      userId,
      'заверши игру',
      { eventId: 'finish-event' },
    );
    assert.match(finished ?? '', /Игра «Ассоциации» завершена/u);
    const stats = await prisma.gamePlayerStats.findUnique({
      where: {
        scope_scopeId_vkUserId: {
          scope: 'global',
          scopeId: 'global',
          vkUserId: userId,
        },
      },
    });
    assert.equal(stats?.gamesPlayed, 1);
  } finally {
    await prisma.gameSession.deleteMany({ where: { conversationId } });
    await prisma.gamePlayerStats.deleteMany({ where: { vkUserId: userId } });
    await prisma.achievement.deleteMany({ where: { vkUserId: userId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { vkId: userId } });
  }
});
