import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const databasePath = join(tmpdir(), `awesome-bot-characters-${process.pid}.db`);
process.env.DATABASE_URL = `file:${databasePath}`;

let prisma: typeof import('../src/db/client.js').prisma;
let characters: typeof import('../src/services/settings/characterService.js').default;
let CharacterService: typeof import('../src/services/settings/characterService.js').CharacterService;
let memberService: typeof import('../src/services/member/memberService.js').default;
let settingsService: typeof import('../src/services/settings/settingsService.js').default;

before(async () => {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    stdio: 'pipe',
  });
  ({ prisma } = await import('../src/db/client.js'));
  ({ default: characters, CharacterService } =
    await import('../src/services/settings/characterService.js'));
  ({ default: memberService } = await import('../src/services/member/memberService.js'));
  ({ default: settingsService } = await import('../src/services/settings/settingsService.js'));
  await characters.initialize();
});

after(async () => {
  await prisma?.$disconnect();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-journal`, { force: true });
});

test('direct character and slider preferences persist independently per user and profile', async () => {
  await characters.select('direct', 'user-a', 'user-a', 'max');
  await characters.select('direct', 'user-b', 'user-b', 'joker');
  await characters.setSettings('direct', 'user-a', 'user-a', 'max', { sarcasm: 95 });

  assert.equal((await characters.getCurrent('direct', 'user-a', 'user-a')).id, 'max');
  assert.equal((await characters.getCurrent('direct', 'user-b', 'user-b')).id, 'joker');
  assert.equal((await characters.getSettings('direct', 'user-a', 'user-a', 'max')).sarcasm, 95);
  assert.notEqual(
    (await characters.getSettings('direct', 'user-b', 'user-b', 'joker')).sarcasm,
    95,
  );

  const restartedService = new CharacterService();
  assert.equal((await restartedService.getCurrent('direct', 'user-a', 'user-a')).id, 'max');
});

test('chat characters and group settings are isolated from users and other chats', async () => {
  await characters.select('chat', 'admin-a', '2000000001', 'max');
  await characters.select('chat', 'admin-b', '2000000002', 'socrates');
  await characters.setSettings('chat', 'admin-a', '2000000001', 'max', { humor: 10 });

  assert.equal((await characters.getCurrent('chat', 'member-a', '2000000001')).id, 'max');
  assert.equal((await characters.getCurrent('chat', 'member-b', '2000000002')).id, 'socrates');
  assert.equal((await characters.getSettings('chat', 'member-a', '2000000001', 'max')).humor, 10);
  assert.notEqual((await characters.getSettings('direct', 'admin-a', 'admin-a', 'max')).humor, 10);
  assert.equal(await characters.canAllMembersChange('2000000001'), false);
  await characters.setChatChangePermission('2000000001', true);
  assert.equal(await characters.canAllMembersChange('2000000001'), true);
});

test('changing a character preserves history and records a selection audit entry', async () => {
  const conversation = await prisma.conversation.upsert({
    where: { id: 'history-user' },
    create: { id: 'history-user' },
    update: {},
  });
  const user = await prisma.user.upsert({
    where: { vkId: 'history-user' },
    create: { vkId: 'history-user' },
    update: {},
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: user.id,
      role: 'user',
      content: 'keep this history',
    },
  });
  const { default: memoryService } = await import('../src/services/memory/memoryService.js');
  const sharedContext = await memoryService.getRecentChatContext(conversation.id);
  assert.equal(sharedContext[0]?.authorId, 'history-user');
  await characters.select('direct', 'history-user', 'history-user', 'victor');

  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 1);
  assert.equal(
    await prisma.personalityChange.count({
      where: { conversationId: 'history-user', scope: 'direct', toId: 'victor' },
    }),
    1,
  );
  await characters.recordUsage('victor', 'history-user', 'history-user', 'direct');
  assert.deepEqual(await characters.getUsageStats('victor'), [
    { id: 'victor', name: 'Виктор', scope: 'direct', count: 1 },
  ]);
});

test('shared chat context includes recent participant messages and bot replies in order', async () => {
  const conversationId = 'shared-chat-history';
  const conversation = await prisma.conversation.upsert({
    where: { id: conversationId },
    create: { id: conversationId, isGroup: true },
    update: {},
  });
  const firstUser = await prisma.user.upsert({
    where: { vkId: 'shared-user-1' },
    create: { vkId: 'shared-user-1', displayName: 'Аня' },
    update: { displayName: 'Аня' },
  });
  const secondUser = await prisma.user.upsert({
    where: { vkId: 'shared-user-2' },
    create: { vkId: 'shared-user-2', displayName: 'Борис' },
    update: { displayName: 'Борис' },
  });
  const now = Date.now();
  await prisma.message.createMany({
    data: [
      {
        conversationId,
        userId: firstUser.id,
        role: 'user',
        content: 'Вопрос первый',
        createdAt: new Date(now - 3000),
      },
      {
        conversationId,
        role: 'assistant',
        content: 'Ответ Пенёчка',
        createdAt: new Date(now - 2000),
      },
      {
        conversationId,
        userId: secondUser.id,
        role: 'user',
        content: 'Уточнение',
        createdAt: new Date(now - 1000),
      },
    ],
  });

  const { default: memoryService } = await import('../src/services/memory/memoryService.js');
  const sharedContext = await memoryService.getRecentChatContext(conversation.id);

  assert.deepEqual(
    sharedContext.map(({ role, speaker, authorId, content }) => ({
      role,
      speaker,
      authorId,
      content,
    })),
    [
      {
        role: 'user',
        speaker: 'Аня',
        authorId: 'shared-user-1',
        content: 'Вопрос первый',
      },
      {
        role: 'assistant',
        speaker: 'Пенёк',
        authorId: undefined,
        content: 'Ответ Пенёчка',
      },
      {
        role: 'user',
        speaker: 'Борис',
        authorId: 'shared-user-2',
        content: 'Уточнение',
      },
    ],
  );
});

test('exclusive profiles enforce access and prompt versions can be rolled back', async () => {
  await characters.createProfile(
    'private_helper',
    'Закрытый',
    'Для пользователя',
    'Пример',
    'private prompt',
    'admin',
  );
  await characters.addExclusiveAccess('private_helper', 'direct', '333111');
  await assert.rejects(
    characters.select('direct', 'other-user', 'other-user', 'private_helper'),
    /недоступен/u,
  );
  await characters.select('direct', '333111', '333111', 'private_helper');

  const original = (await characters.getProfile('max')).systemPrompt;
  await characters.updateProfile('max', { systemPrompt: 'temporary prompt' }, 'admin');
  await characters.rollbackProfile('max', 1, 'admin');
  assert.equal((await characters.getProfile('max')).systemPrompt, original);
});

test('conversation welcomes distinguish returning members and questionnaires persist to completion', async () => {
  const conversationId = '2000000399';
  const vkUserId = '900000001';
  const defaults = await settingsService.getChatSettings(conversationId);
  assert.equal(defaults.welcomeEnabled, false);
  assert.equal(defaults.questionnaireEnabled, false);

  await settingsService.updateChatSettings(conversationId, {
    welcomeEnabled: true,
    welcomeText: 'Добро пожаловать, {name}!',
    questionnaireEnabled: true,
    questionnaireQuestions: ['Как тебя зовут?', 'Что тебе интересно?'],
  });

  const firstJoin = await memberService.recordJoin(conversationId, vkUserId);
  assert.equal(firstJoin.isReturning, false);
  assert.equal(firstJoin.welcomeText, 'Добро пожаловать, {name}!');
  await memberService.recordLeave(conversationId, vkUserId);
  assert.equal((await memberService.recordJoin(conversationId, vkUserId)).isReturning, true);

  const start = await memberService.startQuestionnaire(conversationId, vkUserId);
  assert.equal(start.prompt, 'Как тебя зовут?');
  assert.equal(await memberService.hasActiveQuestionnaire(conversationId, vkUserId), true);
  assert.deepEqual(await memberService.answerQuestionnaire(conversationId, vkUserId, 'Аня'), {
    prompt: 'Что тебе интересно?',
  });
  const completed = await memberService.answerQuestionnaire(
    conversationId,
    vkUserId,
    'Книги и путешествия',
  );
  assert.match(completed.completed ?? '', /Аня/u);
  assert.match(completed.completed ?? '', /Книги и путешествия/u);
  assert.equal(await memberService.hasActiveQuestionnaire(conversationId, vkUserId), false);
  assert.match(
    (await memberService.getProfile(conversationId, vkUserId)) ?? '',
    /Что тебе интересно/u,
  );
  const profiles = await memberService.listProfiles(conversationId, 1);
  assert.equal(profiles.total, 1);
  assert.equal(profiles.profiles[0]?.vkUserId, vkUserId);
  const { CommandService } = await import('../src/services/command/commandService.js');
  const commands = new CommandService();
  assert.equal(
    await commands.handleCommand(
      'profiles',
      '',
      conversationId,
      'regular-user',
      false,
      false,
      false,
      true,
    ),
    'Эта команда доступна только администраторам.',
  );
  const listedProfiles = await commands.handleCommand(
    'profiles',
    '',
    conversationId,
    '388581097',
    true,
    false,
    true,
    true,
  );
  assert.match(listedProfiles ?? '', new RegExp(vkUserId, 'u'));
  const viewedProfile = await commands.handleCommand(
    'profile',
    `get ${vkUserId}`,
    conversationId,
    '388581097',
    true,
    false,
    true,
    true,
  );
  assert.match(viewedProfile ?? '', /Книги и путешествия/u);
  const editedProfile = await commands.handleCommand(
    'profile',
    `edit ${vkUserId} 1 Аня К.`,
    conversationId,
    '388581097',
    true,
    false,
    true,
    true,
  );
  assert.match(editedProfile ?? '', /Аня К\./u);
  const updatedProfile = await memberService.updateProfileAnswer(
    conversationId,
    vkUserId,
    1,
    'Аня К.',
  );
  assert.match(updatedProfile, /Аня К\./u);
  assert.match((await memberService.getProfile(conversationId, vkUserId)) ?? '', /Аня К\./u);
  assert.equal(await memberService.deleteProfile(conversationId, vkUserId), true);
  assert.equal(await memberService.getProfile(conversationId, vkUserId), undefined);
  assert.equal((await memberService.listProfiles(conversationId, 1)).total, 0);
});

test('creator has a higher protected role than administrators', async () => {
  const { default: settings } = await import('../src/services/settings/settingsService.js');
  assert.equal(settings.isCreator('388581097'), true);
  assert.equal(await settings.getRole('388581097'), 'creator');
  assert.equal(await settings.isAdmin('388581097'), true);

  await settings.addAdmin('test-admin');
  assert.equal(await settings.getRole('test-admin'), 'administrator');
  assert.equal(await settings.isAdmin('test-admin'), true);
  assert.equal(await settings.getRole('regular-user'), 'user');
  assert.equal(await settings.removeAdmin('388581097'), false);
  await assert.rejects(
    settings.addAdmin('388581097'),
    /Создатель не может быть назначен обычным администратором/u,
  );

  const { CommandService } = await import('../src/services/command/commandService.js');
  const commands = new CommandService();
  assert.equal(
    await commands.handleCommand('admin', 'add 888000', 'peer', 'test-admin', true, false, false),
    'Назначать администраторов может только создатель бота.',
  );
  assert.equal(await settings.getRole('888000'), 'user');
  assert.equal(
    await commands.handleCommand('admin', 'add 888000', 'peer', '388581097', true, false, true),
    'Пользователь 888000 добавлен в администраторы.',
  );
  assert.equal(await settings.getRole('888000'), 'administrator');
  assert.equal(
    await commands.handleCommand(
      'admin',
      'remove 388581097',
      'peer',
      '388581097',
      true,
      false,
      true,
    ),
    'Нельзя снять роль создателя бота.',
  );
});

test('personal sliders are DM-only and chat sliders require administrator or creator rights', async () => {
  const { CommandService } = await import('../src/services/command/commandService.js');
  const commands = new CommandService();

  assert.equal(
    await commands.handleCommand(
      'personality',
      'settings humor=80',
      '2000000010',
      'regular-user',
      false,
      false,
      false,
      true,
    ),
    'Личные настройки персонажа доступны только в личном диалоге с ботом.',
  );
  assert.equal(
    await commands.handleCommand(
      'chatpersonality',
      'settings humor=80',
      '2000000010',
      'regular-user',
      false,
      false,
      false,
      true,
    ),
    'Настройки персонажа беседы могут менять только администраторы беседы или бота.',
  );

  const creatorResult = await commands.handleCommand(
    'chatpersonality',
    'settings humor=80',
    '2000000010',
    '388581097',
    false,
    false,
    true,
    true,
  );
  assert.equal(creatorResult, 'Общие настройки персонажа Алекс сохранены для этой беседы.');
  assert.equal((await characters.getSettings('chat', 'member', '2000000010', 'alex')).humor, 80);

  const directResult = await commands.handleCommand(
    'personality',
    'settings humor=75',
    'direct-user',
    'direct-user',
  );
  assert.match(directResult ?? '', /Настройки Алекс сохранены/u);
  assert.equal(
    (await characters.getSettings('direct', 'direct-user', 'direct-user', 'alex')).humor,
    75,
  );
});
