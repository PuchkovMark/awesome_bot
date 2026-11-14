import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSubagentStatusTool,
  type SubagentStatus,
} from '../src/services/ai/tools/subagentStatusTool.js';

type Access = { allowed: true } | { allowed: false; message: string };

function makeTool(status: SubagentStatus, access?: Access) {
  const resolvedAccess: Access = access ?? { allowed: true };
  const tool = createSubagentStatusTool({
    checkAccess: async () => resolvedAccess,
    getStatus: async () => status,
  });
  return tool;
}

test('get_subagent_status returns a completed result', async () => {
  const tool = makeTool({
    status: 'done',
    task: 'Перескажи 6000 сообщений',
    format: 'summary',
    participants: ['Иван', 'Пенёк'],
    partsTotal: 2,
    partsDone: 2,
    delivered: true,
    result: 'Готовый пересказ.',
    createdAt: '2026-11-14T10:00:00.000Z',
    completedAt: '2026-11-14T10:05:00.000Z',
  });
  const result = JSON.parse(await tool.execute({}));
  assert.equal(result.status, 'done');
  assert.equal(result.result, 'Готовый пересказ.');
  assert.deepEqual(result.participants, ['Иван', 'Пенёк']);
  assert.equal(result.partsDone, 2);
  assert.match(result.instruction, /данные/u);
});

test('get_subagent_status reports running and failed states', async () => {
  const running = JSON.parse(
    await makeTool({ status: 'processing', task: 'Задача', partsTotal: 2, partsDone: 1 }).execute(
      {},
    ),
  );
  assert.equal(running.status, 'processing');
  assert.equal(running.result, undefined);

  const failed = JSON.parse(
    await makeTool({ status: 'failed', task: 'Задача', error: 'Не удалось' }).execute({}),
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Не удалось');
});

test('get_subagent_status handles no job and access denial', async () => {
  const none = JSON.parse(await makeTool({ status: 'none' }).execute({}));
  assert.equal(none.status, 'none');

  const denied = JSON.parse(
    await makeTool({ status: 'none' }, { allowed: false, message: 'Нет доступа' }).execute({}),
  );
  assert.equal(denied.status, 'not_executed');
  assert.equal(denied.message, 'Нет доступа');
});

test('get_subagent_status rejects arguments', async () => {
  const tool = makeTool({ status: 'none' });
  const result = JSON.parse(await tool.execute({ job_id: 'x' }));
  assert.equal(result.status, 'not_executed');
});
