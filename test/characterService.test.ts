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
let formatProfileIntroduction: typeof import('../src/services/member/memberService.js').formatProfileIntroduction;
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
  ({ default: memberService, formatProfileIntroduction } =
    await import('../src/services/member/memberService.js'));
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

test('new direct messages and chats use the default Chipsik character', async () => {
  assert.equal(await characters.getDefaultPersonalityId(), 'chipsik');
  assert.equal(
    (await characters.getCurrent('direct', 'default-user', 'default-user')).id,
    'chipsik',
  );
  assert.equal((await characters.getCurrent('chat', 'default-user', '2000000020')).id, 'chipsik');
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

test('proposal history lookup finds the speaker beyond the recent chat context', async () => {
  const conversationId = 'proposal-history-recall';
  await prisma.conversation.upsert({
    where: { id: conversationId },
    create: { id: conversationId, isGroup: true },
    update: {},
  });
  const proposer = await prisma.user.upsert({
    where: { vkId: 'proposal-user' },
    create: { vkId: 'proposal-user', displayName: 'Ирина' },
    update: { displayName: 'Ирина' },
  });
  const other = await prisma.user.upsert({
    where: { vkId: 'proposal-other' },
    create: { vkId: 'proposal-other', displayName: 'Олег' },
    update: { displayName: 'Олег' },
  });
  const now = Date.now();
  await prisma.message.createMany({
    data: [
      {
        conversationId,
        userId: proposer.id,
        role: 'user',
        content: 'Предлагаю поехать в Казань.',
        createdAt: new Date(now - 20 * 60_000),
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        conversationId,
        userId: other.id,
        role: 'user',
        content: `Обсуждение поездки, сообщение ${index + 1}.`,
        createdAt: new Date(now - (10 - index) * 60_000),
      })),
    ],
  });

  const { default: memoryService } = await import('../src/services/memory/memoryService.js');
  const recalled = await memoryService.getProposalHistoryForQuestion(
    conversationId,
    'А кто вообще это предложил?',
  );
  assert.deepEqual(
    recalled?.map(({ speaker, authorId, content }) => ({ speaker, authorId, content })),
    [{ speaker: 'Ирина', authorId: 'proposal-user', content: 'Предлагаю поехать в Казань.' }],
  );
  assert.equal(
    await memoryService.getProposalHistoryForQuestion(conversationId, 'Что сейчас обсуждаем?'),
    undefined,
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
  const defaultQuestions: unknown = JSON.parse(defaults.questionnaireQuestions);
  assert.equal(Array.isArray(defaultQuestions) ? defaultQuestions.length : 0, 16);

  const disabledConversation = '2000000397';
  await settingsService.getChatSettings(disabledConversation);
  assert.equal(
    (
      await memberService.recordJoin(
        disabledConversation,
        '900000002',
        `${disabledConversation}:join-off-1`,
      )
    ).shouldInviteQuestionnaire,
    false,
  );
  const manualQuestionnaire = await memberService.startQuestionnaire(
    disabledConversation,
    '900000002',
  );
  assert.match(manualQuestionnaire.prompt, /1\./u);
  await memberService.cancelQuestionnaire(disabledConversation, '900000002');
  await settingsService.updateChatSettings(disabledConversation, { questionnaireEnabled: true });
  assert.equal(
    (
      await memberService.recordJoin(
        disabledConversation,
        '900000002',
        `${disabledConversation}:join-on-1`,
      )
    ).shouldInviteQuestionnaire,
    true,
  );
  assert.equal(
    (
      await memberService.recordJoin(
        disabledConversation,
        '900000002',
        `${disabledConversation}:join-on-1`,
      )
    ).shouldInviteQuestionnaire,
    false,
  );
  await memberService.recordLeave(disabledConversation, '900000002');
  assert.equal(
    (
      await memberService.recordJoin(
        disabledConversation,
        '900000002',
        `${disabledConversation}:join-on-2`,
      )
    ).shouldInviteQuestionnaire,
    true,
  );

  await settingsService.updateChatSettings(conversationId, {
    welcomeEnabled: true,
    welcomeText: 'Добро пожаловать, {name}!',
    questionnaireEnabled: true,
    questionnaireQuestions: ['Как тебя зовут?', 'Что тебе интересно?'],
  });

  const { CommandService } = await import('../src/services/command/commandService.js');
  const questionnaireCommands = new CommandService();
  const questionnaireStatus = await questionnaireCommands.handleCommand(
    'questionnaire',
    '',
    conversationId,
    'chat-admin',
    false,
    true,
    false,
    true,
  );
  assert.match(
    questionnaireStatus ?? '',
    /Автоматическое знакомство с новыми участниками: включено/u,
  );
  const unauthorizedToggle = await questionnaireCommands.handleCommand(
    'questionnaire',
    'off',
    conversationId,
    'regular-user',
    false,
    false,
    false,
    true,
  );
  assert.match(unauthorizedToggle ?? '', /доступна только администраторам/u);
  await questionnaireCommands.handleCommand(
    'questionnaire',
    'off',
    conversationId,
    'chat-admin',
    false,
    true,
    false,
    true,
  );
  const questionnaireNotice = await questionnaireCommands.handleCommand(
    'questionnaire',
    'on',
    conversationId,
    'chat-admin',
    false,
    true,
    false,
    true,
  );
  assert.equal(
    questionnaireNotice,
    'Автоматическое знакомство с новыми участниками включено. Участники могут заполнить или изменить анкету командой /анкета в любое время.',
  );

  const firstJoinEvent = `${conversationId}:join-1`;
  const firstJoin = await memberService.recordJoin(conversationId, vkUserId, firstJoinEvent);
  assert.equal(firstJoin.isReturning, false);
  assert.equal(firstJoin.welcomeText, 'Добро пожаловать, {name}!');
  assert.equal(firstJoin.shouldInviteQuestionnaire, true);
  assert.equal(firstJoin.profileIntroduction, undefined);
  const duplicateJoin = await memberService.recordJoin(conversationId, vkUserId, firstJoinEvent);
  assert.equal(duplicateJoin.shouldInviteQuestionnaire, false);
  assert.equal(duplicateJoin.profileIntroduction, undefined);
  await memberService.recordLeave(conversationId, vkUserId);
  await prisma.conversationMember.update({
    where: { conversationId_vkUserId: { conversationId, vkUserId } },
    data: { questionnaireInviteSentAt: new Date() },
  });
  const returningEventId = `${conversationId}:join-2`;
  const returningJoin = await memberService.recordJoin(conversationId, vkUserId, returningEventId);
  assert.equal(returningJoin.isReturning, true);
  assert.equal(returningJoin.shouldInviteQuestionnaire, true);
  assert.equal(
    (await memberService.recordJoin(conversationId, vkUserId, returningEventId))
      .shouldInviteQuestionnaire,
    false,
  );

  const start = await memberService.startQuestionnaire(conversationId, vkUserId);
  assert.match(start.prompt, /1\. Как тебя зовут\?/u);
  assert.match(start.prompt, /2\. Что тебе интересно\?/u);
  assert.equal(await memberService.hasActiveQuestionnaire(conversationId, vkUserId), true);
  const completed = await memberService.answerQuestionnaire(
    conversationId,
    vkUserId,
    '1. Как тебя зовут?\nОтвет: Аня\n2. Что тебе интересно?\nОтвет: Книги и путешествия',
  );
  assert.match(completed.completed ?? '', /Аня/u);
  assert.match(completed.completed ?? '', /Книги и путешествия/u);
  assert.equal(await memberService.hasActiveQuestionnaire(conversationId, vkUserId), false);
  const profileDetails = await memberService.getProfileDetails(conversationId, vkUserId);
  assert.ok(profileDetails?.createdAt);
  assert.ok(profileDetails?.updatedAt);
  const editForm = await memberService.startQuestionnaire(conversationId, vkUserId, true);
  assert.match(editForm.prompt, /Ответ: Аня/u);
  const unchanged = await memberService.answerQuestionnaire(
    conversationId,
    vkUserId,
    '1. Как тебя зовут?\nОтвет: \n2. Что тебе интересно?\nОтвет: ',
  );
  assert.match(unchanged.completed ?? '', /Аня/u);
  assert.match(unchanged.completed ?? '', /Книги и путешествия/u);
  assert.match(
    (await memberService.getProfile(conversationId, vkUserId)) ?? '',
    /Что тебе интересно/u,
  );
  await memberService.recordLeave(conversationId, vkUserId);
  const profileJoinEventId = `${conversationId}:join-3`;
  const profileJoin = await memberService.recordJoin(conversationId, vkUserId, profileJoinEventId);
  assert.equal(profileJoin.shouldInviteQuestionnaire, false);
  assert.deepEqual(profileJoin.profileIntroduction, {
    'Как тебя зовут?': 'Аня',
    'Что тебе интересно?': 'Книги и путешествия',
  });
  const duplicateProfileJoin = await memberService.recordJoin(
    conversationId,
    vkUserId,
    profileJoinEventId,
  );
  assert.equal(duplicateProfileJoin.profileIntroduction, undefined);

  const formattedIntroduction = formatProfileIntroduction(
    {
      'Как к тебе обращаться?': 'Марк',
      'Сколько лет?': '25 лет',
      'Работаешь или учишься?': ' ',
      'Хобби?': 'Программирование',
    },
    'VK display name',
  );
  assert.match(formattedIntroduction, /к нам присоединился Марк/u);
  assert.match(formattedIntroduction, /Сколько лет\?: 25 лет/u);
  assert.doesNotMatch(formattedIntroduction, /Работаешь или учишься/u);
  assert.doesNotMatch(formattedIntroduction, /VK display name/u);
  assert.doesNotMatch(formattedIntroduction, /VK ID|900000001/u);
  const compactIntroduction = formatProfileIntroduction(
    Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`Поле ${index}`, 'x'.repeat(500)]),
    ),
    'Участник',
  );
  assert.ok(compactIntroduction.length <= 3500);
  assert.match(compactIntroduction, /Некоторые ответы опущены/u);

  const fallbackIntroduction = formatProfileIntroduction(
    { 'Хобби?': 'Шахматы' },
    'VK display name',
  );
  assert.match(fallbackIntroduction, /к нам присоединился VK display name/u);
  const profiles = await memberService.listProfiles(conversationId, 1);
  assert.equal(profiles.total, 1);
  assert.equal(profiles.profiles[0]?.vkUserId, vkUserId);
  const commands = new CommandService();
  const listedProfiles = await commands.handleCommand(
    'profiles',
    '',
    conversationId,
    'regular-user',
    false,
    false,
    false,
    true,
  );
  assert.match(listedProfiles ?? '', new RegExp(vkUserId, 'u'));
  const viewedByMention = await commands.handleCommand(
    'профиль',
    `[id${vkUserId}|Аня]`,
    conversationId,
    'another-user',
    false,
    false,
    false,
    true,
  );
  assert.match(viewedByMention ?? '', /Книги и путешествия/u);
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
  assert.match(
    await memberService.clearProfileAnswer(conversationId, vkUserId, 2),
    /Последнее обновление/u,
  );
  const updatedProfile = await memberService.updateProfileAnswer(
    conversationId,
    vkUserId,
    1,
    'Аня К.',
  );
  assert.match(updatedProfile, /Аня К\./u);
  assert.match((await memberService.getProfile(conversationId, vkUserId)) ?? '', /Аня К\./u);

  const anotherConversation = '2000000398';
  await settingsService.updateChatSettings(anotherConversation, {
    questionnaireEnabled: true,
    questionnaireQuestions: ['Как тебя зовут?'],
  });
  await memberService.startQuestionnaire(anotherConversation, vkUserId);
  await memberService.answerQuestionnaire(
    anotherConversation,
    vkUserId,
    '1. Как тебя зовут?\nОтвет: Аня',
  );
  const profileInAnotherChatUser = '900000003';
  await memberService.startQuestionnaire(anotherConversation, profileInAnotherChatUser);
  await memberService.answerQuestionnaire(
    anotherConversation,
    profileInAnotherChatUser,
    '1. Как тебя зовут?\nОтвет: Другой чат',
  );
  const crossChatJoin = await memberService.recordJoin(
    conversationId,
    profileInAnotherChatUser,
    `${conversationId}:cross-chat-profile`,
  );
  assert.equal(crossChatJoin.shouldInviteQuestionnaire, true);
  assert.equal(crossChatJoin.profileIntroduction, undefined);

  assert.match(
    (await commands.handleCommand(
      'анкета',
      '',
      conversationId,
      vkUserId,
      false,
      false,
      false,
      true,
    )) ?? '',
    /сохранённую анкету для редактирования/u,
  );
  await memberService.cancelQuestionnaire(conversationId, vkUserId);
  assert.match(
    (await commands.handleCommand(
      'удалить',
      'профиль',
      conversationId,
      vkUserId,
      false,
      false,
      false,
      true,
    )) ?? '',
    /подтверди командой/u,
  );
  assert.ok(await memberService.getProfile(conversationId, vkUserId));
  assert.match(
    (await commands.handleCommand(
      'подтвердить',
      'удаление профиля',
      conversationId,
      vkUserId,
      false,
      false,
      false,
      true,
    )) ?? '',
    /Профиль удалён/u,
  );
  assert.equal(await memberService.getProfile(conversationId, vkUserId), undefined);
  assert.ok(await memberService.getProfile(anotherConversation, vkUserId));
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

