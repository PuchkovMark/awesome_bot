import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import OpenAI from 'openai';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.LOG_LEVEL = 'silent';

const { TimeService } = await import('../src/services/time/timeService.js');
const { createCurrentDateTimeTool, selectContextTimeZone } =
  await import('../src/services/ai/tools/currentDateTimeTool.js');
const { sendChatCompletion } = await import('../src/services/ai/chatCompletion.js');

const primaryResponse = {
  dateTime: '2026-11-10T23:59:59.1234567',
  timeZone: 'UTC',
};
const backupResponse = { utc_iso: '2026-11-10T23:59:59Z' };
const allowed = async () => ({ allowed: true as const });
const fixedReading = async () => ({
  source: 'timeapi.io' as const,
  instant: new Date('2026-11-10T23:59:59.123Z'),
});

test('uses the primary service and preserves the UTC instant', async () => {
  const calls: string[] = [];
  const service = new TimeService(async (url) => {
    calls.push(url);
    return primaryResponse;
  });
  const result = await service.getCurrentTime();
  assert.equal(result.source, 'timeapi.io');
  assert.equal(result.instant.toISOString(), '2026-11-10T23:59:59.123Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://timeapi.io/api/Time/current/zone?timeZone=UTC');
});

test('uses the independent backup when the primary service fails', async () => {
  const calls: string[] = [];
  const service = new TimeService(async (url) => {
    calls.push(url);
    if (url.includes('timeapi.io')) throw new Error('timeout');
    return backupResponse;
  });
  const result = await service.getCurrentTime();
  assert.equal(result.source, 'utctime.app');
  assert.equal(result.instant.toISOString(), '2026-11-10T23:59:59.000Z');
  assert.deepEqual(calls, [
    'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
    'https://utctime.app/api/now',
  ]);
});

test('uses the backup for malformed or non-UTC primary responses', async () => {
  const invalidResponses = [
    {},
    { dateTime: primaryResponse.dateTime, timeZone: 'Europe/Moscow' },
    { dateTime: '2026-02-31T23:59:59', timeZone: 'UTC' },
    { dateTime: '2026-11-10T23:59:59+03:00', timeZone: 'UTC' },
  ];
  for (const response of invalidResponses) {
    const service = new TimeService(async (url) =>
      url.includes('timeapi.io') ? response : backupResponse,
    );
    assert.equal((await service.getCurrentTime()).source, 'utctime.app');
  }
});

