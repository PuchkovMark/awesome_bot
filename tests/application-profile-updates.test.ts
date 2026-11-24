import { expect, test } from 'vitest';
import { profileUpdateRequest } from '../src/core/profile-updates/request';
import { estimateRequestInput } from '../src/core/context/budget';
import type { ChatId } from '../src/contracts/index';
import type { LlmRequest, LlmResult } from '../src/llm/types';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { applyHistoryRetention } from '../src/storage/history-retention-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { chatRequestMetricsStore } from '../src/storage/chat-request-metrics-store';
import {
  answer,
  chat,
  fixture,
  mention,
  peer,
  until,
} from './helpers/application-response-fixture';

const notice = 'В этой беседе действует выбор использования профиля.';
type App = Awaited<ReturnType<typeof fixture>>;
type Input = { ref: string; author: string; text: string };

function isProfile(request: LlmRequest) {
  return request.system.startsWith('Extract stable facts');
}

function input(request: LlmRequest): Input[] {
  return JSON.parse(request.messages[0]?.text ?? '');
}

function result(
  ...items: { ref: string; author: string; field: string; value: string }[]
): LlmResult {
  return { kind: 'complete', text: JSON.stringify(items), usage: { input: 101, output: 19 } };
}

function pending(app: App, chatId: ChatId = chat): number {
  return app.db
    .prepare('SELECT count(*) FROM profile_update_waiting WHERE chat_id=?')
    .pluck()
    .get(chatId) as number;
}

async function appFixture() {
  return fixture({ profileNotice: notice, greetings: { members: [41, 42, 73] } });
}

function profileCalls(app: App) {
  return app.complete.mock.calls.map(([request]) => request).filter(isProfile);
}

test('прямое обращение даёт приоритет до фонового старта и отвечает во время фонового вызова', async () => {
  const f = await appFixture();
  try {
    const direct = Promise.withResolvers<LlmResult>();
    const background = Promise.withResolvers<LlmResult>();
    f.complete.mockImplementation(async (request) => {
      if (isProfile(request)) return background.promise;
      return f.complete.mock.calls.length === 1 ? direct.promise : answer;
    });
    f.at(1000);
    const first = f.submit(mention, 73);
    await until(() => expect(f.complete).toHaveBeenCalledOnce());
    for (let i = 0; i < 9; i++) await f.journaled(f.submit('Обычная реплика ' + i));
    expect(pending(f)).toBe(10);
    expect(profileCalls(f)).toEqual([]);
    direct.resolve(answer);
    await f.published(first);
    await until(() => expect(profileCalls(f)).toHaveLength(1));
    const held = profileCalls(f)[0]!;
    expect(input(held)).toHaveLength(10);
    expect(held).not.toHaveProperty('tools');
    expect(f.requests()).toBe(1);
    expect(tokenBudgetStore(f.storage).read(f.scope, true, Date.now()).profileUpdate.reserved).toBe(
      BigInt(estimateRequestInput(held) + held.maxOutputTokens),
    );
    f.at(2000);
    await f.published(f.submit(mention, 42));
    expect(f.requests()).toBe(2);
    background.resolve(result());
    await until(() => expect(pending(f)).toBe(1));
    const budget = tokenBudgetStore(f.storage).read(f.scope, true, Date.now());
    expect(budget.profileUpdate).toMatchObject({ confirmed: 120n, reserved: 0n });
    expect(budget.total.confirmed).toBe(124n);
    const metrics = chatRequestMetricsStore(f.storage).read(f.scope, 'day', 0, Date.now()).buckets;
    expect(metrics.find((bucket) => bucket.series === 'profile_update')?.totals).toMatchObject({
      attempts: 1n,
      input_tokens: 101n,
      output_tokens: 19n,
      unknown_input: 0n,
      unknown_output: 0n,
    });
    expect(f.sends.filter((row) => row.peer_id === peer).map((row) => row.text)).toEqual([
      answer.text,
      answer.text,
    ]);
  } finally {
    await f.close();
  }
});

