import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import { runBackup } from '../../src/app/database-backup';
import { runApplication } from '../../src/app/service';
import { initializePrompt, resolveApplicationChat } from '../../src/app/setup';
import { loadApplicationConfig } from '../../src/config/application';
import { createVkApi, createVkApiCall } from '../../src/channels/vk/api';
import { openStorage } from '../../src/storage/index';
import { openExisting } from '../../src/storage/database-backup';
import { personalDataStore } from '../../src/storage/personal-data-store';
import { scopeFor } from '../helpers/connection-scope';
import { storageFixture } from '../helpers/storage-fixture';
import type { LlmResult } from '../../src/llm/types';
import { answer, fixture, ownerId, peer, until } from '../helpers/application-response-fixture';

async function startTestBot(config: ReturnType<typeof loadApplicationConfig>['config']) {
  const controller = new AbortController(),
    ready = Promise.withResolvers<void>();
  const running = runApplication(
    config,
    {
      event(e) {
        if (e.event === 'application_ready') ready.resolve();
      },
      componentError() {},
      debugError() {},
      debugText() {},
    },
    controller.signal,
    {
      vk: {
        api: createVkApi(
          314,
          createVkApiCall(async () => ({ error: { error_code: 7 } })),
        ),
        transport: {
          async run(listener, signal) {
            await listener.onGap('startup');
            listener.onReady?.();
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              );
          },
        },
      },
      client: {
        async complete() {
          throw Error('unexpected_test_model_call');
        },
      },
    },
  );
  await Promise.race([
    ready.promise,
    running.then((reason) => {
      throw Error(reason ?? 'stopped_before_ready');
    }),
  ]);
  return async () => {
    controller.abort();
    expect(await running).toBeNull();
  };
}

test('восстановление двух бесед до application_ready с замером простоя', async () => {
  const files = storageFixture(),
    count = 300_000;
  const config = loadApplicationConfig({
    env: {
      DATABASE_PATH: files.path,
      MESSAGE_RETENTION_DAYS: '30',
      VK_TOKEN: 'test-vk',
      VK_GROUP_ID: '314',
      BOT_OWNER_ID: 'vk:73',
      LLM_MODEL: 'test',
      MODEL_CONTEXT_TOKENS: '16000',
      LLM_SESSION_SECRET: 'test-session',
      OPENCODE_API_KEY: 'test-provider',
    },
    readFile: () => '',
  }).config;
  const options = { databasePath: files.path, messageRetentionDays: 30 };
  const prompt = join(files.directory, 'prompt.txt');
  writeFileSync(prompt, 'Тестовый системный промпт.');
  let stop: (() => Promise<void>) | undefined;
  try {
    expect(await initializePrompt(config, prompt)).toBeFalsy();
    stop = await startTestBot(config);
    const app = await openStorage(files.path);
    try {
      const a = scopeFor(app, 'vk:2000000001'),
        b = scopeFor(app, 'vk:2000000002'),
        now = Date.now();
      for (const scope of [a, b])
        await app.chats.create(scope, { createdAt: now, enabled: true, responseMode: 'normal' });
      await app.messages.append(a, {
        chatId: a.chatId,
        messageId: 'clear',
        userId: 'vk:11',
        role: 'user',
        authorName: '',
        text: 'очистить',
        timestamp: now,
      });
      await app.messages.append(b, {
        chatId: b.chatId,
        messageId: 'forget',
        userId: 'vk:22',
        role: 'user',
        authorName: '',
        text: 'удалить',
        timestamp: now,
      });
      const seed = openExisting(files.path, false);
      try {
        seed.transaction(() => {
          seed
            .prepare(
              `WITH RECURSIVE series(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM series WHERE x<?)
            INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
            SELECT ?,CAST(x AS TEXT),'vk:33','','user','контрольный факт',? FROM series`,
            )
            .run(count - 2, b.chatId, now);
          seed
            .prepare(
              `INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,outcome)
            SELECT m.chat_id,c.generation,m.id,?,?,'terminal','completed' FROM messages m JOIN chat_connections c USING(chat_id)`,
            )
            .run(now, now + 86400000);
        })();
      } finally {
        seed.close();
      }
      expect(await runBackup(options, 'create')).toMatchObject({ ok: true, outcome: 'created' });
      const privacy = personalDataStore(app);
      const request = privacy.requestDeletion(b, 'vk:22', 'test-delete', now + 1);
      expect(privacy.confirmDeletion(b, 'vk:22', request.code, now + 2)).toBe(true);
      const changes = openExisting(files.path, false);
      try {
        changes
          .prepare(
            'INSERT OR REPLACE INTO history_retention_boundaries VALUES(?,?,(SELECT max(id) FROM messages WHERE chat_id=?),-1)',
          )
          .run(a.chatId, a.generation, a.chatId);
      } finally {
        changes.close();
      }
    } finally {
      await app.close();
    }
    const bytes = statSync(files.path).size,
      totalStart = performance.now();
    expect(await runBackup(options, 'verify')).toMatchObject({
      ok: true,
      verification: { access: { admitted: 2 } },
    });
    const downtimeStart = performance.now();
    await stop();
    stop = undefined;
    expect(await runBackup(options, 'restore')).toMatchObject({ ok: true, outcome: 'restored' });
    stop = await startTestBot(config);
    const finished = performance.now();
    const result = openExisting(files.path);
    try {
      expect(
        result
          .prepare(
            "SELECT count(*) FROM personal_visible_messages WHERE platform_message_id IN ('clear','forget')",
          )
          .pluck()
          .get(),
      ).toBe(0);
      expect(
        result
          .prepare("SELECT count(*) FROM personal_visible_messages WHERE user_id='vk:33'")
          .pluck()
          .get(),
      ).toBe(count - 2);
    } finally {
      result.close();
    }
    console.log(
      JSON.stringify({
        messages: count,
        jobs: count,
        bytes,
        rehearsalMs: Math.round(downtimeStart - totalStart),
        downtimeMs: Math.round(finished - downtimeStart),
        totalMs: Math.round(finished - totalStart),
      }),
    );
  } finally {
    try {
      await stop?.();
    } finally {
      files.cleanup();
    }
  }
}, 300000);

