import { expect, test, vi } from 'vitest';
import { contextFixture } from './helpers/context';
import { createAgentLoopQueue } from '../src/core/chat-queue/agent-loop-adapter';
import { createPublicationService } from '../src/core/message-router/publication-service';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import type { PreparationFailure } from '../src/core/context/types';
for (const mode of ['normal', 'active'] as const)
  for (const reason of [
    'current_message_too_large',
    'static_budget_too_small',
    'missing_system_prompt',
  ] as const)
    test(`уведомление ${mode}/${reason} с точным журналированием и общим периодом`, async () => {
      const f = await contextFixture();
      await f.storage.chats.update(f.scope, { responseMode: mode });
      const complete = vi.fn();
      let failure: PreparationFailure = reason;
      const publish = vi.fn(async () => ({
        kind: 'delivered' as const,
        receipt: { messageId: 'notice', userId: 'vk:bot' as const, authorName: '', timestamp: 200 },
      }));
      const service = createPublicationService({
        storage: f.storage,
        port: {
          async canReply() {
            return true;
          },
          publish,
        },
      });
      const q = createAgentLoopQueue({
        modelName: 'synthetic-model',
        tracing: { messageRetentionDays: 30 },
        storage: f.storage,
        client: { complete },
        prepare: async () => ({ kind: 'failed', reason: failure }),
        onSettled: service.onSettled,
      });
      try {
        await q.start();
        const route = { kind: 'mention', mode, isGroupChat: true } as const;
        await q.admitRouted(f.scope, queueMessage(f.scope.chatId, 'a'), () => ({
          route,
          reason: 'mention',
        }));
        await flushQueue();
        await flushQueue();
        expect(complete).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledTimes(mode === 'active' ? 0 : 1);
        if (mode === 'normal') {
          const sent = publish.mock.calls[0]!;
          const text = (sent as unknown as [{ text: string }])[0].text;
          expect(text).toBe(
            reason === 'current_message_too_large'
              ? 'Сообщение слишком большое для ответа. Попробуйте сократить его.'
              : 'Сейчас не получилось ответить. Попробуйте позже.',
          );
          const all = await f.storage.messages.list(f.scope, { limit: 10 });
          const notice = all.find((m) => m.purpose === 'service_notice');
          expect(notice?.text).toBe(text);
          expect(await f.storage.contextMessages.get(f.scope, notice!.id)).toBeNull();
          failure =
            reason === 'current_message_too_large'
              ? 'static_budget_too_small'
              : 'current_message_too_large';
          await q.admitRouted(f.scope, queueMessage(f.scope.chatId, 'b'), () => ({
            route,
            reason: 'mention',
          }));
          await flushQueue();
          expect(publish).toHaveBeenCalledTimes(1);
        }
      } finally {
        await q.stop();
        await f.storage.close();
      }
    });
