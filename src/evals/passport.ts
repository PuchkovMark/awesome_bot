import type { PassportSection } from '../contracts/chat-passport';
import type { ConnectionScope } from '../contracts/index';
import type { LlmClient } from '../llm/types';
import type { chatPassportStore } from '../storage/chat-passport-store';

export function seedPassport(
  store: ReturnType<typeof chatPassportStore>,
  scope: ConnectionScope,
  sections: Partial<Record<PassportSection, string>>,
) {
  const owner = 'synthetic:owner' as const;
  const bot = 'synthetic:bot' as const;
  for (const [index, entry] of store.read(scope).entries()) {
    const text = sections[entry.section];
    if (text === undefined) continue;
    const messageId = String(index + 10);
    if (
      !store.recordPrompt(
        scope,
        owner,
        entry,
        'edit',
        {
          messageId,
          userId: bot,
          authorName: 'Бот',
          timestamp: 1,
          text: 'Служебное сообщение.',
        },
        1,
      )
    )
      return false;
    if (
      store.apply(scope, owner, { receipt: messageId, text, eventId: index + 20 }, 2) !== 'applied'
    )
      return false;
  }
  return true;
}

export function deniedGrantClient(answer: string): LlmClient {
  return {
    async complete(request) {
      const usage = { input: null, output: null };
      return request.messages.some((m) => m.role === 'tool')
        ? { kind: 'complete', text: answer, usage }
        : {
            kind: 'tool_calls',
            text: null,
            usage,
            calls: [{ id: 'denied-test', name: 'grant_admin', arguments: '{}' }],
          };
    },
  };
}
