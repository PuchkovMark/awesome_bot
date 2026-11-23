import { expect, test, vi } from 'vitest';
import type { PassportSection } from '../src/contracts/chat-passport';
import type { ConnectionScope } from '../src/contracts/index';
import type { LlmRequest } from '../src/llm/types';
import { createAgentLoopQueue } from '../src/core/chat-queue/agent-loop-adapter';
import { estimateRequestInput } from '../src/core/context/budget';
import type { PassportContextReader } from '../src/core/context/passport';
import { createContextBuilder } from '../src/core/context/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { answer, fixture, until } from './helpers/application-response-fixture';
import { queueMessage } from './helpers/chat-queue';
import { contextFixture } from './helpers/context';

const mention = '[club314|Пенёк]';
const question = mention + ' А можно сюда кинуть рекламу?';
const rules = 'Рекламу согласуют после смены дежурного.';
type App = Awaited<ReturnType<typeof fixture>>;

function edit(
  app: App,
  section: PassportSection,
  value: string | null,
  scope: ConnectionScope = app.scope,
) {
  app.db
    .prepare(
      `INSERT INTO chat_passport_sections(chat_id,generation,section,text,revision)
    VALUES(?,?,?,?,1) ON CONFLICT(chat_id,generation,section) DO UPDATE
    SET revision=revision+1,text=excluded.text`,
    )
    .run(scope.chatId, scope.generation, section, value);
}

function readPassport(request: LlmRequest) {
  const current = request.messages.findLast(({ role }) => role === 'user');
  return (
    JSON.parse(current?.text ?? '{}') as {
      chatPassport?: Partial<Record<PassportSection, string>>;
    }
  ).chatPassport;
}

test('перед первым вызовом очередь пересобирает изменившийся снимок без лишней попытки', async () => {
  const f = await contextFixture();
  let revision = 1;
  const current = vi.fn<PassportContextReader['current']>((_, refs) =>
    refs.every((ref) => ref.revision === revision),
  );
  const read = vi.fn(() => [{ section: 'rules' as const, revision, text: 'Редакция ' + revision }]);
  const builder = createContextBuilder({ ...f.options, passport: { read, current } });
  const settled = Promise.withResolvers<void>();
  const complete = vi.fn<(request: LlmRequest) => Promise<typeof answer>>(async () => answer);
  const q = createAgentLoopQueue({
    modelName: 'synthetic',
    client: { complete },
    storage: f.storage,
    tracing: { messageRetentionDays: 30 },
    prepare: builder.prepare,
    async tools() {
      revision = 2;
      return undefined;
    },
    async onSettled() {
      settled.resolve();
    },
  });
  try {
    await q.start();
    await q.admitRouted(
      f.scope,
      { ...queueMessage(f.scope.chatId, '1'), text: 'Что говорят правила?' },
      () => ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } }),
    );
    await settled.promise;
    expect(read).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(readPassport(complete.mock.calls[0]![0])).toEqual({ rules: 'Редакция 2' });
    const trace = await f.storage.traces.get(f.scope, 1);
    expect(trace?.payload.summary?.attempts).toBe(1);
    expect(trace?.payload.context?.passport?.sections).toEqual(['rules']);
  } finally {
    await q.stop();
    await f.storage.close();
  }
});

test.each(['редакция при вызове', 'очистка перед отправкой', 'сброс поколения'] as const)(
  'использованный раздел закрывает отправку при изменении «%s»',
  async (stage) => {
    const delayed = stage === 'редакция при вызове';
    const app = await fixture({ hold: !delayed });
    const response = Promise.withResolvers<void>();
    try {
      edit(app, 'rules', rules);
      if (delayed)
        app.complete.mockImplementationOnce(async () => {
          await response.promise;
          return answer;
        });
      const id = app.submit(question);
      await until(() => expect(app.complete).toHaveBeenCalledOnce());
      expect(readPassport(app.complete.mock.calls[0]![0])).toEqual({ rules });
      if (!delayed) await until(() => expect(app.holds).toHaveLength(1));

      if (stage === 'сброс поколения') {
        const lifecycle = lifecycleBackend(app.storage);
        const next = lifecycle.ownerDecision(lifecycle.begin(app.scope.chatId), 'new');
        expect(next.generation).not.toBe(app.scope.generation);
      } else edit(app, 'rules', delayed ? 'Согласование отменено.' : null);

      response.resolve();
      const held = app.holds[0];
      held?.release();
      await held?.finished;
      if (stage !== 'сброс поколения') {
        expect((await app.trace(id)).payload.publication).toMatchObject({ status: 'suppressed' });
      }
      expect(app.sends.filter(({ text }) => text === answer.text)).toEqual([]);
    } finally {
      response.resolve();
      await app.close();
    }
  },
);

