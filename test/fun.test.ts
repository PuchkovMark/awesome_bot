import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CommandService } from '../src/services/command/commandService.js';
import { prisma } from '../src/db/client.js';
import funService from '../src/services/fun/funService.js';

test('/fun lists the implemented entertainment commands', async () => {
  const commandService = new CommandService();
  const menu = await commandService.handleCommand(
    'fun',
    '',
    '2000000001',
    '123',
    false,
    false,
    false,
    true,
  );

  assert.match(menu ?? '', /\/randomjoke/u);
  assert.match(menu ?? '', /\/meme/u);
  assert.match(menu ?? '', /\/battle/u);
  assert.match(menu ?? '', /\/funsettings/u);
});

test('/react asks for a message when neither a reply nor text is provided', async () => {
  const commandService = new CommandService();
  const response = await commandService.handleCommand(
    'react',
    '',
    '2000000001',
    '123',
    false,
    false,
    false,
    true,
  );

  assert.match(response ?? '', /Ответьте командой на сообщение/u);
});

test('/battle cannot be started in a direct message', async () => {
  const commandService = new CommandService();
  const response = await commandService.handleCommand(
    'battle',
    'start',
    '123',
    '123',
    false,
    false,
    false,
    false,
  );

  assert.match(response ?? '', /только в групповых беседах/u);
});

test('humor preferences persist per user and conversation', async () => {
  const vkUserId = `fun-test-${randomUUID()}`;
  const conversationId = `fun-test-${randomUUID()}`;

  try {
    const defaults = await funService.getSettings(vkUserId, conversationId);
    assert.equal(defaults.personalJokes, true);

    await funService.updateSettings(vkUserId, conversationId, {
      personalJokes: false,
      personalMemes: false,
      sarcasm: 80,
    });

    const updated = await funService.getSettings(vkUserId, conversationId);
    assert.equal(updated.personalJokes, false);
    assert.equal(updated.personalMemes, false);
    assert.equal(updated.sarcasm, 80);
    assert.equal(await funService.allowsPersonalJokes(vkUserId, conversationId), false);
  } finally {
    await prisma.funPreference.deleteMany({ where: { vkUserId, conversationId } });
  }
});
