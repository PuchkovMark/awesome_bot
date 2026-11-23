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

test('два полных тёзки получают свои формы, после сброса используется новая фамилия VK', async () => {
  const f = await fixture({ profileNotice, active: true });
  try {
    f.name(41, 'Саша', 'Иванов');
    f.name(42, 'Саша', 'Иванов');
    f.at(1000);
    await f.journaled(f.submit('Встречаемся у фонтана', 41));
    await f.journaled(f.submit('Встречаемся у маяка', 42));
    f.submit('Пенёк, называй меня Рысь «тест» [id29|ник]', 41);
    await until(() =>
      expect(
        addressPreferenceStore(f.storage).resolve(f.scope, user, f.start + 1000, true)?.text,
      ).toBe('Рысь «тест» [id29|ник]'),
    );
    const first = f.submit('[club314|Пенёк] Что я предложил?', 41);
    const second = f.submit('[club314|Пенёк] Что я предложил?', 42);
    await f.published(first);
    await f.published(second);
    const blocks = f.complete.mock.calls.map(([input]) => JSON.parse(input.messages.at(-1)!.text!));
    expect(blocks[0].current).toMatchObject({
      author: 'Саша Иванов',
      addressForm: 'Рысь «тест» [id29|ник]',
      authorLabel: 'u1',
    });
    expect(blocks[1].current).toMatchObject({
      author: 'Саша Иванов',
      addressForm: 'Саша Иванов',
      authorLabel: 'u2',
    });
    expect(
      blocks[0].history.find((entry: { text: string }) => entry.text.includes('маяка')),
    ).toMatchObject({ author: 'Саша Иванов', authorLabel: 'u2' });
    expect(blocks[0].history.every((entry: object) => !Object.hasOwn(entry, 'addressForm'))).toBe(
      true,
    );
    f.name(41, 'Саша', 'Петров');
    f.at(302_000);
    f.submit('Пенёк, обращайся ко мне как в VK');
    await until(() =>
      expect(
        addressPreferenceStore(f.storage).resolve(f.scope, user, f.start + 302000, true),
      ).toBeUndefined(),
    );
    const after = f.submit('[club314|Пенёк] Что я предложил?', 41);
    await f.published(after);
    const latest = JSON.parse(f.complete.mock.lastCall![0].messages.at(-1)!.text!);
    expect(latest.current).toMatchObject({
      author: 'Саша Петров',
      addressForm: 'Саша Петров',
      authorLabel: 'u1',
    });
    expect(f.sends.filter((row) => row.reply_message).every((row) => row.peer_id === peer)).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test.each(['скрытие', 'сброс', 'отключение'] as const)(
  '%s во время генерации удерживает устаревшую публикацию',
  async (change) => {
    const f = await fixture({ profileNotice, active: true });
    try {
      f.name(41, 'Саша');
      f.at(1000);
      const secret = 'ЛичныйМаркерF52';
      f.submit('Пенёк, называй меня ' + secret);
      await until(() =>
        expect(
          addressPreferenceStore(f.storage).resolve(f.scope, user, f.start + 1000, true)?.text,
        ).toBe(secret),
      );
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      f.complete.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
        return { kind: 'complete', text: secret + ', ответ.', usage: { input: 1, output: 1 } };
      });
      const first = f.submit('[club314|Пенёк] Вопрос', 41);
      await entered.promise;
      if (change === 'отключение')
        personalDataStore(f.storage).disable(f.scope, user, f.start + 1000);
      else
        f.submit(
          change === 'скрытие' ? 'Пенёк, скрой моё обращение' : 'Пенёк, обращайся ко мне как в VK',
        );
      await until(() =>
        expect(
          addressPreferenceStore(f.storage).resolve(f.scope, user, f.start + 1000, true),
        ).toBeUndefined(),
      );
      finish.resolve();
      expect((await f.trace(first)).payload.publication).toMatchObject({
        status: 'suppressed',
        reason: 'address_preference_changed',
      });
      expect(f.sends.some((row) => row.text.includes(secret))).toBe(false);
      const next = f.submit('[club314|Пенёк] Новый вопрос', 41);
      await f.published(next);
      const request = f.complete.mock.lastCall![0];
      expect(JSON.parse(request.messages.at(-1)!.text!).current).toMatchObject({
        addressForm: 'Саша',
      });
      expect(JSON.stringify(request)).not.toContain(secret);
      expect(f.sends.some((row) => row.text.includes(secret))).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.each(['до', 'после'] as const)(
  'отключение профиля %s отправки учитывает фактическую доставку',
  async (when) => {
    const f = await fixture({ profileNotice, active: true, hold: when === 'до' });
    try {
      f.at(1000);
      f.submit('Пенёк, называй меня Рысь');
      await until(() =>
        expect(
          addressPreferenceStore(f.storage).resolve(f.scope, user, f.start + 1000, true)?.text,
        ).toBe('Рысь'),
      );
      const text = 'Рысь, обычный ответ.';
      const disable = () => personalDataStore(f.storage).disable(f.scope, user, f.start + 1000);
      if (when === 'после')
        f.failSend((outgoing) => {
          if (outgoing === text) disable();
          return undefined;
        });
      f.complete.mockResolvedValueOnce({ kind: 'complete', text, usage: { input: 1, output: 1 } });
      const question = f.submit('[club314|Пенёк] Вопрос', 41);
      if (when === 'до') {
        await until(() => expect(f.holds).toHaveLength(1));
        disable();
        f.holds[0]!.release();
      }
      expect((await f.trace(question)).payload.publication).toMatchObject(
        when === 'до'
          ? { status: 'suppressed', reason: 'address_preference_changed' }
          : { status: 'delivered', reason: 'none' },
      );
      const sent = f.sends.find((row) => row.text === text);
      if (when === 'до') expect(sent).toBeUndefined();
      else {
        expect(sent?.reply_message?.conversation_message_id).toBe(question);
        const recorded = f.db
          .prepare('SELECT id FROM messages WHERE chat_id=? AND platform_message_id=?')
          .get(f.scope.chatId, String(sent!.conversation_message_id)) as { id: number };
        expect(await f.storage.messages.get(f.scope, recorded.id)).toMatchObject({
          text,
          role: 'assistant',
        });
      }
    } finally {
      await f.close();
    }
  },
);