test('изменение раздела, не вместившегося в запрос, сохраняет доставку и безопасную трассировку', async () => {
  const app = await fixture({ hold: true });
  try {
    edit(app, 'rules', 'Д'.repeat(1100));
    const glossary = 'Маяк — точка сбора на закате.';
    edit(app, 'glossary', glossary);
    const id = app.submit(mention + ' Что значит «маяк» и можно ли добавить рекламу?');
    await until(() => expect(app.holds).toHaveLength(1));
    expect(readPassport(app.complete.mock.calls[0]![0])).toEqual({ glossary });
    edit(app, 'rules', 'Заполнено после вызова.');
    app.holds[0]!.release();
    await app.published(id);
    const trace = await app.trace(id);
    expect(trace.payload.context?.passport).toEqual({
      sections: ['glossary'],
      estimatedTokens: Buffer.byteLength(',"chatPassport":' + JSON.stringify({ glossary })),
    });
    expect(trace.payload.context?.absentLayers).not.toContain('passport');
    expect(JSON.stringify(trace.payload)).not.toContain(glossary);
  } finally {
    await app.close();
  }
});

test('после отправки первой части редакция блокирует следующую часть', async () => {
  const app = await fixture({ hold: true });
  try {
    edit(app, 'rules', rules);
    app.complete.mockResolvedValueOnce({
      ...answer,
      text: 'Длинный ответ о правиле. '.repeat(210),
    });
    const id = app.submit(question);
    await until(() => expect(app.holds).toHaveLength(1));
    app.holds[0]!.release();
    await until(() => expect(app.holds).toHaveLength(2));
    edit(app, 'rules', 'Другая редакция.');
    app.holds[1]!.release();
    expect((await app.trace(id)).payload.publication).toMatchObject({ reason: 'partial_delivery' });
    expect(app.sends).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('результат инструмента вытесняет паспорт, а его прежняя ревизия всё ещё защищает публикацию', async () => {
  const modelContextTokens = 13_100;
  const app = await fixture({ modelContextTokens, hold: true });
  try {
    const full = 'Правила рекламы. '.repeat(20);
    edit(app, 'rules', full);
    for (let i = 0; i < 12; i++)
      await app.storage.messages.append(app.scope, {
        chatId: app.scope.chatId,
        messageId: String(1000 + i),
        userId: 'vk:73',
        role: 'user',
        authorName: 'Саша',
        isGroupChat: true,
        text: 'Записьмаяк ' + 'Данные '.repeat(58),
        timestamp: app.start - 1000,
      });
    app.complete.mockResolvedValueOnce({
      kind: 'tool_calls',
      calls: [{ id: 'history', name: 'history_search', arguments: '{"query":"Записьмаяк"}' }],
      text: null,
      usage: { input: 2, output: 1 },
    });
    const id = app.submit(question);
    await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
    const [initial, continuing] = app.complete.mock.calls.map(([request]) => request);
    expect(readPassport(initial!), String(estimateRequestInput(initial!))).toEqual({ rules: full });
    expect(readPassport(continuing!)).toBeUndefined();
    const tool = continuing!.messages.find(({ role }) => role === 'tool')!;
    expect(JSON.parse(tool.text!).shown).toBeGreaterThan(0);
    expect(estimateRequestInput(continuing!) + continuing!.maxOutputTokens).toBeLessThanOrEqual(
      modelContextTokens,
    );
    await until(() => expect(app.holds).toHaveLength(1));
    edit(app, 'rules', null);
    app.holds[0]!.release();
    const trace = await app.trace(id);
    expect(trace.payload.context?.passport?.sections).toEqual(['rules']);
    expect(trace.payload.publication).toMatchObject({ status: 'suppressed', reason: 'guard' });
    expect(app.sends).toEqual([]);
  } finally {
    await app.close();
  }
});
