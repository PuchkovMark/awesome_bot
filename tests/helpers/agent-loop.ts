import { vi } from 'vitest';
import { createAgentLoop } from '../../src/core/index';
import type { AgentLoopInput, AgentLoopOptions } from '../../src/core/index';
import type { LlmRequest, LlmResult } from '../../src/llm/types';
export function agentInput(patch: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    system: 'Системные инструкции',
    messages: [{ role: 'user', text: 'Привет\n' }],
    maxOutputTokens: 128,
    sessionId: 'synthetic',
    ...patch,
  };
}
export function response(kind = 'complete', extra: Record<string, unknown> = {}): unknown {
  return { kind, text: ' Ответ\n', usage: { input: 10, output: 2 }, ...extra };
}
export function failure(code = 'server') {
  return { kind: 'error', code, message: 'UNTRUSTED' };
}
export function sequence(results: readonly unknown[], options: AgentLoopOptions = {}) {
  let index = 0;
  const complete = vi.fn(async (request: LlmRequest): Promise<LlmResult> => {
    void request;
    if (index >= results.length) throw Error('Unexpected extra attempt');
    return results[index++] as LlmResult;
  });
  return { loop: createAgentLoop({ complete }, options), complete };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
