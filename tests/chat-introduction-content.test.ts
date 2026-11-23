import { expect, test } from 'vitest';
import { introductionText } from '../src/core/chat-onboarding/introduction-text';
import { canonicalTimezone, parseTimezoneCommand, timezoneCommand } from '../src/core/chat-onboarding/timezone';
import { splitVkText } from '../src/channels/vk/outbound-text';
import { describeVkRights } from '../src/channels/vk/introduction';

test('вступление описывает доступные возможности, а синоним пояса сводится к именованной зоне', () => {
  const url='https://example.test/disclosure/2';
  const intro=introductionText({provider:'OpenCode Go',dataPolicy:'history',storagePolicy:'one',detailsText:'Условия',detailsUrl:url,
    ownerContact:'Тестовый контакт',version:2,requiredVersion:2},'Europe/Moscow',describeVkRights(false),false);
  expect(intro).toContain('OpenCode Go');
  expect(intro).toContain('обращение и последние сообщения');
  expect(intro).toContain('Ограниченный режим VK');
  expect(intro).toContain(url);
  expect(intro).toContain('Тестовый контакт');
  expect(intro).toContain(timezoneCommand);
  expect(intro).not.toMatch(/\/выгрузить|\/удалить|город/iu);
  expect(splitVkText(intro)).toEqual([intro]);
  expect(parseTimezoneCommand(`${timezoneCommand} US/Eastern`)).toBe('US/Eastern');
  expect(parseTimezoneCommand(`Расскажи о команде ${timezoneCommand}`)).toBeNull();
  expect(canonicalTimezone('US/Eastern')).toBe('America/New_York');
  expect(canonicalTimezone('GMT')).toBe('UTC');
  expect(canonicalTimezone('+03:00')).toBeNull();
  expect(canonicalTimezone('Mars/Olympus')).toBeNull();
});
