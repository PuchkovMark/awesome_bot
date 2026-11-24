import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { openStorage } from '../src/storage/index';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { createAgentLoopQueue } from '../src/core/chat-queue/agent-loop-adapter';
import { createPublicationService } from '../src/core/message-router/publication-service';
for (const mode of ['normal', 'active'] as const)
  for (const failure of ['none', 'full', 'both', 'receipt'] as const)
    test(`публикация ${mode}/${failure}: запись до порта, без повторов модели`, async () => {
      const f = storageFixture(),
        s = await openStorage(f.path),
        db = new Database(f.path),
        scope = scopeFor(s, 'vk:a');
      let calls = 0;
      const sent: { kind: string; text: string }[] = [];
      await s.chats.create(scope, { enabled: true, responseMode: mode, createdAt: 0 });
      if (failure !== 'none')
        db.exec(
          `CREATE TRIGGER fail_publication BEFORE UPDATE ON response_traces WHEN ${failure === 'receipt' ? "json_extract(NEW.payload,'$.publication.status')='delivered'" : failure === 'both' ? "json_extract(NEW.payload,'$.publication.status')='allowed'" : "json_extract(NEW.payload,'$.publication.status')='allowed' AND json_extract(NEW.payload,'$.degraded')=0"} BEGIN SELECT RAISE(ABORT,'SECRET_ERROR'); END;`,
        );
      const pub = createPublicationService({
        storage: s,
        port: {
          canReply: async () => true,
          publish: async (p) => {
            sent.push({ kind: p.kind, text: p.text });
            const t = await s.traces.get(scope, 1);
            if (failure !== 'both') {
              expect(t?.payload.publication.status).toBe('allowed');
              expect(t?.payload.publication.rowId).toBe('complete');
              expect(t?.payload.degraded).toBe(failure === 'full');
            }
            return {
              kind: 'delivered',
              receipt: { messageId: 'answer', userId: 'vk:bot', authorName: '', timestamp: 1 },
            };
          },
        },
      });
      const q = createAgentLoopQueue({
        modelName: 'test-model',
        tracing: { messageRetentionDays: 30 },
        storage: s,
        onSettled: pub.onSettled,
        prepare: async () => ({
          kind: 'ready',
          input: {
            system: 'SECRET_PROMPT',
            messages: [{ role: 'user', text: 'SECRET_TEXT' }],
            maxOutputTokens: 1,
            sessionId: 'SECRET_SESSION',
          },
        }),
        client: {
          complete: async () => {
            calls++;
            return { kind: 'complete', text: 'SECRET_ANSWER', usage: { input: 1, output: 2 } };
          },
        },
      });
      try {
        await q.start();
        await q.admitRouted(scope, queueMessage(scope.chatId, 'm'), () => ({
          reason: 'name',
          route: { kind: 'name', mode, isGroupChat: true },
        }));
        for (let i = 0; i < 5; i++) await flushQueue();
        expect(calls).toBe(1);
        if (failure === 'both') {
          expect(pub.stats().trace_write_failed).toBe(1);
          expect(sent).toHaveLength(mode === 'active' ? 0 : 1);
          if (mode === 'normal') {
            expect(sent[0]?.kind).toBe('notice');
            expect(sent[0]?.text).not.toContain('SECRET');
            expect(await s.contextMessages.list(scope, { limit: 10 })).toHaveLength(1);
          }
        } else {
          expect(sent).toHaveLength(1);
          expect(sent[0]?.kind).toBe('answer');
          expect((await s.traces.get(scope, 1))?.payload.publication.status).toBe(
            failure === 'receipt' ? 'allowed' : 'delivered',
          );
        }
        expect(JSON.stringify(await s.traces.get(scope, 1))).not.toContain('SECRET');
      } finally {
        await q.stop();
        db.close();
        await s.close();
        f.cleanup();
      }
    });

test('разные строки таблицы имеют разные устойчивые идентификаторы', async () => {
  const { publicationRow } = await import('../src/core/message-router/publication');
  const route = { kind: 'name', mode: 'normal', isGroupChat: true } as const;
  expect(publicationRow(route, { kind: 'empty' })).toBe('unusable_response');
  expect(publicationRow(route, { kind: 'rate_limit' })).toBe('unsuccessful');
  expect(publicationRow(route, { kind: 'llm_wait_timeout' })).toBe('llm_wait_timeout');
  expect(publicationRow(route, { kind: 'llm_provider_paused' })).toBe('llm_provider_paused');
});
