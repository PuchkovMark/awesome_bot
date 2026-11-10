import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import { ADMIN_COMMAND_PAGES, HELP_PAGES } from '../src/services/command/commandHelp.js';
import { CommandService } from '../src/services/command/commandService.js';
import {
  commandAliases,
  normalizeCommandName,
} from '../src/services/command/commandAliases.js';
import { DetectorService } from '../src/services/detector/detectorService.js';
import adventureService from '../src/services/games/adventureService.js';
import gameService from '../src/services/games/gameService.js';
import funService, { type FunKind } from '../src/services/fun/funService.js';
import memberService from '../src/services/member/memberService.js';
import memoryService from '../src/services/memory/memoryService.js';
import searchService from '../src/services/search/searchService.js';
import settingsService from '../src/services/settings/settingsService.js';
import characterService from '../src/services/settings/characterService.js';

const vkPipelineCommands = new Set([
  'image',
  'edit',
  'analyze',
  'ocr',
  'document',
  'say',
  'meme',
  'memeday',
  'adventure',
]);

function getMenuCommandNames(): string[] {
  const pages = [...HELP_PAGES, ...ADMIN_COMMAND_PAGES];
  const menuNames = pages.flatMap((page) =>
    page.flatMap((line) =>
      [...line.matchAll(/\/([\p{L}][\p{L}\d]*)/gu)].map((match) => match[1]!),
    ),
  );
  const menuCommands = new Set(menuNames.map(normalizeCommandName));
  const russianAliases = Object.entries(commandAliases)
    .filter(([command]) => menuCommands.has(command))
    .flatMap(([, aliases]) => aliases);
  return [...new Set([...menuNames, ...russianAliases])];
}

function replacePrismaMethod(
  target: object,
  methodName: PropertyKey,
  replacement: (...args: never[]) => unknown,
): () => void {
  const original = Object.getOwnPropertyDescriptor(target, methodName);
  Object.defineProperty(target, methodName, {
    configurable: true,
    writable: true,
    value: replacement,
  });
  return () => {
    if (original) {
      Object.defineProperty(target, methodName, original);
    } else {
      Reflect.deleteProperty(target, methodName);
    }
  };
}

