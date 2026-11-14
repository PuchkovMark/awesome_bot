import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSettings, UserSettings } from '@prisma/client';
import type { AIMessage, AIRequestOptions } from '../src/services/ai/AIProvider.js';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.OPENCODE_API_KEY = 'test-key';
process.env.WEB_SEARCH_PROVIDER = 'none';
process.env.VOICE_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

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
    | 'weather'
    | 'failure'
    | 'game-first' = 'tool';
  const toolStatuses: string[] = [];
  const delivered: Array<{
    peer: number;
    text: string;
    options: Parameters<typeof senderService.send>[2];
  }> = [];
  const saved: Array<{ role: string; content: string }> = [];

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
      if (failNextDelivery) {
        failNextDelivery = false;
        throw new Error('VK delivery timed out');
      }
    },
  );
  t.mock.method(senderService, 'uploadVoice', async () => 'audio_message1_2');
  t.mock.method(voiceService, 'synthesize', async () => {
    voiceCalls += 1;
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

  const dispatch = async (id: number, text: string, replyToBot = false) => {
    assert.ok(messageHandler);
    await messageHandler(
      {
        peerId,
        senderId: 5,
        id: 900 + id,
        conversationMessageId: 100 + id,
        isChat: true,
        isOutbox: false,
        eventType: undefined,
        attachments: [],
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
    await requestQueue.getQueueForUser('5').onIdle();
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

  mode = 'active';
  scenario = 'active-no';
  delivered.length = 0;
  await dispatch(4, 'Просто переписка.');
  assert.equal(delivered.length, 0);

  scenario = 'active-yes';
  delivered.length = 0;
  await dispatch(5, 'Кто знает ответ?');
  assert.equal(delivered.length, 1);
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
  assert.match(delivered[0].text, /Голосовой ответ сгенерирован ИИ/u);
});
