import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CommandService } from '../src/services/command/commandService.js';
import { prisma } from '../src/db/client.js';
import funService from '../src/services/fun/funService.js';
import { parseContextMemePlan } from '../src/services/fun/memeService.js';
import senderService from '../src/services/sender/senderService.js';

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

test('/help shows concise pages with navigation', async () => {
  const commandService = new CommandService();
  const firstPage = await commandService.handleCommand('help', '', '123', '123');
  const secondPage = await commandService.handleCommand('help', '2', '123', '123');
  const thirdPage = await commandService.handleCommand('help', '3', '123', '123');

  assert.match(firstPage ?? '', /Справка — страница 1\/4/u);
  assert.match(firstPage ?? '', /Следующая: \/help 2/u);
  assert.doesNotMatch(firstPage ?? '', /\/randomjoke/u);
  assert.match(secondPage ?? '', /Фото, документы и голос/u);
  assert.match(secondPage ?? '', /\/say \[текст\].*сообщение, на которое вы ответили/u);
  assert.match(secondPage ?? '', /Предыдущая: \/help 1/u);
  assert.match(secondPage ?? '', /Следующая: \/help 3/u);
  assert.match(thirdPage ?? '', /\/joke \[random\|VK ID\]/u);
  assert.doesNotMatch(thirdPage ?? '', /@all|\/joke \[all/u);
});

test('/admin displays paginated sections for administrators', async () => {
  const commandService = new CommandService();
  const page = await commandService.handleCommand('admin', '2', 'peer', '388581097', true);

  assert.match(page ?? '', /Панель администратора/u);
  assert.match(page ?? '', /Страница 2\/3/u);
  assert.match(page ?? '', /Анкеты участников/u);
  assert.match(page ?? '', /Предыдущая: \/admin 1/u);
  assert.match(page ?? '', /Следующая: \/admin 3/u);
});

test('help and admin menus provide callback buttons for available pages', () => {
  const helpKeyboard = JSON.parse(senderService.createMenuPaginationKeyboard('help', 2, 4)) as {
    buttons: Array<Array<{ action: { label: string; payload: string } }>>;
  };
  assert.deepEqual(
    helpKeyboard.buttons[0]?.map(({ action }) => ({
      label: action.label,
      payload: JSON.parse(action.payload),
    })),
    [
      { label: '◀ Назад', payload: { command: 'menu_page', menu: 'help', page: 1 } },
      { label: 'Далее ▶', payload: { command: 'menu_page', menu: 'help', page: 3 } },
    ],
  );

  const adminKeyboard = JSON.parse(senderService.createMenuPaginationKeyboard('admin', 1, 3)) as {
    buttons: Array<Array<{ action: { payload: string } }>>;
  };
  assert.deepEqual(JSON.parse(adminKeyboard.buttons[0]?.[0]?.action.payload ?? '{}'), {
    command: 'menu_page',
    menu: 'admin',
    page: 2,
  });
});

test('context meme plans accept valid JSON and reject malformed or incomplete responses', () => {
  assert.deepEqual(
    parseContextMemePlan(
      '```json\n{"skip":false,"topic":"общение","scene":"Чат в виде уютного кафе","caption":"Планёрка на диване"}\n```',
    ),
    {
      skip: false,
      topic: 'общение',
      scene: 'Чат в виде уютного кафе',
      caption: 'Планёрка на диване',
    },
  );
  assert.deepEqual(parseContextMemePlan('{"skip":true}'), { skip: true });
  assert.deepEqual(
    parseContextMemePlan(
      'Формат: {"type":"json"}\n{"topic":"чат","scene":"Кафе с вывеской {сюрприз}","caption":"Все на связи"}',
    ),
    {
      skip: false,
      topic: 'чат',
      scene: 'Кафе с вывеской {сюрприз}',
      caption: 'Все на связи',
    },
  );
  assert.equal(parseContextMemePlan('Не могу составить идею.'), null);
  assert.equal(parseContextMemePlan('{"skip":false,"topic":'), null);
  assert.equal(
    parseContextMemePlan(
      JSON.stringify({
        skip: false,
        topic: 'Тема',
        scene: 'Изображение',
        caption: 'x'.repeat(81),
      }),
    ),
    null,
  );
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