test('восстановление двух бесед сверяет доставленный ответ и прерванную оценку', async () => {
  const files = storageFixture();
  const options = { databasePath: files.path, messageRetentionDays: 30, ownerId } as const;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const first = Promise.withResolvers<LlmResult>(),
    second = Promise.withResolvers<LlmResult>();
  const question = 'Пенёк, подскажи';
  const approval = { ...answer, text: 'ответить' };
  const rows = (app: NonNullable<typeof f>) =>
    app.db
      .prepare(
        `SELECT a.chat_id AS chat,a.state,a.outcome
    FROM group_reply_assessments a ORDER BY a.message_id`,
      )
      .all();
  try {
    const app = (f = await fixture({ files }));
    const neighbor = await app.connectGroup(peer + 1);
    app.assess
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const left = app.submit(question);
    await until(() => expect(app.assess).toHaveBeenCalledOnce());
    const right = app.submit(question, 41, undefined, peer + 1);
    await until(() =>
      expect(rows(app)).toMatchObject([
        { chat: app.scope.chatId, state: 'sent' },
        { chat: neighbor.chatId, state: 'waiting' },
      ]),
    );
    expect(await runBackup(options, 'create')).toMatchObject({ ok: true, outcome: 'created' });

    first.resolve(approval);
    await app.published(left);
    await until(() => expect(app.assess).toHaveBeenCalledTimes(2));
    expect(app.sends.some((row) => row.reply_message?.conversation_message_id === right)).toBe(
      false,
    );
    await app.close();
    f = undefined;
    expect(await runBackup(options, 'restore')).toMatchObject({ ok: true, outcome: 'restored' });

    const restored = (f = await fixture({ files, resume: true }));
    await resolveApplicationChat(options, `vk:${peer + 1}`, 'continue');
    expect(rows(restored)).toMatchObject([
      { chat: app.scope.chatId, state: 'finished', outcome: 'answer' },
      { chat: neighbor.chatId, state: 'finished', outcome: 'uncertain' },
    ]);
    restored.submit(question, 41, undefined, peer, false, left);
    restored.submit(question, 41, undefined, peer + 1, false, right);
    await restored.published(
      restored.submit('[club314|Пенёк] Контроль после восстановления', 41, undefined, peer + 1),
    );
    expect(restored.assess).not.toHaveBeenCalled();
    expect(restored.complete).toHaveBeenCalledOnce();
    expect(rows(restored)).toHaveLength(2);
    expect(
      restored.db
        .prepare(
          `SELECT chat_id AS chat,input_tokens AS tokens FROM token_budget_attempts
        WHERE purpose='gate_name' ORDER BY chat_id`,
        )
        .all(),
    ).toEqual([
      { chat: app.scope.chatId, tokens: 1 },
      { chat: neighbor.chatId, tokens: null },
    ]);
  } finally {
    first.resolve(approval);
    second.resolve(approval);
    await f?.close();
    files.cleanup();
  }
});
