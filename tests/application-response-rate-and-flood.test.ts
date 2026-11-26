import { expect, test } from 'vitest';
import type { LlmResult } from '../src/llm/types';
import { noticeTemplate } from '../src/storage/notice-types';
import {
  answer,
  chat,
  fixture,
  mention,
  refusal,
  until,
} from './helpers/application-response-fixture';

test('reply боту без упоминания молчит в 35.999 и снова допускается ровно в 36.000', async () => {
  const f = await fixture({ limit: 20 });
  try {
    f.at(-1000);
    await f.published(f.submit('Пенёк, ответь'));
    const bot = f.sends[0]!;
    for (let time = 0; time <= 8000; time += 2000) {
      f.at(time);
      await f.published(f.submit(mention));
    }
    expect(f.sends.filter((row) => row.text === refusal)).toHaveLength(1);
    for (const time of [17000, 26000]) {
      f.at(time);
      await f.journaled(f.submit(mention));
    }
    f.at(35999);
    const suppressed = f.submit('Уточни ответ', 42, bot);
    await f.journaled(suppressed);
    expect(f.complete).toHaveBeenCalledTimes(5);
    expect(f.sends.some((row) => row.reply_message?.conversation_message_id === suppressed)).toBe(
      false,
    );
    f.at(36000);
    await f.published(f.submit('Уточни ответ', 42, bot));
    expect(f.complete).toHaveBeenCalledTimes(6);
    expect(f.sends.filter((row) => row.text === refusal)).toHaveLength(1);
    expect(f.sends.some((row) => row.reply_message?.conversation_message_id === suppressed)).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('отказ из первого всплеска после ожидания лимитера VK не тратит ресурсы второго', async () => {
  const f = await fixture({ threshold: 1, window: 1000, hold: true });
  try {
    f.submit(mention);
    await until(() => expect(f.holds).toHaveLength(1));
    f.at(1000);
    f.submit(mention);
    await until(() => expect(f.holds).toHaveLength(2));
    f.holds[0]!.release();
    await f.holds[0]!.finished;
    expect(f.sends).toHaveLength(0);
    expect(f.slots()).toBe(0);
    expect(f.notices()).toBe(0);
    expect(f.complete).toHaveBeenCalledTimes(0);
    f.holds[1]!.release();
    await until(() => expect(f.sends.map((row) => row.text)).toEqual([refusal]));
    expect(f.slots()).toBe(1);
    expect(f.notices()).toBe(1);
  } finally {
    await f.close();
  }
});

test.each([true, false])(
  'одно место и один победитель при порядке с отказом первым: %s',
  async (refusalFirst) => {
    const f = await fixture({ threshold: 1, hold: true });
    try {
      f.seedSlots(5);
      const model = Promise.withResolvers<LlmResult>();
      f.complete.mockImplementationOnce(() => model.promise);
      const ordinary = f.submit('Пенёк, ответь');
      await until(() => expect(f.complete).toHaveBeenCalledTimes(1));
      const flood = f.submit(mention, 42);
      await until(() => expect(f.holds).toHaveLength(1));
      model.resolve(answer);
      await until(() => expect(f.holds).toHaveLength(2));
      f.holds[refusalFirst ? 0 : 1]!.release();
      await f.published(refusalFirst ? flood : ordinary);
      f.holds[refusalFirst ? 1 : 0]!.release();
      await f.holds[refusalFirst ? 1 : 0]!.finished;
      expect(f.sends).toHaveLength(1);
      expect(f.slots()).toBe(6);
      expect(f.notices()).toBe(refusalFirst ? 1 : 0);
      f.at(1000);
      await f.journaled(f.submit(mention, 43));
      expect(f.sends).toHaveLength(1);
      expect(f.complete).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  },
);

test('полный предел подавляет оба коротких отказа, а нейтральное уведомление может стать седьмым', async () => {
  const f = await fixture({ threshold: 1, userRequests: 6 });
  const model = Promise.withResolvers<LlmResult>();
  try {
    for (let i = 0; i < 6; i++) await f.published(f.submit('Пенёк, ответь'));
    await f.suppressed(f.submit('Пенёк, ответь'));
    await f.journaled(f.submit(mention));
    expect(f.sends).toHaveLength(6);
    expect(f.slots()).toBe(6);
    expect(f.notices()).toBe(0);
    expect(f.complete).toHaveBeenCalledTimes(6);

    f.at(10000);
    f.complete.mockImplementationOnce(() => model.promise);
    const botReply = f.sends[0]!;
    f.submit('Ответь', 51, botReply);
    await until(() => expect(f.complete).toHaveBeenCalledTimes(7));
    f.submit('Ответь', 52, botReply);
    f.submit('Ответь', 53, botReply);
    await f.published(f.submit('Ответь', 54, botReply));
    expect(f.sends.map((row) => row.text)).toEqual([
      ...Array<string>(6).fill(answer.text),
      noticeTemplate('generic'),
    ]);
    expect(f.slots()).toBe(6);
    expect(f.notices()).toBe(1);
  } finally {
    model.resolve(answer);
    await f.close();
  }
});

test('всплеск подавляет ранее поставленное задание до списания F4.3', async () => {
  const f = await fixture({ threshold: 1 });
  const model = Promise.withResolvers<LlmResult>();
  try {
    f.complete.mockImplementationOnce(() => model.promise);
    const admitted = f.submit('Пенёк, ответь');
    await until(() => expect(f.complete).toHaveBeenCalledTimes(1));
    const queued = f.submit('Пенёк, ответь', 42);
    await f.journaled(queued);
    await until(() =>
      expect(
        f.db
          .prepare(
            `SELECT a.state FROM group_reply_assessments a
      JOIN messages m ON m.id=a.message_id WHERE m.platform_message_id=? AND m.chat_id=?`,
          )
          .pluck()
          .get(String(queued), chat),
      ).toBe('queued'),
    );
    await f.published(f.submit(mention, 43));
    model.resolve(answer);
    await f.published(admitted);
    await f.interrupted(queued);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.requests()).toBe(1);
    expect(f.sends.map((row) => row.text)).toEqual([refusal, answer.text]);
  } finally {
    model.resolve(answer);
    await f.close();
  }
});
