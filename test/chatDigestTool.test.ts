import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatDigestTool } from '../src/services/ai/tools/chatDigestTool.js';

type StartResult =
  | { status: 'accepted'; jobId: string }
  | { status: 'already_running'; jobId: string; requestedCount?: number | null };

const DEFAULT_START_RESULT: StartResult = { status: 'accepted', jobId: 'job-1' };
const DEFAULT_ACCESS: { allowed: true } = { allowed: true };

function digestTool(
  startResult: StartResult = DEFAULT_START_RESULT,
  access: { allowed: true } | { allowed: false; message: string } = DEFAULT_ACCESS,
) {
  const requests: unknown[] = [];
  const acknowledgements: string[] = [];
  let started = false;
  const tool = createChatDigestTool({
    checkAccess: async () => access,
    startJob: async (request) => {
      requests.push(request);
      return startResult;
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
    acknowledgements,
    wasStarted: () => started,
  };
}

test('get_chat_digest starts a background job and acknowledges it', async () => {
  const { tool, requests, acknowledgements, wasStarted } = digestTool();
  const result = JSON.parse(await tool.execute({ count: 6_000 }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.job_id, 'job-1');
  assert.equal(requests.length, 1);
  assert.equal((requests[0] as { count?: number }).count, 6_000);
  assert.match(acknowledgements[0] ?? '', /принял/iu);
  assert.equal(wasStarted(), true);
});

test('get_chat_digest reports an already running job without starting another', async () => {
  const { tool, requests, acknowledgements } = digestTool({
    status: 'already_running',
    jobId: 'job-active',
    requestedCount: 6_000,
  });
  const result = JSON.parse(await tool.execute({ count: 6_000 }));
  assert.equal(result.status, 'already_running');
  assert.equal(result.job_id, 'job-active');
  assert.equal(requests.length, 1);
  assert.match(acknowledgements[0] ?? '', /уже выполняется/iu);
});

test('get_chat_digest redirects short requests to local history', async () => {
  const { tool, requests } = digestTool();
  const result = JSON.parse(await tool.execute({ count: 10 }));
  assert.equal(result.status, 'not_executed');
  assert.match(result.message, /get_local_chat_history/u);
  assert.equal(requests.length, 0);

  const boundary = JSON.parse(await tool.execute({ count: 20 }));
  assert.equal(boundary.status, 'not_executed');

  const allowed = JSON.parse(await tool.execute({ count: 21 }));
  assert.equal(allowed.status, 'accepted');
  assert.equal(requests.length, 1);
});

test('get_chat_digest validates count and period', async () => {
  const { tool, requests } = digestTool();
  const both = JSON.parse(
    await tool.execute({ count: 100, from: '2026-11-01T00:00:00Z', to: '2026-11-13T00:00:00Z' }),
  );
  assert.equal(both.status, 'not_executed');
  assert.equal(requests.length, 0);

  const invalidCount = JSON.parse(await tool.execute({ count: 0 }));
  assert.equal(invalidCount.status, 'not_executed');

  const invalidRange = JSON.parse(
    await tool.execute({ from: '2026-11-13T00:00:00Z', to: '2026-11-01T00:00:00Z' }),
  );
  assert.equal(invalidRange.status, 'not_executed');
});

test('get_chat_digest has no hard message count limit', async () => {
  const { tool, requests } = digestTool();
  const result = JSON.parse(await tool.execute({ count: 1_000_000 }));
  assert.equal(result.status, 'accepted');
  assert.equal((requests[0] as { count?: number }).count, 1_000_000);
});

test('get_chat_digest respects access denial', async () => {
  const { tool, requests, acknowledgements } = digestTool(
    { status: 'accepted', jobId: 'job-1' },
    { allowed: false, message: 'Нет доступа' },
  );
  const result = JSON.parse(await tool.execute({ count: 100 }));
  assert.equal(result.status, 'not_executed');
  assert.equal(requests.length, 0);
  assert.equal(acknowledgements.length, 0);
});
