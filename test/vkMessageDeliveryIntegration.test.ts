// Временные пути создаются тестом; Prisma CLI запускается без shell.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { test } from 'node:test';
import type { ChatSettings, UserSettings } from '@prisma/client';
import { PhotoAttachment } from 'vk-io';
import type { AIMessage, AIRequestOptions } from '../src/services/ai/AIProvider.js';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.OPENCODE_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-key';
process.env.WEB_SEARCH_PROVIDER = 'none';
process.env.VOICE_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.MAX_REQUESTS_PER_MINUTE = '100';

const { default: config } = await import('../src/config/index.js');
const { VkService } = await import('../src/services/vk/vkService.js');
const { default: settingsService } = await import('../src/services/settings/settingsService.js');
const { default: characterService } = await import('../src/services/settings/characterService.js');
const { personalities } = await import('../src/services/settings/personalityService.js');
const { default: memoryService } = await import('../src/services/memory/memoryService.js');
const { default: longTermMemoryService } =
  await import('../src/services/memory/longTermMemoryService.js');
const { default: memberService } = await import('../src/services/member/memberService.js');
const { default: reminderService } = await import('../src/services/reminders/reminderService.js');
const { default: senderService } = await import('../src/services/sender/senderService.js');
const { default: voiceService } = await import('../src/services/voice/voiceService.js');
const { default: weatherService } = await import('../src/services/weather/weatherService.js');
const { default: gameInteractionService } =
  await import('../src/services/games/gameInteractionService.js');
const { default: requestQueue } = await import('../src/services/queue/requestQueue.js');
const { OpenCodeProvider } = await import('../src/services/ai/opencodeProvider.js');
const { default: imageAnalysisService } =
  await import('../src/services/image/imageAnalysisService.js');
const { default: imageGenerationService } =
  await import('../src/services/image/imageGenerationService.js');
const { default: imageQuotaService, ImageQuotaService } =
  await import('../src/services/image/imageQuotaService.js');
const { ImageNotExecutedError } = await import('../src/services/image/imageError.js');
const { prisma } = await import('../src/db/client.js');