test('reports failure when both services fail or return invalid timestamps', async () => {
  const services = [
    new TimeService(async () => {
      throw new Error('network unavailable');
    }),
    new TimeService(async () => ({ utc_iso: '2026-02-31T23:59:59Z' })),
  ];
  for (const service of services) {
    await assert.rejects(
      service.getCurrentTime(),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
  }
});

test('uses chat settings in a group and personal settings only in a direct dialog', () => {
  const chat = { timeZone: null, locationTimeZone: 'Europe/Moscow' };
  const user = { timeZone: 'Asia/Tokyo', locationTimeZone: 'Asia/Seoul' };
  assert.deepEqual(selectContextTimeZone(true, chat, user), {
    timeZone: 'Europe/Moscow',
    scope: 'chat',
  });
  assert.deepEqual(selectContextTimeZone(false, chat, user), {
    timeZone: 'Asia/Tokyo',
    scope: 'user',
  });
  assert.deepEqual(selectContextTimeZone(true, { timeZone: null, locationTimeZone: null }, user), {
    timeZone: null,
    scope: 'chat',
  });
});

test('formats the current time in the configured conversation timezone', async () => {
  const tool = createCurrentDateTimeTool({
    timeZone: 'Europe/Moscow',
    scope: 'chat',
    checkAccess: allowed,
    getCurrentTime: fixedReading,
  });
  const result = JSON.parse(await tool.execute({}));
  assert.deepEqual(result, {
    status: 'result',
    source: 'timeapi.io',
    utc_datetime: '2026-11-10T23:59:59.123Z',
    time_zone: 'Europe/Moscow',
    time_zone_source: 'chat',
    date: '2026-11-11',
    time: '02:59:59',
    weekday: 'среда',
    utc_offset: 'UTC+03:00',
  });
});

test('an explicitly requested timezone takes precedence and handles fractional offsets', async () => {
  const tool = createCurrentDateTimeTool({
    timeZone: 'Europe/Moscow',
    scope: 'user',
    checkAccess: allowed,
    getCurrentTime: fixedReading,
  });
  const result = JSON.parse(await tool.execute({ time_zone: 'Asia/Kolkata' }));
  assert.equal(result.time_zone, 'Asia/Kolkata');
  assert.equal(result.time_zone_source, 'requested');
  assert.equal(result.date, '2026-11-11');
  assert.equal(result.time, '05:29:59');
  assert.equal(result.utc_offset, 'UTC+05:30');
});

test('uses IANA daylight-saving rules at a transition', async () => {
  for (const [instant, time, offset] of [
    ['2026-03-08T06:59:59Z', '01:59:59', 'UTC-05:00'],
    ['2026-03-08T07:00:00Z', '03:00:00', 'UTC-04:00'],
  ]) {
    const tool = createCurrentDateTimeTool({
      timeZone: 'America/New_York',
      scope: 'user',
      checkAccess: allowed,
      getCurrentTime: async () => ({ source: 'timeapi.io', instant: new Date(instant) }),
    });
    const result = JSON.parse(await tool.execute({}));
    assert.equal(result.date, '2026-03-08');
    assert.equal(result.time, time);
    assert.equal(result.utc_offset, offset);
  }
});

test('labels UTC as the default when no timezone is configured', async () => {
  const tool = createCurrentDateTimeTool({
    timeZone: null,
    scope: 'chat',
    checkAccess: allowed,
    getCurrentTime: fixedReading,
  });
  const result = JSON.parse(await tool.execute({}));
  assert.equal(result.time_zone, 'UTC');
  assert.equal(result.time_zone_source, 'utc_default');
  assert.equal(result.date, '2026-11-10');
  assert.equal(result.time, '23:59:59');
});

test('rejects invalid arguments and timezones without calling a service', async () => {
  let requests = 0;
  const tool = createCurrentDateTimeTool({
    timeZone: null,
    scope: 'user',
    checkAccess: allowed,
    getCurrentTime: async () => {
      requests += 1;
      return fixedReading();
    },
  });
  for (const input of [
    null,
    [],
    { extra: true },
    { time_zone: 1 },
    { time_zone: '' },
    { time_zone: 'A'.repeat(129) },
    { time_zone: 'Mars/Olympus' },
  ]) {
    const result = JSON.parse(await tool.execute(input));
    assert.equal(result.status, 'not_executed');
  }
  assert.equal(requests, 0);
});

test('does not silently replace an invalid configured timezone', async () => {
  let requests = 0;
  const tool = createCurrentDateTimeTool({
    timeZone: 'Mars/Olympus',
    scope: 'chat',
    checkAccess: allowed,
    getCurrentTime: async () => {
      requests += 1;
      return fixedReading();
    },
  });
  const result = JSON.parse(await tool.execute({}));
  assert.equal(result.status, 'not_executed');
  assert.equal(requests, 0);
});

test('does not request time when access is denied', async () => {
  let requests = 0;
  const tool = createCurrentDateTimeTool({
    timeZone: null,
    scope: 'chat',
    checkAccess: async () => ({ allowed: false, message: 'Сначала решите, следует ли отвечать.' }),
    getCurrentTime: async () => {
      requests += 1;
      return fixedReading();
    },
  });
  const result = JSON.parse(await tool.execute({}));
  assert.equal(result.status, 'not_executed');
  assert.equal(requests, 0);
});

test('reports service failures without inventing a date or time', async () => {
  const service = new TimeService(async () => {
    throw new Error('network unavailable');
  });
  const tool = createCurrentDateTimeTool({
    timeZone: 'UTC',
    scope: 'user',
    checkAccess: allowed,
    getCurrentTime: () => service.getCurrentTime(),
  });
  const result = JSON.parse(await tool.execute({}));
  assert.equal(result.status, 'error');
  assert.match(result.message, /оба сервиса/u);
  assert.equal(result.date, undefined);
  assert.equal(result.time, undefined);
  assert.equal(result.utc_datetime, undefined);
});

test('returns the tool result to the model through the existing completion loop', async () => {
  const tool = createCurrentDateTimeTool({
    timeZone: 'Europe/Moscow',
    scope: 'chat',
    checkAccess: allowed,
    getCurrentTime: fixedReading,
  });
  const requests: Array<{
    tools?: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content?: string }>;
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const body =
        requests.length === 1
          ? {
              id: 'tool-call',
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'time-call',
                        type: 'function',
                        function: { name: 'get_current_datetime', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            }
          : {
              id: 'final',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'В Москве 02:59.' },
                },
              ],
            };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
    });
    const response = await sendChatCompletion(
      client,
      'test-model',
      'opencode',
      [{ role: 'user', content: 'Сколько сейчас времени?' }],
      'low',
      1000,
      { tools: [tool] },
    );
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.tools?.some((entry) => entry.function.name === 'get_current_datetime'));
    const returnedTool = requests[1]?.messages.find((message) => message.role === 'tool');
    assert.ok(returnedTool?.content);
    assert.equal(JSON.parse(returnedTool.content).time_zone, 'Europe/Moscow');
    assert.equal(response.content, 'В Москве 02:59.');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
