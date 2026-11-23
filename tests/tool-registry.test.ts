import { test, expect, vi } from 'vitest';
import type { ToolContext } from '../src/contracts/index';
import { authorizationFixture } from './helpers/authorization-fixture';
import { scopeForService } from './helpers/connection-scope';
import { FakeAdapter } from './helpers/fake-adapters';
import { createToolRegistry, type RuntimeTool } from '../src/tools/registry';

test.each(['test-a', 'test-b'] as const)(
  'реестр использует платформу, выданные схемы и свежие возможности %s',
  async (platform) => {
    const f = await authorizationFixture();
    try {
      const adapter = new FakeAdapter(platform),
        chatId = `${platform}:one` as const,
        userId = `${platform}:actor` as const;
      const ctx: ToolContext = {
        platform,
        chatId,
        userId,
        adapter,
        isAdmin: true,
        authorization: f.service.context({ scope: scopeForService(f.service, chatId), userId }),
      };
      const execute = vi.fn(async () => ({ text: 'факт' }));
      const base: RuntimeTool = {
        name: 'common',
        description: 'прочитать',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        access: 'read',
        execute,
      };
      const r = createToolRegistry(
        [
          base,
          { ...base, name: 'a_only', platforms: ['test-a'] },
          { ...base, name: 'typing', requiredCapabilities: ['typing'] },
          { ...base, name: 'unknown', requiredCapabilities: ['adminInfo'] },
          { ...base, name: 'none', platforms: [] },
          { ...base, name: 'write', access: 'write' },
        ],
        ctx,
        () => true,
      );
      const issued = await r.schemas();
      expect(issued.map((t) => t.name)).toEqual(
        platform === 'test-a' ? ['common', 'a_only', 'typing', 'write'] : ['common', 'write'],
      );
      const call = (name: string, parameters: string, offer = issued) =>
        r.execute({ id: 't', name, arguments: parameters }, offer);
      for (const args of ['bad', '{"chatId":"foreign","query":"q"}', '{"query":2}'])
        expect((await call('common', args)).outcome).toBe('denied');
      expect((await call('common', '{"query":"q"}', [])).outcome).toBe('denied');
      expect((await call('write', '{"query":"q"}')).outcome).toBe('denied');
      const old = await adapter.capabilities({ chatId });
      vi.spyOn(adapter, 'capabilities').mockResolvedValue({
        ...old,
        support: { ...old.support, typing: 'unknown' },
      });
      expect((await call('typing', '{"query":"q"}')).outcome).toBe('denied');
      expect(execute).not.toHaveBeenCalled();
      expect((await call('common', '{"query":"q"}')).outcome).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(() => createToolRegistry([base, base], ctx, () => true)).toThrow();
    } finally {
      await f.close();
    }
  },
);
