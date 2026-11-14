import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.LOG_LEVEL = 'silent';

const { prisma } = await import('../src/db/client.js');
const { default: subagentService } = await import('../src/services/ai/subagentService.js');
const { default: senderService } = await import('../src/services/sender/senderService.js');
const { default: subagentResultDeliveryService } =
  await import('../src/services/ai/subagentResultDeliveryService.js');

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    conversationId: '2000000001',
    userId: '42',
    activeKey: '2000000001',
    kind: 'history_task',
    status: 'done',
    instruction: 'Перескажи историю',
    format: 'summary',
    requestedCount: 600,
    rangeFrom: null,
    rangeTo: null,
    maxDigestChars: 15_000,
    maxOutputChars: 3_500,
    parts: 2,
    participants: null,
    partResults: JSON.stringify([
      {
        index: 0,
        status: 'done',
        from: '2026-11-14T10:00:00Z',
        to: '2026-11-14T10:05:00Z',
        messages: 300,
        result: 'a',
      },
      {
        index: 1,
        status: 'done',
        from: '2026-11-14T10:05:00Z',
        to: '2026-11-14T10:10:00Z',
        messages: 300,
        result: 'b',
      },
    ]),
    messageId: 1,
    conversationMessageId: 1,
    digests: null,
    result: 'Готовый пересказ',
    error: null,
    createdAt: new Date('2026-11-14T10:00:00Z'),
    updatedAt: new Date('2026-11-14T10:00:00Z'),
    completedAt: new Date('2026-11-14T10:05:00Z'),
    resultSentAt: new Date('2026-11-14T10:05:00Z'),
    ...overrides,
  };
}

function mockMethod(
  t: TestContext,
  target: object,
  method: string,
  implementation: (...args: unknown[]) => Promise<unknown>,
) {
  const original = Reflect.get(target, method);
  Reflect.set(target, method, implementation);
  t.after(() => {
    Reflect.set(target, method, original);
  });
}

test('startJob creates one job per conversation and uses conversationId as activeKey', async (t) => {
  let createdData: Record<string, unknown> | undefined;
  mockMethod(t, prisma.digestJob, 'findUnique', async (args: unknown) => {
    const where = (args as { where: { activeKey?: string } }).where;
    if (where.activeKey) return null;
    return jobRow();
  });
  mockMethod(t, prisma.digestJob, 'count', async () => 0);
  mockMethod(t, prisma.digestJob, 'create', async (args: unknown) => {
    createdData = (args as { data: Record<string, unknown> }).data;
    return { id: 'job-new' };
  });

  const result = await subagentService.startJob({
    conversationId: '2000000001',
    userId: '42',
    task: 'Перескажи 6000 сообщений',
    format: 'summary',
    maxOutputChars: 3_500,
    parts: 2,
    count: 6_000,
  });
  assert.equal(result.status, 'accepted');
  assert.equal(createdData?.activeKey, '2000000001');
  assert.equal(createdData?.kind, 'history_task');
  assert.equal(createdData?.parts, 2);
  await new Promise((resolve) => setImmediate(resolve));
});

test('startJob rejects a second active job in the same chat', async (t) => {
  mockMethod(t, prisma.digestJob, 'findUnique', async () =>
    jobRow({ status: 'processing', updatedAt: new Date() }),
  );
  const result = await subagentService.startJob({
    conversationId: '2000000001',
    userId: '42',
    task: 'Перескажи 6000 сообщений',
    format: 'summary',
    maxOutputChars: 3_500,
    parts: 1,
    count: 6_000,
  });
  assert.equal(result.status, 'already_running');
});

test('startJob enforces the daily limit', async (t) => {
  mockMethod(t, prisma.digestJob, 'findUnique', async () => null);
  mockMethod(t, prisma.digestJob, 'count', async () => 10);
  const result = await subagentService.startJob({
    conversationId: '2000000001',
    userId: '42',
    task: 'Перескажи 6000 сообщений',
    format: 'summary',
    maxOutputChars: 3_500,
    parts: 1,
    count: 6_000,
  });
  assert.equal(result.status, 'not_executed');
});

test('getLatestStatus returns the last job with parts and result', async (t) => {
  mockMethod(t, prisma.digestJob, 'findFirst', async () => jobRow());
  const status = await subagentService.getLatestStatus('2000000001');
  assert.equal(status.status, 'done');
  assert.equal(status.partsTotal, 2);
  assert.equal(status.partsDone, 2);
  assert.equal(status.result, 'Готовый пересказ');
  assert.equal(status.delivered, true);
});

test('cleanupOldJobs removes old completed jobs', async (t) => {
  mockMethod(t, prisma.digestJob, 'deleteMany', async () => ({ count: 3 }));
  const deleted = await subagentService.cleanupOldJobs();
  assert.equal(deleted, 3);
});

test('recoverJobs delegates unsent results without sending from the subagent', async (t) => {
  let sent = 0;
  let deliveredJobId: string | undefined;
  const job = jobRow({
    status: 'finalizing',
    activeKey: '2000000001',
    resultSentAt: null,
    updatedAt: new Date('2026-11-14T10:00:00Z'),
  });
  mockMethod(t, prisma.digestJob, 'findMany', async () => [job]);
  mockMethod(t, prisma.digestJob, 'update', async () => job);
  mockMethod(t, senderService, 'send', async () => {
    sent += 1;
  });
  mockMethod(t, subagentResultDeliveryService, 'deliver', async (jobId) => {
    deliveredJobId = String(jobId);
    return true;
  });
  await subagentService.recoverJobs();
  assert.equal(sent, 0);
  assert.equal(deliveredJobId, 'job-1');
});