test('сокращённая порция оставляет ожидание остальных реплик и удерживает резерв при неизвестном usage', async () => {
  const f = await appFixture();
  try {
    const text = 'Я люблю шахматы.';
    const sample = profileUpdateRequest([{ id: 1, user: 'vk:41', at: 0, text }], 'test', 1024);
    const cost = estimateRequestInput(sample) + sample.maxOutputTokens;
    tokenBudgetStore(f.storage).update(f.scope, true, { total: 20 * cost }, Date.now());
    f.complete.mockImplementation(async () => ({
      kind: 'complete',
      text: '[{"ref":"m1","author":"u1","field":"hobby","value":"шахматы"}]',
      usage: { input: null, output: 19 },
    }));
    f.at(1000);
    await f.journaled(f.submit(text));
    f.at(2000);
    for (let i = 0; i < 9; i++) await f.journaled(f.submit('Обычная запись ' + i));
    await until(() => expect(pending(f)).toBe(9));
    expect(profileCalls(f)).toHaveLength(1);
    expect(input(profileCalls(f)[0]!)).toEqual([{ ref: 'm1', author: 'u1', text }]);
    expect(f.storage.profileFacts.read(f.scope, 'vk:41').facts).toMatchObject([
      { fieldKey: 'interest', value: 'шахматы', sourceKind: 'inferred' },
    ]);
    expect(
      f.db.prepare('SELECT DISTINCT queued_at FROM profile_update_waiting').pluck().all(),
    ).toEqual([f.start + 2000]);
    expect(tokenBudgetStore(f.storage).read(f.scope, true, Date.now()).profileUpdate).toMatchObject(
      { confirmed: 19n, reserved: BigInt(estimateRequestInput(sample)) },
    );
    expect(f.requests()).toBe(0);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('тёзки, соседняя группа и личка имеют отдельное свидетельство и допуск', async () => {
  const f = await appFixture();
  try {
    f.name(41, 'Саша', 'Иванов');
    f.name(42, 'Саша', 'Иванов');
    const before = f.submit('Я живу в Старограде.');
    await f.journaled(before);
    expect(pending(f)).toBe(0);
    f.at(1000);
    const other = await f.connectGroup(peer + 1);
    f.submit('/профиль', 41, undefined, 41);
    const life = lifecycleBackend(f.storage);
    await until(() =>
      expect(disclosureStore(f.storage).gate(life.current('vk:41')).version).not.toBeNull(),
    );
    const dm = life.current('vk:41');
    f.sends.length = 0;
    f.at(2000);
    f.complete.mockImplementation(async (request) => {
      if (!isProfile(request)) return answer;
      const proposals = input(request).flatMap(({ ref, author, text }) => {
        const value = /^Я живу в ([^.]+)\.$/u.exec(text)?.[1];
        return value ? [{ ref, author, field: 'city', value }] : [];
      });
      return result(...proposals);
    });
    await f.journaled(f.submit('Я живу в Перми.', 41));
    await f.journaled(f.submit('Я живу в Томске.', 42));
    await f.journaled(f.submit('/скрыть секретную правку'));
    await f.journaled(f.submit('Я живу в Подмене.', 41, undefined, peer, true));
    f.submit('Я живу в Уфе.', 41, undefined, peer + 1);
    f.submit('Я живу в Туле.', 41, undefined, 41);
    await until(() => {
      expect(pending(f, other.chatId)).toBe(1);
      expect(pending(f, dm.chatId)).toBe(1);
      expect(pending(f)).toBe(2);
    });
    expect(profileCalls(f)).toHaveLength(0);
    f.at(3_602_000);
    await f.journaled(f.submit('/неизвестная-команда'));
    await until(() => expect(profileCalls(f)).toHaveLength(3));
    await until(() => {
      expect(f.storage.profileFacts.read(f.scope, 'vk:41').facts).toMatchObject([
        { value: 'Перми' },
      ]);
      expect(f.storage.profileFacts.read(f.scope, 'vk:42').facts).toMatchObject([
        { value: 'Томске' },
      ]);
      expect(f.storage.profileFacts.read(other, 'vk:41').facts).toMatchObject([{ value: 'Уфе' }]);
      expect(f.storage.profileFacts.read(dm, 'vk:41').facts).toMatchObject([{ value: 'Туле' }]);
    });
    const requests = profileCalls(f).map((r) => input(r).map(({ text }) => text));
    expect(requests).toEqual(
      expect.arrayContaining([
        ['Я живу в Перми.', 'Я живу в Томске.'],
        ['Я живу в Уфе.'],
        ['Я живу в Туле.'],
      ]),
    );
    expect(
      profileCalls(f)
        .map(({ sessionId }) => sessionId)
        .filter((id, i, ids) => ids.indexOf(id) === i),
    ).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test.each(['foreign-author', 'bad-ref', 'disable', 'deletion', 'expiry', 'generation'] as const)(
  'ответ с нарушением %s не пишет ни одного факта и не публикуется',
  async (fault) => {
    const f = await appFixture();
    try {
      f.at(2000);
      const held = Promise.withResolvers<LlmResult>();
      f.complete.mockImplementation(() => held.promise);
      await f.journaled(f.submit('Я люблю шахматы.'));
      await f.journaled(f.submit('Я живу в Туле.', 42));
      for (let i = 0; i < 8; i++) await f.journaled(f.submit('Обычная реплика ' + i));
      await until(() => expect(profileCalls(f)).toHaveLength(1));
      f.at(3000);
      let current = f.scope;
      if (fault === 'disable') personalDataStore(f.storage).disable(f.scope, 'vk:42', Date.now());
      if (fault === 'deletion') {
        const privacy = personalDataStore(f.storage);
        const requested = privacy.requestDeletion(f.scope, 'vk:42', '048', Date.now());
        expect(privacy.confirmDeletion(f.scope, 'vk:42', requested.code, Date.now())).toBe(true);
      }
      if (fault === 'expiry') applyHistoryRetention(f.db, 1000, Date.now());
      if (fault === 'generation') {
        const life = lifecycleBackend(f.storage);
        current = life.ownerDecision(life.begin(chat), 'new');
      }
      held.resolve(
        result(
          { ref: 'm1', author: 'u1', field: 'interest', value: 'шахматы' },
          {
            ref: fault === 'bad-ref' ? 'm99' : 'm2',
            author: fault === 'foreign-author' ? 'u1' : 'u2',
            field: 'city',
            value: 'Туле',
          },
        ),
      );
      await until(() => {
        expect(pending(f)).toBe(0);
        expect(
          f.db
            .prepare('SELECT count(*) FROM profile_update_runs WHERE attempt_key IS NOT NULL')
            .pluck()
            .get(),
        ).toBe(0);
      });
      for (const user of ['vk:41', 'vk:42'] as const)
        expect(f.storage.profileFacts.read(current, user).facts).toEqual([]);
      expect(f.sends).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test('пустой ответ провайдера удерживает порцию до повторной попытки через пять минут', async () => {
  const f = await appFixture();
  try {
    tokenBudgetStore(f.storage).update(f.scope, true, { total: 300_000 }, Date.now());
    f.complete
      .mockResolvedValueOnce({ kind: 'empty', usage: { input: 45, output: 365 } })
      .mockResolvedValueOnce(result());
    f.at(1000);
    for (let i = 0; i < 10; i++) await f.journaled(f.submit('Обычная запись ' + i));
    await until(() => {
      expect(profileCalls(f)).toHaveLength(1);
      expect(f.db.prepare('SELECT attempt_key FROM profile_update_runs').pluck().get()).toBeNull();
    });
    expect(pending(f)).toBe(10);
    f.at(300_999);
    await f.journaled(f.submit('/неизвестная-команда'));
    expect(profileCalls(f)).toHaveLength(1);
    f.at(301_000);
    await f.journaled(f.submit('/другая-команда'));
    await until(() => expect(pending(f)).toBe(0));
    expect(profileCalls(f)).toHaveLength(2);
    expect(
      tokenBudgetStore(f.storage).read(f.scope, true, Date.now()).profileUpdate.confirmed,
    ).toBe(530n);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});
