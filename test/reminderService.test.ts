import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const databasePath = join(tmpdir(), `awesome-bot-reminders-${process.pid}.db`);
process.env.DATABASE_URL = `file:${databasePath}`;

let prisma: typeof import('../src/db/client.js').prisma;
let ReminderService: typeof import('../src/services/reminders/reminderService.js').ReminderService;

before(async () => {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    stdio: 'pipe',
  });
  ({ prisma } = await import('../src/db/client.js'));
  ({ ReminderService } = await import('../src/services/reminders/reminderService.js'));
});

after(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-journal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
});

test('stale timezone clarification drafts stop intercepting ordinary chat', async () => {
  const creatorVkId = randomUUID();
  const peerId = 2_000_000_001;
  const conversationId = String(peerId);
  const reminderService = new ReminderService();
  const context = {
    senderId: creatorVkId,
    peerId,
    isChat: true,
    isBotAdmin: false,
    isConversationAdmin: async () => false,
    resolveRecipient: async () => null,
  };
  await prisma.reminderDraft.create({
    data: {
      creatorVkId,
      conversationId: String(context.peerId),
      state: 'creating',
      payload: JSON.stringify({
        sourcePeerId: String(context.peerId),
        originalText: 'Напомни завтра в 10:00 позвонить мастеру',
        missing: 'timeZone',
        isChat: true,
      }),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  assert.equal(await reminderService.shouldHandleMessage('Кстати, как дела?', context), false);
  assert.equal(await prisma.reminderDraft.count({ where: { creatorVkId } }), 0);

  await prisma.reminderDraft.create({
    data: {
      creatorVkId,
      conversationId,
      state: 'creating',
      payload: JSON.stringify({
        sourcePeerId: conversationId,
        originalText: 'Напомни завтра позвонить мастеру',
        missing: 'time',
        isChat: true,
      }),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  assert.equal(
    await reminderService.shouldHandleMessage('Кстати, как дела?', {
      ...context,
    }),
    true,
  );
});

test('only explicit reminder requests intercept messages without an active draft', async () => {
  const reminderService = new ReminderService();
  const context = {
    senderId: randomUUID(),
    peerId: 2_000_000_002,
    isChat: true,
    isBotAdmin: false,
    isConversationAdmin: async () => false,
    resolveRecipient: async () => null,
  };

  assert.equal(
    await reminderService.shouldHandleMessage(
      'В беседе обсуждали напоминание про встречу',
      context,
    ),
    false,
  );
  assert.equal(
    await reminderService.shouldHandleMessage(
      'Поставь напоминание завтра в 10:00 проверить почту',
      context,
    ),
    true,
  );
});