test('personality command uses direct or group scope and protects shared chat settings', async () => {
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
    'Общие настройки персонажа беседы могут менять только администраторы беседы или бота.',
  );

  const creatorResult = await commands.handleCommand(
    'personality',
    'settings humor=80',
    '2000000010',
    '388581097',
    false,
    false,
    true,
    true,
  );
  assert.equal(creatorResult, 'Общие настройки персонажа Чипсик сохранены для этой беседы.');
  assert.equal((await characters.getSettings('chat', 'member', '2000000010', 'chipsik')).humor, 80);

  const groupSelectionResult = await commands.handleCommand(
    'personality',
    'max',
    '2000000010',
    'chat-admin',
    false,
    true,
    false,
    true,
  );
  assert.match(groupSelectionResult ?? '', /В этой беседе теперь действует Макс/u);
  assert.equal((await characters.getCurrent('chat', 'member', '2000000010')).id, 'max');
  assert.equal((await characters.getCurrent('direct', 'chat-admin', 'chat-admin')).id, 'chipsik');

  const directResult = await commands.handleCommand(
    'personality',
    'settings humor=75',
    'direct-user',
    'direct-user',
  );
  assert.match(directResult ?? '', /Настройки Чипсик сохранены/u);
  assert.equal(
    (await characters.getSettings('direct', 'direct-user', 'direct-user', 'chipsik')).humor,
    75,
  );
});

