import { describe, expect, test } from 'vitest';
import type { PlatformAvailability, ToolContext, ToolDefinition, UserId } from '../src/contracts/index';
import { FakeAdapter } from './helpers/fake-adapters';

// Демонстрационный инструмент: продуктовые инструменты и реестр здесь не создаются.
const lookupName: ToolDefinition<{ userId: UserId }, string | null> = {
  name: 'example_name', description: 'Получить имя указанного участника через текущий адаптер.',
  parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'], additionalProperties: false },
  access: 'read', requiredCapabilities: ['getUserName'],
  execute: async ({ userId }, context) => context.adapter.getUserName(userId),
};

describe('контракт инструмента', () => {
  test.each(['test-a', 'test-b'] as const)('нейтральная операция через адаптер %s', async (platform) => {
    const adapter = new FakeAdapter(platform);
    const other = new FakeAdapter(platform === 'test-a' ? 'test-b' : 'test-a');
    const context: ToolContext = { chatId: `${platform}:chat`, platform, userId: `${platform}:caller`, isAdmin: 'unknown', adapter };
    expect(await lookupName.execute({ userId: `${platform}:known` }, context)).toBe(`Имя ${platform}`);
    expect(await lookupName.execute({ userId: `${platform}:missing` }, context)).toBeNull();
    expect(adapter.nameRequests).toEqual([`${platform}:known`, `${platform}:missing`]);
    expect(other.nameRequests).toEqual([]);
  });

  test('описания чтения и изменения сериализуют схему как JSON', () => {
    const write: ToolDefinition<{ value: string }, void> = {
      name: 'example_write', description: 'Пример изменяющего описания без продуктового действия.',
      access: 'write', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      execute: async () => {},
    };
    expect([lookupName.access, write.access]).toEqual(['read', 'write']);
    expect(JSON.parse(JSON.stringify(lookupName.parameters))).toEqual(lookupName.parameters);
    expect(JSON.parse(JSON.stringify(write.parameters))).toEqual(write.parameters);
    expect(lookupName.parameters).not.toHaveProperty('properties.chatId');
    expect(lookupName.parameters).not.toHaveProperty('properties.platform');
    expect(lookupName.parameters).not.toHaveProperty('properties.role');
  });

  test('представляет все варианты доступности отдельно от требований', () => {
    const variants: (PlatformAvailability | undefined)[] = [undefined, 'all', ['test-a'], []];
    const descriptions = variants.map((platforms) => ({
      ...lookupName, ...(platforms === undefined ? {} : { platforms }),
    } satisfies ToolDefinition<{ userId: UserId }, string | null>));
    expect(descriptions.map((description) => description.platforms)).toEqual(variants);
    for (const description of descriptions) {
      expect(description.requiredCapabilities).toEqual(['getUserName']);
    }
    // Список — метаданные; фактический отбор реализуется в F5.6.
  });
});
