import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import { runBackup } from '../../src/app/database-backup';
import { runApplication } from '../../src/app/service';
import { initializePrompt } from '../../src/app/setup';
import { loadApplicationConfig } from '../../src/config/application';
import { createVkApi, createVkApiCall } from '../../src/channels/vk/api';
import { openStorage } from '../../src/storage/index';
import { openExisting } from '../../src/storage/database-backup';
import { personalDataStore } from '../../src/storage/personal-data-store';
import { scopeFor } from '../helpers/connection-scope';
import { storageFixture } from '../helpers/storage-fixture';

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