test('commands listed in /help and /admin are recognized and dispatched', async (t) => {
  const senderId = '123456789';
  const peerId = '2000000001';
  const commandService = new CommandService();
  const detector = new DetectorService();
  const personality = {
    id: 'command-menu-test',
    name: 'Тестовый персонаж',
    description: 'Для проверки меню команд',
    example: 'Пример',
  } as Awaited<ReturnType<typeof characterService.getCurrent>>;
  const userSettings = {
    systemPrompt: null,
    voiceEnabled: false,
    voice: 'coral',
  } as Awaited<ReturnType<typeof settingsService.getUserSettings>>;
  const chatSettings = {
    mode: 'normal',
    imageAccess: 'admins_only',
    welcomeEnabled: false,
    welcomeText: 'Добро пожаловать, {name}!',
    questionnaireEnabled: false,
    funSettings: '{}',
    funAutoReactions: false,
    funAutoProbability: 10,
    funAutoIntervalSeconds: 300,
  } as Awaited<ReturnType<typeof settingsService.getChatSettings>>;

  t.mock.method(searchService, 'search', async () => ({ provider: 'tavily', results: [] }));
  t.mock.method(funService, 'generate', async (kind: FunKind) => ({
    id: `command-menu-${kind}`,
    content: `Тестовый ответ: ${kind}`,
  }));
  t.mock.method(funService, 'allowsPersonalJokes', async () => true);
  t.mock.method(funService, 'getSettings', async () => ({
    intensity: 50,
    sarcasm: 25,
    absurdity: 40,
    emojis: true,
    personalJokes: true,
    personalMemes: true,
  }));
  t.mock.method(settingsService, 'getUserSettings', async () => userSettings);
  t.mock.method(settingsService, 'getChatSettings', async () => chatSettings);
  t.mock.method(settingsService, 'setSystemPrompt', async () => {});
  t.mock.method(characterService, 'getCurrent', async () => personality);
  t.mock.method(characterService, 'list', async () => [personality]);
  t.mock.method(memberService, 'getProfile', async () => null);
  t.mock.method(memberService, 'startQuestionnaire', async () => ({
    prompt: '1. Тестовый вопрос',
    alreadyExists: false,
  }));
  t.mock.method(memberService, 'listProfiles', async () => ({ total: 0, profiles: [] }));
  t.mock.method(memoryService, 'getRecentConversationMessages', async () => []);
  t.mock.method(memoryService, 'clearUserHistory', async () => 0);
  t.mock.method(memoryService, 'getActiveGroupConversationIds', async () => []);
  t.mock.method(gameService, 'handleCommand', async () => 'Доступные игры: тест.');
  t.mock.method(adventureService, 'handleCommand', async () => ({
    text: 'Интерактивное приключение: команды',
  }));

  const restorePrismaMethods = [
    replacePrismaMethod(prisma.user, 'count', async () => 0),
    replacePrismaMethod(prisma.user, 'findUnique', async () => null),
    replacePrismaMethod(prisma.conversation, 'count', async () => 0),
    replacePrismaMethod(prisma.message, 'count', async () => 0),
    replacePrismaMethod(prisma.apiUsage, 'aggregate', async () => ({
      _count: { id: 0 },
      _sum: { estimatedCost: null },
    })),
    replacePrismaMethod(prisma.apiUsage, 'create', async () => ({})),
    replacePrismaMethod(prisma.adminLog, 'findMany', async () => []),
    replacePrismaMethod(prisma.gameSession, 'findFirst', async () => null),
  ];

  try {
    const commandNames = getMenuCommandNames();
    assert.ok(commandNames.includes('help'), '/help should appear in the command menus');
    assert.ok(commandNames.includes('admin'), '/admin should appear in the command menus');

    for (const command of commandNames) {
      const canonicalCommand = normalizeCommandName(command);
      if (canonicalCommand === 'image' || canonicalCommand === 'edit') {
        const parsed = detector.parseImageCommand(`/${command} тестовое описание`);
        assert.deepEqual(
          parsed,
          {
            action: canonicalCommand === 'edit' ? 'edit' : 'generate',
            prompt: 'тестовое описание',
          },
          `/${command} should use the image command route`,
        );
        continue;
      }

      const parsed = detector.parseCommand(`/${command}`);
      assert.equal(
        parsed,
        canonicalCommand,
        `/${command} should be recognized by the message dispatcher`,
      );
    }

    for (const command of ['анкета', 'профиль']) {
      const parsed = detector.parseCommand(`/${command}`);
      assert.equal(detector.isMemberProfileCommand(parsed), true);
    }

    const smokeArguments: Record<string, string> = {
      search: 'тестовый запрос',
      games: 'help',
      system: 'global',
      thinking: 'invalid',
      mode: 'invalid',
      imageaccess: 'invalid',
      maintenance: 'invalid',
      broadcast: 'Тестовая рассылка',
      удалить: 'профиль',
      подтвердить: 'удаление профиля',
    };
    const chatCommands = new Set([
      'personality',
      'joke',
      'battle',
      'funsettings',
      'welcome',
      'questionnaire',
      'profile',
      'profiles',
      'анкета',
      'анкеты',
      'опрос',
    ]);

    for (const command of commandNames) {
      const canonicalCommand = normalizeCommandName(command);
      if (vkPipelineCommands.has(canonicalCommand)) continue;

      const response = await commandService.handleCommand(
        command,
        smokeArguments[canonicalCommand] ?? smokeArguments[command] ?? '',
        peerId,
        senderId,
        true,
        true,
        true,
        chatCommands.has(canonicalCommand) || chatCommands.has(command),
      );
      assert.ok(response, `/${command} should return a response`);
      assert.ok(
        !response.startsWith('Неизвестная команда:'),
        `/${command} should reach a command handler`,
      );
      assert.notEqual(
        response,
        'Не удалось выполнить команду. Проверьте параметры и повторите попытку.',
        `/${command} should complete without an internal command error`,
      );
      if (canonicalCommand === 'анкета') {
        assert.match(response, /Давай познакомимся!/u, `/${command} should start the questionnaire`);
      }
      if (canonicalCommand === 'profile') {
        assert.match(response, /Анкета пока не заполнена/u, `/${command} should show the profile`);
      }
    }

    for (const [command, pageCount, pageTitle] of [
      ['help', HELP_PAGES.length, 'Справка — страница'],
      ['admin', ADMIN_COMMAND_PAGES.length, 'Страница'],
    ] as const) {
      const commandVariants = commandNames.filter(
        (name) => normalizeCommandName(name) === command,
      );
      for (const commandVariant of commandVariants) {
        for (let page = 1; page <= pageCount; page += 1) {
          const response = await commandService.handleCommand(
            commandVariant,
            page === 1 ? '' : String(page),
            peerId,
            senderId,
            true,
            true,
            true,
            true,
          );
          assert.match(
            response ?? '',
            new RegExp(`${pageTitle} ${page}/${pageCount}`, 'u'),
            `/${commandVariant} should open page ${page}`,
          );
        }
      }
    }

    const adminCommands = commandNames.filter((name) => normalizeCommandName(name) === 'admin');
    for (const command of adminCommands) {
      for (const action of ['add', 'remove']) {
        const response = await commandService.handleCommand(
          command,
          `${action} 123456789`,
          peerId,
          senderId,
          true,
          false,
          false,
        );
        assert.match(response ?? '', /только создатель бота/u);
      }
    }

    const adventureHelp = await adventureService.handleCommand(
      peerId,
      senderId,
      'Тестовый участник',
      true,
      'help',
    );
    assert.match(adventureHelp.text, /Интерактивное приключение/u);
  } finally {
    for (const restore of restorePrismaMethods.reverse()) restore();
  }
});
