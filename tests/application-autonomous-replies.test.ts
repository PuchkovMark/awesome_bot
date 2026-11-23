import { expect, test } from 'vitest';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, chat, fixture, mention, until } from './helpers/application-response-fixture';

const help = 'Кто-нибудь, помогите разобраться с расписанием';
const free = 'Обсуждали, как работает Пенёк';
const question = 'Во сколько встречаемся у фонтана?';
const fact = 'Встречаемся у фонтана в 18:30.';

test.each([
  [help, 'help'],
  [free, 'free_mention'],
] as const)(
  'приложение проводит инициативу %s через бюджет и публикует один ответ',
  async (text, cause) => {
    const f = await fixture({ active: true });
    try {
      const id = f.submit(text);
      const trace = await f.trace(id);
      expect(trace.payload.route).toEqual({
        kind: 'initiative',
        isGroupChat: true,
        mode: 'active',
        cause,
      });
      expect(trace.payload.publication.status).toBe('delivered');
      expect(f.sends).toHaveLength(1);
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.requests()).toBe(0);
      const spend = tokenBudgetStore(f.storage).read(f.scope, true, f.start);
      expect(spend.total.confirmed).toBe(2n);
      expect(spend.initiative?.confirmed).toBe(2n);
      expect(f.db.prepare('SELECT outcome FROM autonomous_quota_reservations').all()).toEqual([
        { outcome: 'delivered' },
      ]);
    } finally {
      await f.close();
    }
  },
);

test.each([
  'quiet',
  'pause',
  'disabled',
  'initiative_budget',
  'group_budget',
  'rate',
  'flood',
  'other_bot',
] as const)('известный запрет %s останавливает инициативу до модели', async (which) => {
  const f = await fixture({
    active: true,
    limit: which === 'rate' ? 1 : 6,
    threshold: which === 'flood' ? 1 : 5,
  });
  try {
    if (which === 'initiative_budget')
      tokenBudgetStore(f.storage).update(f.scope, true, { initiative: 0 }, f.start);
    if (which === 'group_budget')
      tokenBudgetStore(f.storage).update(f.scope, true, { total: 0 }, f.start);
    if (which === 'rate') f.seedSlots(1);
    if (which === 'quiet')
      await f.storage.authorization.transaction(f.scope, (tx) =>
        tx.writeQuietHours({ start: 900, end: 960 }),
      );
    if (which === 'disabled')
      await f.storage.authorization.transaction(f.scope, (tx) =>
        tx.writePause({
          autonomousDisabled: true,
          pausedUntil: null,
          nextParticipantPause: null,
        }),
      );
    if (which === 'pause') {
      f.submit('помолчи');
      await until(() => expect(f.sends).toHaveLength(1));
    }
    if (which === 'flood') {
      const direct = f.submit(mention);
      await f.published(direct);
    }
    if (which === 'other_bot') await f.journaled(f.submit('Бот рядом', -1000));
    const before = f.sends.length;
    const trace = await f.trace(f.submit(help));
    expect(trace.payload.publication.status).toBe('suppressed');
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.sends).toHaveLength(before);
    expect(f.db.prepare('SELECT * FROM autonomous_quota_reservations').all()).toEqual([]);
    if (which === 'initiative_budget') {
      await f.published(f.submit(mention));
      expect(f.complete).toHaveBeenCalledOnce();
      expect(tokenBudgetStore(f.storage).read(f.scope, true, f.start).initiative?.confirmed).toBe(
        0n,
      );
    }
  } finally {
    await f.close();
  }
});

test.each(['ответ', 'источник', 'режим'] as const)(
  'изменение %s во время генерации сохраняет расход и отменяет публикацию',
  async (which) => {
    const f = await fixture({ active: true });
    const result = Promise.withResolvers<typeof answer>();
    f.complete.mockImplementationOnce(() => result.promise);
    try {
      const source = f.submit(fact);
      await f.journaled(source);
      f.at(1000);
      const id = f.submit(question);
      await f.journaled(id);
      f.at(121000);
      await until(() => expect(f.complete).toHaveBeenCalledOnce());
      const request = f.complete.mock.calls[0]![0];
      expect(JSON.parse(request.messages[0]!.text!).initiativeEvidence.text).toBe(fact);
      if (which === 'ответ') await f.journaled(f.submit('В 18:30.'));
      if (which === 'источник')
        f.db
          .prepare('DELETE FROM messages WHERE chat_id=? AND platform_message_id=?')
          .run(chat, String(source));
      if (which === 'режим') {
        await f.storage.chats.update(f.scope, { responseMode: 'normal' });
        await f.storage.chats.update(f.scope, { responseMode: 'active' });
      }
      result.resolve(answer);
      const trace = await f.trace(id);
      expect(trace.payload.publication).toMatchObject({
        status: 'suppressed',
        reason:
          which === 'ответ'
            ? 'initiative_answered'
            : which === 'источник'
              ? 'initiative_source'
              : 'initiative_mode',
      });
      expect(f.sends).toEqual([]);
      expect(f.complete).toHaveBeenCalledOnce();
      expect(
        tokenBudgetStore(f.storage).read(f.scope, true, Date.now()).initiative?.confirmed,
      ).toBe(2n);
    } finally {
      result.resolve(answer);
      await f.close();
    }
  },
);

test('два повода за одно исходящее место вызывают модель один раз', async () => {
  const f = await fixture({ active: true, limit: 1 });
  try {
    const first = f.submit(help);
    const second = f.submit(free);
    expect((await f.trace(first)).payload.publication.status).toBe('delivered');
    expect((await f.trace(second)).payload.publication.status).toBe('suppressed');
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.sends).toHaveLength(1);
    expect(f.slots()).toBe(1);
  } finally {
    await f.close();
  }
});
