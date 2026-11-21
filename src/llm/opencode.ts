import { llmFailure } from './errors.js';
import { isRecord, nonblank, transportCalls } from './validation.js';
import type { LlmResult, LlmUsage } from './types.js';

export const opencodeGoEndpoint = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
export const llmUserAgent = 'awesome_bot/0.0.0';
function usageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function normalizeResponse(value: unknown): LlmResult {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) return llmFailure('invalid_response');
  const choice: unknown = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || choice.message.role !== 'assistant') return llmFailure('invalid_response');
  const message = choice.message;
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') return llmFailure('invalid_response');
  if (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') return llmFailure('invalid_response');
  const reported = isRecord(value.usage) ? value.usage : {};
  const usage: LlmUsage = Object.freeze({ input: usageCount(reported.prompt_tokens), output: usageCount(reported.completion_tokens) });
  const finish = choice.finish_reason;
  if (!['stop', 'length', 'content_filter', 'tool_calls'].includes(finish as string)) return llmFailure('unsupported_response');
  const hasCalls = message.tool_calls !== undefined && message.tool_calls !== null;
  if (hasCalls) {
    if (finish === 'length') return llmFailure('unsupported_response');
    if (finish !== 'tool_calls' || nonblank(message.refusal)) return llmFailure('invalid_response');
    if (!Array.isArray(message.tool_calls)) return llmFailure('invalid_response');
    try {
      const data = message.tool_calls.map((call: unknown) => {
        if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)) throw Error();
        return { id: call.id, name: call.function.name, arguments: call.function.arguments };
      });
      const calls = Object.freeze(transportCalls(data).map((call) => Object.freeze(call)));
      return Object.freeze({ kind: 'tool_calls', calls, text: typeof message.content === 'string' ? message.content : null, usage });
    } catch { return llmFailure('invalid_response'); }
  }
  if (finish === 'tool_calls') return llmFailure('invalid_response');
  if (finish === 'content_filter' || nonblank(message.refusal)) return Object.freeze({ kind: 'refused', usage });
  if (!nonblank(message.content)) return Object.freeze({ kind: 'empty', usage });
  return Object.freeze({ kind: finish === 'length' ? 'incomplete' : 'complete', text: message.content, usage });
}
