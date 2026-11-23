import type { JsonValue } from '../contracts/json';
import type { LlmRequest, LlmToolCall } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new TypeError('Некорректный запрос к модели.');
}
/** Не вызывает toJSON и не превращает undefined/NaN/циклы в другой JSON. */
function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  requireInput(typeof value === 'object' && value !== null && !ancestors.has(value));
  requireInput(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  requireInput(Object.getOwnPropertySymbols(value).length === 0);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (entry) => copyJson(entry, ancestors));
    const copy: Record<string, JsonValue> = Object.create(null);
    for (const key of Object.keys(value)) copy[key] = copyJson((value as Record<string, unknown>)[key], ancestors);
    return copy;
  } finally { ancestors.delete(value); }
}
export function transportCalls(value: unknown): LlmToolCall[] {
  requireInput(Array.isArray(value) && value.length > 0);
  const ids = new Set<string>();
  return Array.from(value, (entry: unknown) => {
    requireInput(isRecord(entry) && nonblank(entry.id) && nonblank(entry.name) && typeof entry.arguments === 'string');
    requireInput(!ids.has(entry.id)); ids.add(entry.id);
    return { id: entry.id, name: entry.name, arguments: entry.arguments };
  });
}
export function wireCalls(calls: readonly LlmToolCall[]) {
  return calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
}
export interface PreparedRequest { readonly body: string; readonly sessionId: string; readonly signal: AbortSignal | undefined }
export function prepareRequest(request: LlmRequest, model: string): PreparedRequest {
  requireInput(isRecord(request));
  const { system, messages: inputMessages, maxOutputTokens, sessionId, signal, tools: inputTools } = request;
  requireInput(typeof system === 'string');
  requireInput(Array.isArray(inputMessages) && inputMessages.length > 0 && positiveInteger(maxOutputTokens));
  requireInput(typeof sessionId === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(sessionId));
  requireInput(signal === undefined || (signal instanceof AbortSignal && typeof signal.aborted === 'boolean'));
  const messages: unknown[] = [{ role: 'system', content: system }];
  for (const message of inputMessages as readonly unknown[]) {
    requireInput(isRecord(message));
    if (message.role === 'user') {
      requireInput(typeof message.text === 'string');
      messages.push({ role: 'user', content: message.text });
    } else if (message.role === 'tool') {
      requireInput(nonblank(message.callId) && typeof message.text === 'string');
      messages.push({ role: 'tool', tool_call_id: message.callId, content: message.text });
    } else {
      requireInput(message.role === 'assistant' && (message.text === undefined || typeof message.text === 'string'));
      const calls = message.toolCalls === undefined ? undefined : transportCalls(message.toolCalls);
      requireInput(typeof message.text === 'string' || calls !== undefined);
      messages.push({ role: 'assistant', content: message.text ?? null, ...(calls ? { tool_calls: wireCalls(calls) } : {}) });
    }
  }
  requireInput(inputTools === undefined || Array.isArray(inputTools));
  const names = new Set<string>();
  const tools = inputTools === undefined ? undefined : Array.from(inputTools, (tool: unknown) => {
    requireInput(isRecord(tool) && nonblank(tool.name) && typeof tool.description === 'string');
    requireInput(!names.has(tool.name)); names.add(tool.name);
    requireInput(isRecord(tool.parameters) && tool.parameters.type === 'object');
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: copyJson(tool.parameters) } };
  });
  return {
    body: JSON.stringify({ model, messages, max_tokens: maxOutputTokens, ...(tools?.length ? { tools } : {}) }),
    sessionId, signal,
  };
}
