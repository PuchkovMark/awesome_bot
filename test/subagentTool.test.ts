import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParticipantResolution } from '../src/services/memory/memoryService.js';
import {
  createSubagentTool,
  type SubagentRequest,
  type SubagentStartResult,
} from '../src/services/ai/tools/subagentTool.js';

function makeTool(
  options: {
    available?: number;
    availableChars?: number;
    capped?: boolean;
    start?: SubagentStartResult;
    isChat?: boolean;
    resolution?: ParticipantResolution;
  } = {},
) {
  const requests: SubagentRequest[] = [];
  const estimateRequests: Array<{
    count?: number;
    from?: Date;
    to?: Date;
    participantUserIds?: string[];
    includeBot?: boolean;
  }> = [];
  const acknowledgements: string[] = [];
  let started = false;
  const tool = createSubagentTool({
    isChat: options.isChat ?? true,
    resolveParticipants: async () =>
      options.resolution ?? { participants: [], ambiguous: [], notFound: [] },
    estimateMessages: async (input) => {
      estimateRequests.push(input);
      const count = options.available ?? 500;
      return {
        count,
        chars: options.availableChars ?? count * 100,
        capped: options.capped ?? false,
      };
    },
    startJob: async (request) => {
      requests.push(request);
      return options.start ?? { status: 'accepted', jobId: 'job-1' };
    },
    acknowledge: async (message) => {
      acknowledgements.push(message);
    },
    onStarted: () => {
      started = true;
    },
  });
  return {
    tool,
    requests,
    estimateRequests,
    acknowledgements,
    wasStarted: () => started,
  };
}

test('run_subagent rejects short history and suggests local history', async () => {
  const { tool, requests } = makeTool({ available: 50 });
  const result = JSON.parse(
    await tool.execute({ task: 'Перескажи последние сообщения', count: 50 }),
  );
  assert.equal(result.status, 'not_executed');
  assert.match(result.message, /get_local_chat_history/u);
  assert.equal(requests.length, 0);
});

test('run_subagent rejects more than the maximum available messages', async () => {
  const { tool, requests } = makeTool({ available: 3_500 });
  const result = JSON.parse(
    await tool.execute({ task: 'Перескажи последние сообщения', count: 50_000 }),
  );
  assert.equal(result.status, 'not_executed');
  assert.equal(result.reason, 'too_many_messages');
  assert.equal(result.available_count, 3_500);
  assert.equal(result.max_messages, 3_000);
  assert.match(result.message, /Максимум.*3000/u);
  assert.equal(requests.length, 0);
});

test('run_subagent rejects a period with more than 3000 messages', async () => {
  const { tool, requests } = makeTool({ available: 3_500 });
  const result = JSON.parse(
    await tool.execute({
      task: 'Перескажи вчерашний вечер',
      from: '2026-11-13T14:00:00+03:00',
      to: '2026-11-13T22:00:00+03:00',
    }),
  );
  assert.equal(result.status, 'not_executed');
  assert.equal(result.reason, 'too_many_messages');
  assert.equal(result.period.from, '2026-11-13T11:00:00.000Z');
  assert.equal(result.period.to, '2026-11-13T19:00:00.000Z');
  assert.match(result.message, /Сузьте диапазон/u);
  assert.equal(requests.length, 0);
});

test('run_subagent rejects too much text even when messages fit', async () => {
  const { tool, requests } = makeTool({ available: 2_500, availableChars: 400_000 });
  const result = JSON.parse(
    await tool.execute({ task: 'Перескажи последние сообщения', count: 2_500 }),
  );
  assert.equal(result.status, 'not_executed');
  assert.equal(result.reason, 'too_many_chars');
  assert.equal(result.available_chars, 400_000);
  assert.equal(result.max_chars, 300_000);
  assert.equal(requests.length, 0);
});

test('run_subagent accepts a large request when SQL has fewer messages than requested', async () => {
  const { tool, requests, acknowledgements, wasStarted } = makeTool({ available: 2_500 });
  const result = JSON.parse(
    await tool.execute({ task: 'Перескажи большой период истории', count: 50_000 }),
  );
  assert.equal(result.status, 'accepted');
  assert.equal(result.available_count, 2_500);
  assert.equal(requests.length, 1);
  assert.match(acknowledgements[0] ?? '', /2500/u);
  assert.equal(wasStarted(), true);
});

