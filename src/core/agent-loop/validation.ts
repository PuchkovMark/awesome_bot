import { agentError, isAgentErrorCode } from './errors';
import { usageCount } from './summary';
import type { AgentLoopInput, AgentLoopMessage, AgentLoopOptions, AgentLoopOutcome } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new TypeError('Некорректный ввод агентного цикла.');
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function onlyKeys(value: object, keys: readonly string[]) {
  requireInput(
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key)),
  );
}
export function loopOptions(options: AgentLoopOptions): Required<AgentLoopOptions> {
  try {
    requireInput(record(options));
    onlyKeys(options, [
      'maxSteps',
      'maxAttemptsPerStep',
      'timeoutMs',
      'retryDelayMs',
      'retryServerErrors',
    ]);
    const {
      maxSteps = 6,
      maxAttemptsPerStep = 2,
      timeoutMs = 120_000,
      retryDelayMs = 1_000,
      retryServerErrors = true,
    } = options;
    const config = { maxSteps, maxAttemptsPerStep, timeoutMs, retryDelayMs, retryServerErrors };
    requireInput(positive(config.maxSteps) && positive(config.maxAttemptsPerStep));
    requireInput(positive(config.timeoutMs) && config.timeoutMs <= 2_147_483_647);
    requireInput(positive(config.retryDelayMs) && config.retryDelayMs <= 2_147_483_647);
    requireInput(typeof config.retryServerErrors === 'boolean');
    return Object.freeze({
      maxSteps: config.maxSteps,
      maxAttemptsPerStep: config.maxAttemptsPerStep,
      timeoutMs: config.timeoutMs,
      retryDelayMs: config.retryDelayMs,
      retryServerErrors: config.retryServerErrors,
    });
  } catch {
    throw new TypeError('Некорректная конфигурация агентного цикла.');
  }
}
export function prepareLoopInput(input: AgentLoopInput): AgentLoopInput {
  requireInput(record(input));
  onlyKeys(input, ['system', 'messages', 'maxOutputTokens', 'sessionId', 'signal']);
  const { system, messages, maxOutputTokens, sessionId, signal } = input;
  requireInput(typeof system === 'string' && Array.isArray(messages) && messages.length > 0);
  requireInput(
    positive(maxOutputTokens) &&
      typeof sessionId === 'string' &&
      /^[A-Za-z0-9._-]{1,256}$/.test(sessionId),
  );
  requireInput(
    signal === undefined || (signal instanceof AbortSignal && typeof signal.aborted === 'boolean'),
  );
  const snapshot: AgentLoopMessage[] = Array.from(messages, (message: unknown) => {
    requireInput(record(message));
    onlyKeys(message, ['role', 'text']);
    const { role, text } = message;
    requireInput((role === 'user' || role === 'assistant') && typeof text === 'string');
    return Object.freeze({ role, text });
  });
  return Object.freeze({
    system,
    messages: Object.freeze(snapshot),
    maxOutputTokens,
    sessionId,
    ...(signal ? { signal } : {}),
  });
}
export interface ParsedAttempt {
  readonly outcome: AgentLoopOutcome;
  readonly usage: { readonly input: number | null; readonly output: number | null };
}
/** Проецирует только известные поля; не читает message/stack/cause или аргументы. */
export function parseAttempt(value: unknown): ParsedAttempt {
  const unknownUsage = { input: null, output: null };
  try {
    if (!record(value)) throw Error();
    const kind = value.kind;
    if (kind === 'error') {
      const code = value.code;
      if (code === 'rate_limit' || code === 'cancelled')
        return { outcome: { kind: code }, usage: unknownUsage };
      if (!isAgentErrorCode(code) || code === 'invalid_input' || code === 'client_failure')
        throw Error();
      return { outcome: agentError(code), usage: unknownUsage };
    }
    let outcome: AgentLoopOutcome;
    if (kind === 'complete' || kind === 'incomplete') {
      const text = value.text;
      if (typeof text !== 'string' || text.trim().length === 0) throw Error();
      outcome = kind === 'complete' ? { kind, text } : { kind, partialText: text };
    } else if (kind === 'refused' || kind === 'empty') outcome = { kind };
    else if (kind === 'tool_calls') outcome = { kind: 'tools_not_supported' };
    else throw Error();
    const usage = value.usage;
    return {
      outcome,
      usage: record(usage)
        ? { input: usageCount(usage.input), output: usageCount(usage.output) }
        : unknownUsage,
    };
  } catch {
    return { outcome: agentError('client_failure'), usage: unknownUsage };
  }
}
