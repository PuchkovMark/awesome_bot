import { expect, test } from 'vitest';
import { fixture, peer, until } from './helpers/application-response-fixture';
import { addressPreferenceStore } from '../src/storage/address-preference-store';
import { personalDataStore } from '../src/storage/personal-data-store';

const profileNotice = 'Тестовое уведомление о профиле';
const user = 'vk:41';

test('команда меняет выбор только автора, скрытая форма остаётся личной и не попадает в журнал контекста', async () => {
  const f = await fixture({ profileNotice, active: true });
  try {
    f.at(1000);
    const store = addressPreferenceStore(f.storage);
    const first = f.submit('Пенёк, называй меня Рысь');
    await until(() =>
      expect(store.resolve(f.scope, user, f.start + 1000, true)?.text).toBe('Рысь'),
    );
    await until(() =>
      expect(f.sends.some((row) => row.text.includes('Настройка обращения'))).toBe(true),
    );
    for (const phrase of [
      'Пенёк, называй Машу Ягодой',
      'Пенёк, «называй меня Ягодой»',
      'Пенёк, друзья зовут меня Ягодой',
      'называй меня Ягодой',
    ])
      await f.journaled(f.submit(phrase, 73));
    await f.journaled(f.submit('Пенёк, называй меня Ягодой', 41, undefined, peer, true));
    expect(store.resolve(f.scope, user, f.start + 1000, true)?.text).toBe('Рысь');
    expect(store.resolve(f.scope, 'vk:73', f.start + 1000, true)).toBeUndefined();
    f.submit('Пенёк, скрой моё обращение');
    await until(() => expect(store.resolve(f.scope, user, f.start + 1000, true)).toBeUndefined());
    const secret = 'ЗакрытыйНикR43';
    const hidden = f.submit('Пенёк, называй меня ' + secret);
    await until(() =>
      expect(
        personalDataStore(f.storage).export(f.scope, user, f.start + 1000).addressPreference,
      ).toMatchObject({ form: secret, visibility: 'bot', source: 'self' }),
    );
    expect(await f.storage.contextMessages.search(f.scope, secret, 5, 128)).toEqual([]);
    expect(
      (await f.storage.messages.list(f.scope, { limit: 30 })).find(
        (row) => row.messageId === String(hidden),
      ),
    ).toMatchObject({ purpose: 'service_notice' });
    expect(f.sends.some((row) => row.text.includes(secret))).toBe(false);
    f.submit('Пенёк, обращайся ко мне как в VK');
    await until(() =>
      expect(
        personalDataStore(f.storage).export(f.scope, user, f.start + 1000).addressPreference,
      ).toBeNull(),
    );
    f.replay(first);
    await f.journaled(first);
    expect(store.resolve(f.scope, user, f.start + 1000, true)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('закрытый допуск, молчаливый режим и выключение блокируют запись', async () => {
  const f = await fixture();
  try {
    const store = addressPreferenceStore(f.storage);
    f.at(1000);
    await f.journaled(f.submit('Пенёк, называй меня Рысь'));
    await until(() =>
      expect(f.sends.some((row) => row.text.includes('доступный профиль'))).toBe(true),
    );
    expect(store.resolve(f.scope, user, f.start + 1000, true)).toBeUndefined();
    await f.storage.chats.update(f.scope, { responseMode: 'silent' });
    const count = f.sends.length;
    await f.journaled(f.submit('Пенёк, называй меня Клён', 73));
    await f.storage.chats.update(f.scope, { enabled: false });
    f.submit('Пенёк, называй меня Маяк', 73);
    expect(f.sends).toHaveLength(count);
    expect(f.db.prepare('SELECT * FROM address_preferences').all()).toEqual([]);
  } finally {
    await f.close();
  }
});

test('подтверждённое удаление и семидневная очистка убирают выбор из выгрузки', async () => {
  const f = await fixture({ profileNotice, active: true });
  try {
    f.at(1000);
    const privacy = personalDataStore(f.storage);
    const store = addressPreferenceStore(f.storage);
    f.submit('Пенёк, называй меня Рысь', 41);
    f.submit('Пенёк, называй меня Клён', 42);
    await until(() =>
      expect(f.db.prepare('SELECT count(*) FROM address_preferences').pluck().get()).toBe(2),
    );
    const request = privacy.requestDeletion(f.scope, 'vk:42', 'test', f.start + 1000);
    expect(privacy.confirmDeletion(f.scope, 'vk:42', request.code, f.start + 1000)).toBe(true);
    expect(store.resolve(f.scope, 'vk:42', f.start + 1000, true)).toBeUndefined();
    const cutoff = privacy.disable(f.scope, user, f.start + 1000);
    expect(store.resolve(f.scope, user, f.start + 1000, true)).toBeUndefined();
    expect(privacy.export(f.scope, user, cutoff - 1).addressPreference).toMatchObject({
      form: 'Рысь',
    });
    expect(privacy.purgeExpired(cutoff)).toBe(1);
    expect(privacy.export(f.scope, user, cutoff).addressPreference).toBeNull();
    expect(f.db.prepare('SELECT * FROM address_preferences').all()).toEqual([]);
  } finally {
    await f.close();
  }
});