test('run_subagent passes format and output limit to the job', async () => {
  const { tool, requests } = makeTool({ available: 2_500 });
  const result = JSON.parse(
    await tool.execute({
      task: 'Составь хронологию обсуждения ремонта',
      count: 2_500,
      format: 'timeline',
      max_output_chars: 2_000,
    }),
  );
  assert.equal(result.status, 'accepted');
  assert.equal(requests[0]?.format, 'timeline');
  assert.equal(requests[0]?.maxOutputChars, 2_000);
  assert.equal(result.parts, 2);
});

test('run_subagent uses one part for a small history', async () => {
  const { tool } = makeTool({ available: 400 });
  const result = JSON.parse(
    await tool.execute({
      task: 'Перескажи обсуждение ремонта',
      count: 400,
    }),
  );
  assert.equal(result.status, 'accepted');
  assert.equal(result.parts, 1);
});

test('run_subagent reports an already running job without acknowledging', async () => {
  const { tool, acknowledgements } = makeTool({
    start: { status: 'already_running', jobId: 'job-active' },
  });
  const result = JSON.parse(
    await tool.execute({ task: 'Перескажи последние сообщения', count: 500 }),
  );
  assert.equal(result.status, 'already_running');
  assert.equal(acknowledgements.length, 0);
});

test('run_subagent passes participants to the job', async () => {
  const { tool, requests, estimateRequests, acknowledgements } = makeTool({
    available: 500,
    resolution: {
      participants: [
        { kind: 'user', name: 'Иван', vkId: '1', dbUserId: 'db-1' },
        { kind: 'bot', name: 'Пенёк' },
      ],
      ambiguous: [],
      notFound: [],
    },
  });
  const result = JSON.parse(
    await tool.execute({
      task: 'Перескажи сообщения Ивана и Пенька',
      count: 500,
      participants: ['Иван', 'Пенёк'],
    }),
  );
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.participants, ['Иван', 'Пенёк']);
  assert.deepEqual(requests[0]?.participants, [
    { kind: 'user', name: 'Иван', vkId: '1', dbUserId: 'db-1' },
    { kind: 'bot', name: 'Пенёк' },
  ]);
  assert.deepEqual(estimateRequests[0]?.participantUserIds, ['db-1']);
  assert.equal(estimateRequests[0]?.includeBot, true);
  assert.match(acknowledgements[0] ?? '', /Иван, Пенёк/u);
});

test('run_subagent rejects participant filters in direct dialogs', async () => {
  const { tool, requests } = makeTool({ isChat: false });
  const result = JSON.parse(
    await tool.execute({
      task: 'Перескажи сообщения Ивана',
      count: 500,
      participants: ['Иван'],
    }),
  );
  assert.equal(result.status, 'not_executed');
  assert.match(result.message, /групповой/u);
  assert.equal(requests.length, 0);
});

test('run_subagent reports ambiguous participants', async () => {
  const { tool, requests } = makeTool({
    resolution: {
      participants: [],
      ambiguous: [
        {
          reference: 'Иван',
          candidates: [
            { kind: 'user', name: 'Иван', vkId: '1' },
            { kind: 'user', name: 'Иван', vkId: '2' },
          ],
        },
      ],
      notFound: [],
    },
  });
  const result = JSON.parse(
    await tool.execute({
      task: 'Перескажи сообщения Ивана',
      count: 500,
      participants: ['Иван'],
    }),
  );
  assert.equal(result.status, 'needs_clarification');
  assert.equal(requests.length, 0);
});

test('run_subagent validates input and period', async () => {
  const { tool, requests } = makeTool();

  const invalidTask = JSON.parse(await tool.execute({ task: 'коротко', count: 500 }));
  assert.equal(invalidTask.status, 'not_executed');

  const both = JSON.parse(
    await tool.execute({
      task: 'Перескажи последние сообщения',
      count: 500,
      from: '2026-11-13T00:00:00Z',
      to: '2026-11-14T00:00:00Z',
    }),
  );
  assert.equal(both.status, 'not_executed');

  const invalidRange = JSON.parse(
    await tool.execute({
      task: 'Перескажи последние сообщения',
      from: '2026-11-14T00:00:00Z',
      to: '2026-11-13T00:00:00Z',
    }),
  );
  assert.equal(invalidRange.status, 'not_executed');

  const future = JSON.parse(
    await tool.execute({
      task: 'Перескажи последние сообщения',
      from: '2999-01-01T00:00:00Z',
      to: '2999-01-02T00:00:00Z',
    }),
  );
  assert.equal(future.status, 'not_executed');

  assert.equal(requests.length, 0);
});
