import { expect, test } from 'vitest';
import { contextFixture, contextCapabilities } from './helpers/context';
import { formatEnvironment } from '../src/core/context/environment';
for (const platform of ['test-a', 'test-b'] as const)
  test(`реальный сборщик получает текущую платформу ${platform}, а unknown не становится правом`, async () => {
    const f = await contextFixture(`${platform}:ctx`);
    try {
      const a = await f.put('a', 'вопрос');
      const r = await f.builder.prepare(f.work(a.id));
      if (r.kind !== 'ready') throw Error(r.kind);
      expect(r.input.system).toContain(`"platform":"${platform}"`);
      expect(r.input.system).toContain('"directMessage":"unknown"');
      expect(r.input.system).not.toContain(f.scope.chatId);
    } finally {
      await f.storage.close();
    }
  });
test('UTC и таймзона чата различают дату, active в личке имеет normal', () => {
  const input = {
    now: Date.parse('2026-11-21T23:00:00Z'),
    timezone: 'Europe/Moscow',
    platform: 'test-a',
    capabilities: contextCapabilities('test-a:ctx'),
    route: { kind: 'direct_message', mode: 'active', isGroupChat: false },
  } as const;
  const env = JSON.parse(formatEnvironment(input));
  expect(env.utc).toBe('2026-11-21T23:00:00.000Z');
  expect(env.local).toContain('22.11.2026');
  expect(env.mode).toBe('normal');
  expect(JSON.parse(formatEnvironment({ ...input, timezone: 'UTC' })).local).toContain(
    '21.11.2026',
  );
});