test('system instructions are scoped to direct conversations and chats', async () => {
  const { CommandService } = await import('../src/services/command/commandService.js');
  const commands = new CommandService();
  const userId = 'system-chat-user';
  const peerId = '2000000030';

  assert.equal(
    await commands.handleCommand(
      'system',
      'Отвечай кратко.',
      peerId,
      userId,
      false,
      false,
      false,
      true,
    ),
    'Инструкцию беседы могут просматривать и менять только администраторы беседы или бота.',
  );
  assert.equal((await settingsService.getUserSettings(userId)).systemPrompt, null);
  assert.equal((await settingsService.getChatSettings(peerId)).systemPrompt, null);

  assert.equal(
    await commands.handleCommand(
      'system',
      'Отвечай кратко.',
      peerId,
      userId,
      false,
      true,
      false,
      true,
    ),
    'Инструкция беседы сохранена.',
  );
  assert.equal((await settingsService.getChatSettings(peerId)).systemPrompt, 'Отвечай кратко.');
  assert.equal((await settingsService.getUserSettings(userId)).systemPrompt, null);

  assert.equal(
    await commands.handleCommand('system', '', peerId, userId, false, true, false, true),
    'Инструкция беседы:\nОтвечай кратко.\n\nИзменить: /инструкция (/system) <текст>; удалить: /инструкция (/system) clear',
  );
  assert.equal(
    await commands.handleCommand('system', 'clear', peerId, userId, false, true, false, true),
    'Инструкция беседы удалена.',
  );
  assert.equal((await settingsService.getChatSettings(peerId)).systemPrompt, null);

  assert.equal(
    await commands.handleCommand('system', 'Только для меня.', userId, userId),
    'Личная системная инструкция сохранена.',
  );
  assert.equal((await settingsService.getUserSettings(userId)).systemPrompt, 'Только для меня.');
  assert.equal((await settingsService.getChatSettings(peerId)).systemPrompt, null);
  assert.match(
    (await commands.handleCommand('system', 'global инструкция', peerId, userId)) ?? '',
    /Префикс global больше не используется/u,
  );
});