const peerId = 2_000_000_042;
const timestamp = new Date('2026-01-01T00:00:00Z');
const chatSettings: ChatSettings = {
  id: 'chat-settings',
  conversationId: String(peerId),
  mode: 'normal',
  imageAccess: 'all',
  welcomeEnabled: false,
  welcomeText: '',
  questionnaireEnabled: false,
  questionnaireQuestions: '[]',
  personality: 'chipsik',
  systemPrompt: null,
  personalitySettings: '{}',
  allowPersonalityChange: false,
  funAutoReactions: false,
  funAutoReactionAt: null,
  funAutoIntervalSeconds: 300,
  funAutoProbability: 10,
  funSettings: '{}',
  memeDaySettings: '{}',
  memeDayWeeklyEnabled: false,
  locationName: null,
  locationLatitude: null,
  locationLongitude: null,
  locationCountry: null,
  locationRegion: null,
  locationTimeZone: null,
  timeZone: null,
  memoryEnabled: true,
  autoMemoryEnabled: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const userSettings: UserSettings = {
  id: 'user-settings',
  userId: '5',
  personality: 'chipsik',
  systemPrompt: null,
  voiceEnabled: false,
  voice: null,
  locationName: null,
  locationLatitude: null,
  locationLongitude: null,
  locationCountry: null,
  locationRegion: null,
  locationTimeZone: null,
  timeZone: null,
  memoryEnabled: true,
  autoMemoryEnabled: true,
  createdAt: timestamp,
  updatedAt: timestamp,
};

test('real VK routing delivers exactly one correctly addressed response', async (t) => {
  let mode = 'normal';
  let voiceEnabled = false;
  let voiceCalls = 0;
  let failVoice = false;
  let weatherCalls = 0;
  let failNextDelivery = false;
  let scenario:
    | 'tool'
    | 'ordinary'
    | 'recipient'
    | 'ambiguous'
    | 'active-no'
    | 'active-yes'
    | 'voice'
    | 'voice-long'
    | 'voice-failure'
    | 'weather'
    | 'failure'
    | 'game-first'
    | 'attachment'
    | 'attachment-none'
    | 'image' = 'tool';
  const toolStatuses: string[] = [];
  const delivered: Array<{
    peer: number;
    text: string;
    options: Parameters<typeof senderService.send>[2];
  }> = [];
  const saved: Array<{ role: string; content: string }> = [];
  const commandCompletions = new Map<number, { resolve: () => void; photoActive: boolean }>();

  t.mock.method(settingsService, 'isAdmin', async () => false);
  t.mock.method(settingsService, 'getAppSetting', async () => {});
  t.mock.method(settingsService, 'getChatSettings', async () => ({ ...chatSettings, mode }));
  t.mock.method(settingsService, 'getUserSettings', async () => ({
    ...userSettings,
    voiceEnabled,
    voice: voiceEnabled ? 'coral' : null,
  }));
  t.mock.method(characterService, 'initialize', async () => {});
  t.mock.method(characterService, 'getSystemInstruction', async () => ({
    definition: personalities.chipsik,
    prompt: 'Тестовый персонаж.',
  }));
  t.mock.method(characterService, 'recordUsage', async () => {});
  t.mock.method(memberService, 'getProfileDetails', async () => {});
  t.mock.method(reminderService, 'hasPendingDraft', async () => false);
  t.mock.method(longTermMemoryService, 'hasPendingSelection', async () => false);
  t.mock.method(longTermMemoryService, 'getRelevantMemories', async () => []);
  t.mock.method(longTermMemoryService, 'shouldAnalyzeAutomatically', () => false);
  t.mock.method(memoryService, 'getRecentChatContext', async () => []);
  t.mock.method(memoryService, 'getProposalHistoryForQuestion', async () => {});
  t.mock.method(
    memoryService,
    'addMessage',
    async (message: Parameters<typeof memoryService.addMessage>[0]) => {
      saved.push({ role: message.role, content: message.content });
      return {
        id: 'message',
        role: message.role,
        content: message.content,
        createdAt: timestamp,
      };
    },
  );
  t.mock.method(
    senderService,
    'send',
    async (peer: number, text: string, options: Parameters<typeof senderService.send>[2]) => {
      delivered.push({ peer, text, options });
      const completion = commandCompletions.get(peer);
      if (completion && !completion.photoActive) completion.resolve();
      if (failNextDelivery) {
        failNextDelivery = false;
        throw new Error('VK delivery timed out');
      }
    },
  );
  t.mock.method(senderService, 'uploadVoice', async () => 'audio_message1_2');
  t.mock.method(voiceService, 'synthesize', async () => {
    voiceCalls += 1;
    if (failVoice) throw new Error('TTS failed');
    return Buffer.from('test-audio');
  });
  t.mock.method(weatherService, 'getWeather', async () => {
    weatherCalls += 1;
    return {
      source: 'open_meteo' as const,
      fetchedAt: '2026-11-10T23:54:34Z',
      current: { timeUtc: '2026-11-10T23:00:00Z', temperatureC: 20 },
      forecast: [],
    };
  });
  t.mock.method(gameInteractionService, 'handle', async () => ({
    status: 'result',
    message: 'Состояние игры.',
  }));
  t.mock.method(imageAnalysisService, 'analyze', async () => 'На изображении нарисован человек.');
  t.mock.method(
    OpenCodeProvider.prototype,
    'send',
    async (_messages: AIMessage[], options?: AIRequestOptions) => {
      const findTool = (name: string) => {
        const tool = options?.tools?.find((item) => item.name === name);
        assert.ok(tool, `Missing ${name}`);
        return tool;
      };
      const send = findTool('send_vk_message');
      const record = async (result: Promise<string>) => {
        const parsed: { status: string } = JSON.parse(await result);
        toolStatuses.push(parsed.status);
      };
      if (scenario === 'image') {
        await record(findTool('generate_image').execute({ action: 'generate', prompt: 'кот' }));
        return { content: 'Дублирующий ответ после картинки.' };
      }
      if (scenario === 'voice-long' || scenario === 'voice-failure') {
        return { content: 'Ответ. '.repeat(700) };
      }
      if (scenario === 'attachment') {
        assert.match(
          _messages.map((message) => message.content).join('\n'),
          /В текущем сообщении есть фотография/iu,
        );
        await record(
          findTool('analyze_attachment').execute({
            prompt: 'Опиши психологический портрет человека на изображении',
          }),
        );
        return { content: 'Психологический портрет: спокойный, задумчивый взгляд.' };
      }
      if (scenario === 'attachment-none') {
        assert.match(
          _messages.map((message) => message.content).join('\n'),
          /сначала вызови analyze_attachment/iu,
        );
        await record(findTool('analyze_attachment').execute({ prompt: 'Опиши файл' }));
        return { content: 'Прикрепите фото или документ.' };
      }
      if (scenario === 'ordinary') return { content: 'Привет!' };
      if (scenario === 'active-no' || scenario === 'active-yes') {
        await record(
          findTool('decide_chat_response').execute({ respond: scenario === 'active-yes' }),
        );
      }
      if (scenario === 'weather') {
        await record(findTool('get_weather').execute({ latitude: 55.75, longitude: 37.62 }));
      }
      if (scenario === 'game-first') {
        await record(
          findTool('play_game').execute({ game: 'current', action: 'inspect', value: '' }),
        );
      }
      if (scenario === 'recipient' || scenario === 'ambiguous') {
        await record(
          send.execute({ mode: 'reply_to_member', recipient: 'Андрею', text: 'Ты молодец!' }),
        );
      } else {
        await record(
          send.execute({
            mode: 'reply_to_current',
            text:
              scenario === 'voice'
                ? 'Ответ. '.repeat(80)
                : scenario === 'weather'
                  ? 'Погода: +20 °C.'
                  : 'Привет!',
          }),
        );
      }
      if (scenario === 'weather') {
        await record(findTool('get_weather').execute({ latitude: 55.75, longitude: 37.62 }));
      }
      if (scenario === 'tool') {
        await record(send.execute({ mode: 'reply_to_current', text: 'Привет!' }));
        await record(
          findTool('play_game').execute({ game: 'current', action: 'inspect', value: '' }),
        );
        await record(
          findTool('execute_bot_command').execute({ command: 'mode', arguments: 'active' }),
        );
      }
      return { content: 'Привет!' };
    },
  );

  let messageHandler:
    ((message: object, next: () => Promise<void>) => Promise<unknown>) | undefined;
  const service = new VkService();
  const originalStartActivity = Reflect.get(service, 'startActivity') as (
    targetPeerId: number,
    activity: string,
  ) => () => void;
  Reflect.set(service, 'startActivity', (targetPeerId: number, activity: string) => {
    const completion = commandCompletions.get(targetPeerId);
    if (completion && activity === 'photo') completion.photoActive = true;
    const stop = originalStartActivity.call(service, targetPeerId, activity);
    return () => {
      stop();
      if (completion && activity === 'photo') completion.resolve();
    };
  });
  t.after(() => {
    Reflect.set(service, 'startActivity', originalStartActivity);
  });
  const originalRecordUsage = Reflect.get(service, 'recordUsage') as (data: {
    vkUserId: string;
    conversationId: string;
    provider: string;
    feature: string;
    createdAt?: Date;
  }) => Promise<void>;
  Reflect.set(service, 'recordUsage', async () => {});
  Reflect.set(service, 'vk', {
    updates: {
      on: (events: string | string[], callback: unknown) => {
        if (Array.isArray(events) && events.includes('message_new')) {
          assert.equal(typeof callback, 'function');
          if (typeof callback === 'function') {
            messageHandler = (message, next) => callback(message, next);
          }
        }
      },
      start: async () => {
        throw new Error('test: do not start VK polling or scheduled jobs');
      },
    },
    api: {
      users: { get: async () => [{ first_name: 'Ирина', last_name: 'Иванова' }] },
      messages: {
        setActivity: async () => ({}),
        markAsRead: async () => ({}),
        getConversationMembers: async () => {
          const members = [
            { id: 5, first_name: 'Ирина', last_name: 'Иванова' },
            { id: 7, first_name: 'Андрей', last_name: 'Петров' },
            ...(scenario === 'ambiguous'
              ? [{ id: 9, first_name: 'Андрей', last_name: 'Сидоров' }]
              : []),
          ];
          return {
            count: members.length,
            items: members.map((member) => ({ member_id: member.id })),
            profiles: members,
            groups: [],
          };
        },
        getByConversationMessageId: async (params: { conversation_message_ids: number[] }) => ({
          items: [
            {
              peer_id: peerId,
              conversation_message_id: params.conversation_message_ids[0],
              from_id: 7,
              date: Math.floor(Date.now() / 1000),
              is_hidden: false,
            },
          ],
        }),
      },
    },
  });
  await assert.rejects(service.start(), /test: do not start VK polling/iu);
  assert.ok(messageHandler);

  const photo = Object.create(PhotoAttachment.prototype) as PhotoAttachment;

  const dispatch = async (
    id: number,
    text: string,
    replyToBot = false,
    attachments: PhotoAttachment[] = [],
    targetPeerId = peerId,
    waitForQueue = true,
  ) => {
    assert.ok(messageHandler);
    // Slash commands run outside RequestQueue; observe their delivery/finally instead.
    let commandTimer: ReturnType<typeof setTimeout> | undefined;
    const commandFinished = text.startsWith('/')
      ? new Promise<void>((resolve, reject) => {
          commandCompletions.set(targetPeerId, { resolve, photoActive: false });
          commandTimer = setTimeout(() => {
            reject(new Error(`Command ${id} did not finish`));
          }, 10_000);
        })
      : undefined;
    await messageHandler(
      {
        peerId: targetPeerId,
        senderId: 5,
        id: 900 + id,
        conversationMessageId: 100 + id,
        isChat: true,
        isOutbox: false,
        eventType: undefined,
        attachments,
        text,
        replyMessage: replyToBot
          ? {
              peerId,
              id: 30,
              conversationMessageId: 30,
              senderId: -1,
              isOutbox: true,
              text: 'Предыдущий ответ бота.',
            }
          : undefined,
      },
      async () => {},
    );
    try {
      await commandFinished;
    } finally {
      if (commandTimer) clearTimeout(commandTimer);
      if (commandFinished) commandCompletions.delete(targetPeerId);
    }
    if (waitForQueue) await requestQueue.getQueueForUser('5').onIdle();
  };

  await dispatch(1, 'Пенёк, привет!');
  assert.deepEqual(toolStatuses, ['result', 'not_executed', 'not_executed', 'denied']);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, 'Привет!');
  assert.equal(delivered[0].options?.conversationMessageId, 101);
  assert.deepEqual(
    saved.map((message) => message.role),
    ['user', 'assistant'],
  );

  scenario = 'ordinary';
  delivered.length = 0;
  await dispatch(2, 'Привет!', true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].options?.conversationMessageId, 102);

  scenario = 'recipient';
  delivered.length = 0;
  await dispatch(3, 'Пенёк, скажи Андрею, что он молодец.');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, 'Ты молодец!');
  assert.equal(delivered[0].options?.conversationMessageId, 102);

  scenario = 'ambiguous';
  delivered.length = 0;
  await dispatch(7, 'Пенёк, скажи Андрею, что он молодец.');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /несколько участников/iu);
  assert.equal(delivered[0].options?.conversationMessageId, 107);
  assert.equal(toolStatuses.at(-1), 'clarification_requested');

  scenario = 'weather';
  delivered.length = 0;
  await dispatch(8, 'Пенёк, какая погода?');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Погода: \+20 °C/u);
  assert.doesNotMatch(delivered[0].text, /Open-Meteo|MET Norway|GeoNames|OpenStreetMap/iu);
  assert.equal(weatherCalls, 1);
  assert.deepEqual(toolStatuses.slice(-3), ['result', 'result', 'not_executed']);

  scenario = 'failure';
  failNextDelivery = true;
  delivered.length = 0;
  await dispatch(9, 'Пенёк, привет!');
  assert.equal(delivered.filter((message) => message.text === 'Привет!').length, 1);
  assert.equal(
    delivered.filter((message) => /не удалось подтвердить/iu.test(message.text)).length,
    1,
  );
  assert.equal(toolStatuses.at(-1), 'uncertain');

  scenario = 'game-first';
  delivered.length = 0;
  await dispatch(10, 'Пенёк, как идёт игра?');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, 'Состояние игры.');
  assert.deepEqual(toolStatuses.slice(-2), ['result', 'not_executed']);

  scenario = 'attachment';
  delivered.length = 0;
  await dispatch(11, 'Пенёк, опиши психологический портрет человека на изображении.', false, [
    photo,
  ]);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Психологический портрет/iu);
  assert.equal(toolStatuses.at(-1), 'result');

  scenario = 'attachment-none';
  delivered.length = 0;
  await dispatch(12, 'Пенёк, опиши файл.');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Прикрепите/iu);
  assert.equal(toolStatuses.at(-1), 'needs_attachment');

  mode = 'active';
  scenario = 'active-no';
  delivered.length = 0;
  await dispatch(4, 'Просто переписка.');
  assert.equal(delivered.length, 0);

  scenario = 'active-yes';
  delivered.length = 0;
  await dispatch(5, 'Кто знает ответ?');
  assert.equal(delivered.length, 1, `tool statuses: ${JSON.stringify(toolStatuses)}`);
  assert.equal(delivered[0].options?.conversationMessageId, 105);

  scenario = 'voice';
  mode = 'normal';
  voiceEnabled = true;
  config.VOICE_ENABLED = true;
  t.after(() => {
    config.VOICE_ENABLED = false;
  });
  delivered.length = 0;
  await dispatch(6, 'Пенёк, ответь подробно.');
  assert.equal(voiceCalls, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].options?.conversationMessageId, 106);
  assert.equal(delivered[0].options?.attachment, 'audio_message1_2');
  assert.match(delivered[0].text, /^Ответ\./u);
  assert.doesNotMatch(delivered[0].text, /Голосовой ответ сгенерирован ИИ/u);

  scenario = 'voice-long';
  delivered.length = 0;
  await dispatch(13, 'Пенёк, ответь очень подробно.');
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].text.length <= 4000, `unexpected length: ${delivered[0].text.length}`);
  assert.ok(delivered[0].text.length > 3900, `unexpected length: ${delivered[0].text.length}`);
  assert.match(delivered[0].text, /Ответ сокращён/u);
  assert.equal(delivered[0].options?.attachment, 'audio_message1_2');
  assert.doesNotMatch(delivered[0].text, /Голосовой ответ сгенерирован ИИ/u);

  failVoice = true;
  scenario = 'voice-failure';
  delivered.length = 0;
  await dispatch(14, 'Пенёк, ответь ещё подробнее.');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].options?.attachment, undefined);
  assert.match(delivered[0].text, /Не удалось озвучить ответ/u);
  failVoice = false;

  delivered.length = 0;
  await dispatch(15, '/say Привет');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, 'Привет');
  assert.equal(delivered[0].options?.attachment, 'audio_message1_2');
  assert.doesNotMatch(delivered[0].text, /Готово, вот озвученный текст/u);

  // Обе production точки допуска используют реальную отдельную SQLite.
  const directory = await mkdtemp(path.join(tmpdir(), 'vk-image-quota-'));
  const databaseUrl = `file:${path.join(directory, 'quota.db')}`;
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(async () => {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });
  execFileSync(
    process.execPath,
    [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );
  const reservedAt = new Date('2026-11-20T23:59:59Z');
  const quota = new ImageQuotaService(db, () => reservedAt);
  let quotaUnavailable = false;
  let finishUnavailable = false;
  t.mock.method(
    imageQuotaService,
    'reserve',
    async (input: Parameters<typeof quota.reserve>[0]) => {
      if (quotaUnavailable) throw new Error('Database unavailable');
      return quota.reserve(input);
    },
  );
  t.mock.method(imageQuotaService, 'finish', async (...args: Parameters<typeof quota.finish>) => {
    if (finishUnavailable) throw new Error('Finish unavailable');
    await quota.finish(...args);
  });
  let failUsage = false;
  const usageDates: Date[] = [];
  // Prisma exposes delegate methods through a proxy with an undefined descriptor value.
  const originalUsageCreate = Reflect.get(prisma.apiUsage, 'create');
  t.after(() => {
    Reflect.set(prisma.apiUsage, 'create', originalUsageCreate);
  });
  Reflect.set(
    prisma.apiUsage,
    'create',
    async (args: Parameters<typeof prisma.apiUsage.create>[0]) => {
      if (args?.data.createdAt instanceof Date) usageDates.push(args.data.createdAt);
      if (failUsage) throw new Error('Usage unavailable');
      return db.apiUsage.create(args);
    },
  );
  Reflect.set(service, 'recordUsage', originalRecordUsage.bind(service));
  let generated = 0;
  let deliveredImages = 0;
  let generationFailure: Error | undefined;
  let deliveryFailure = false;
  let onGenerate: (() => Promise<void>) | undefined;
  const generate = async () => {
    generated++;
    await onGenerate?.();
    if (generationFailure) throw generationFailure;
    return { buffer: Buffer.from('test-image'), contentType: 'image/png' as const };
  };
  t.mock.method(imageGenerationService, 'generate', generate);
  t.mock.method(imageGenerationService, 'edit', generate);
  t.mock.method(senderService, 'sendPhoto', async () => {
    deliveredImages++;
    if (deliveryFailure) throw new Error('Lost VK ACK');
  });
  voiceEnabled = false;
  scenario = 'image';
  delivered.length = 0;
  await db.apiUsage.createMany({
    data: Array.from({ length: config.IMAGE_MAX_PER_USER_PER_DAY - 1 }, () => ({
      provider: 'openai',
      feature: 'image_generate',
      vkUserId: '5',
      createdAt: reservedAt,
    })),
  });
  let releaseGeneration: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  onGenerate = async () => {
    notifyStarted?.();
    await blocked;
  };
  const toolPending = dispatch(100, 'Пенёк, нарисуй кота.');
  await started;
  try {
    await dispatch(101, '/image кот', false, [], peerId + 1, false);
    assert.equal(generated, 1);
    assert.match(delivered.at(-1)?.text ?? '', /Дневной лимит/iu);
  } finally {
    releaseGeneration?.();
  }
  await toolPending;
  assert.equal(deliveredImages, 1);
  assert.equal(toolStatuses.at(-1), 'result');
  assert.ok(delivered.every((message) => !message.text.includes('Дублирующий')));
  assert.equal(
    (await db.imageDailyQuota.findFirstOrThrow()).used,
    config.IMAGE_MAX_PER_USER_PER_DAY,
  );
  assert.equal(usageDates.at(-1)?.toISOString(), reservedAt.toISOString());
  onGenerate = undefined;

  const resetQuota = async () => {
    await db.imageQuotaAttempt.deleteMany();
    await db.imageDailyQuota.deleteMany();
    await db.apiUsage.deleteMany();
    delivered.length = 0;
  };
  await resetQuota();
  quotaUnavailable = true;
  const beforeUnavailable = generated;
  await dispatch(102, '/image кот');
  await dispatch(103, 'Пенёк, нарисуй кота.');
  assert.equal(generated, beforeUnavailable);
  assert.equal(await db.imageQuotaAttempt.count(), 0);
  assert.equal(toolStatuses.at(-1), 'error');
  assert.ok(delivered.every((message) => !message.text.includes('Дневной лимит')));
  quotaUnavailable = false;

  const apiKey = config.OPENAI_API_KEY;
  config.OPENAI_API_KEY = '';
  try {
    await dispatch(104, '/image кот');
    await dispatch(105, 'Пенёк, нарисуй кота.');
    assert.equal(generated, beforeUnavailable);
    assert.equal(await db.imageQuotaAttempt.count(), 0);
    assert.equal(toolStatuses.at(-1), 'not_configured');
  } finally {
    config.OPENAI_API_KEY = apiKey;
  }
  await dispatch(106, '/edit акварель');
  assert.equal(await db.imageQuotaAttempt.count(), 0);

  // Ошибки подготовки/провайдера/доставки на фактическом командном маршруте.
  for (const [id, failure, expectedStatus, expectedUsed] of [
    [110, new ImageNotExecutedError(new Error('Download failed')), 'released', 0],
    [111, new Error('Timeout after API'), 'uncertain', 1],
    [112, Object.assign(new Error('Moderation'), { code: 'moderation_blocked' }), 'uncertain', 1],
  ] as const) {
    await resetQuota();
    generationFailure = failure;
    await dispatch(id, '/image кот');
    assert.equal((await db.imageQuotaAttempt.findFirstOrThrow()).status, expectedStatus);
    assert.equal((await db.imageDailyQuota.findFirstOrThrow()).used, expectedUsed);
  }
  generationFailure = undefined;
  await resetQuota();
  deliveryFailure = true;
  await dispatch(113, '/image кот');
  assert.equal((await db.imageQuotaAttempt.findFirstOrThrow()).status, 'consumed');
  assert.equal((await db.imageDailyQuota.findFirstOrThrow()).used, 1);
  deliveryFailure = false;

  await resetQuota();
  failUsage = true;
  await dispatch(114, '/image кот');
  await dispatch(115, 'Пенёк, нарисуй кота.');
  assert.equal((await db.imageDailyQuota.findFirstOrThrow()).used, 2);
  assert.equal(await db.apiUsage.count(), 0);
  assert.equal(toolStatuses.at(-1), 'result');
  assert.ok(delivered.every((message) => !message.text.includes('Дублирующий')));
  failUsage = false;

  await resetQuota();
  finishUnavailable = true;
  const sentBeforeFinish = deliveredImages;
  await dispatch(116, '/image кот');
  await dispatch(117, 'Пенёк, нарисуй кота.');
  assert.equal(deliveredImages, sentBeforeFinish + 2);
  assert.equal(toolStatuses.at(-1), 'result');
  assert.ok(
    (await db.imageQuotaAttempt.findMany()).every((attempt) => attempt.status === 'reserved'),
  );
  assert.equal((await db.imageDailyQuota.findFirstOrThrow()).used, 2);
});
