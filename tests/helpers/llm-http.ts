import { vi } from 'vitest';
import type { LlmClientOptions, LlmRequest } from '../../src/llm/index';
import { createLlmClient } from '../../src/llm/index';
export const llmConfig = {
  provider: 'opencode',
  apiKey: 'synthetic-key',
  model: 'deepseek-v4.1-flash',
} as const;
export function llmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'Инструкции',
    messages: [{ role: 'user', text: ' Привет\n' }],
    maxOutputTokens: 128,
    sessionId: 'synthetic-session',
    ...overrides,
  };
}
export function completion(
  content: unknown = ' Ответ\n',
  finish = 'stop',
  extra: Record<string, unknown> = {},
) {
  return {
    choices: [{ finish_reason: finish, message: { role: 'assistant', content, ...extra } }],
  };
}
export function fakeClient(value: unknown = completion(), options: LlmClientOptions = {}) {
  const fetch = vi.fn(async () => Response.json(value));
  return { client: createLlmClient(llmConfig, { fetch, ...options }), fetch };
}
export function toolCall(id = 'call-1', name = 'lookup', args = '{не JSON') {
  return { id, type: 'function', function: { name, arguments: args } };
}
