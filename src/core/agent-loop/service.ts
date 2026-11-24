import type { LlmClient, LlmRequest, LlmMessage, LlmToolCall } from '../../llm/types';
import { agentError } from './errors';
import { createAttemptSummary } from './summary';
import { loopOptions, parseAttempt, prepareLoopInput } from './validation';
import type { ParsedAttempt } from './validation';
import type { LlmAdmission, SendLlmCall } from '../llm-admission';
import type {
  AgentLoop,
  LoopTools,
  AgentLoopInput,
  AgentLoopOptions,
  AgentLoopOutcome,
  AgentLoopResult,
  AttemptAdmission,
} from './types';

type Stop = { readonly kind: 'cancelled' | 'deadline_exceeded' };
/** Только внедрённый клиент. Фабрика не создаёт инфраструктурные ресурсы. */
export function createAgentLoop(
  client: LlmClient,
  options: AgentLoopOptions = {},
  onAttempt?: (summary: import('./types').AgentLoopSummary) => void,
  allowAttempt?: (request: Readonly<LlmRequest>, ordinal: number) => AttemptAdmission,
  tools?: LoopTools,
  decorateRequest?: (request: LlmRequest) => LlmRequest,
  scheduling?: {
    readonly admission: LlmAdmission;
    readonly deadline?: number;
    readonly current: () => boolean;
  },
): AgentLoop {
  const config = loopOptions(options);
  let invoke: LlmClient['complete'];
  try {
    const complete = client.complete;
    if (typeof complete !== 'function') throw Error();
    invoke = complete.bind(client);
  } catch {
    throw new TypeError('Некорректный клиент агентного цикла.');
  }
  return Object.freeze({
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      const started = performance.now();
      const summary = createAttemptSummary();
      const finish = (outcome: AgentLoopOutcome): AgentLoopResult =>
        Object.freeze({
          ...outcome,
          summary: summary.snapshot(
            Math.max(0, performance.now() - started),
            tools?.helperSummary?.(),
          ),
        });
      let prepared: AgentLoopInput;
      try {
        prepared = prepareLoopInput(input);
      } catch {
        return finish(agentError('invalid_input'));
      }
      if (prepared.signal?.aborted) return finish({ kind: 'cancelled' });
      const controller = new AbortController();
      const deadline = started + config.timeoutMs;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let pauseTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped: Stop | undefined;
      let resolveStop: (value: ParsedAttempt) => void = () => {};
      const halted = new Promise<ParsedAttempt>((resolve) => {
        resolveStop = resolve;
      });
      const stop = (kind: Stop['kind']) => {
        if (stopped) return;
        stopped = { kind };
        resolveStop({ outcome: stopped, usage: { input: null, output: null } });
        controller.abort();
      };
      const checkStopped = () => {
        if (!stopped && performance.now() >= deadline) stop('deadline_exceeded');
        return stopped;
      };
      const onAbort = () => stop('cancelled');
      const armDeadline = () => {
        if (checkStopped()) return;
        deadlineTimer = setTimeout(armDeadline, Math.ceil(deadline - performance.now()));
      };
      try {
        prepared.signal?.addEventListener('abort', onAbort, { once: true });
        if (prepared.signal?.aborted) onAbort();
        armDeadline();
        let attempts = 0,
          parentStep = 0,
          stepAttempts = 0;
        const transcript: LlmMessage[] = prepared.messages.map((m) => ({ ...m }));
        const executions = new Map<string, { call: LlmToolCall; text: Promise<string> }>();
        const safeCurrent = () => !tools || tools.current();
        for (;;) {
          const offered = tools
            ? await Promise.race([
                tools.schemas({ ...prepared, messages: transcript }),
                halted.then(() => undefined),
              ])
            : undefined;
          if (!safeCurrent()) return finish({ kind: 'cancelled' });
          const base: LlmRequest = {
            system: prepared.system,
            messages: structuredClone(transcript),
            ...(offered?.length ? { tools: structuredClone(offered) } : {}),
            maxOutputTokens: prepared.maxOutputTokens,
            sessionId: prepared.sessionId,
            signal: controller.signal,
          };
          const request = decorateRequest?.(base) ?? base;
          let calls: readonly LlmToolCall[] | undefined;
          const perform = (
            send: SendLlmCall,
          ):
            | AgentLoopOutcome
            | { readonly kind: 'started'; readonly pending: Promise<ParsedAttempt> } => {
            const before = checkStopped();
            if (before) return before;
            const admission = allowAttempt ? allowAttempt(request, attempts + 1) : true;
            if (
              admission === 'quota_exhausted' ||
              admission === 'token_budget_exhausted' ||
              admission === 'initiative_budget_exhausted'
            )
              return { kind: admission };
            if (admission === false || admission === 'context_stale') return { kind: 'cancelled' };
            const reservation = admission === true ? undefined : admission;
            let counted = false;
            let pending: Promise<ParsedAttempt> | undefined;
            try {
              if (!checkStopped()) {
                summary.beginAttempt(parentStep);
                counted = true;
                onAttempt?.(
                  summary.snapshot(
                    Math.max(0, performance.now() - started),
                    tools?.helperSummary?.(),
                  ),
                );
                if (!checkStopped()) {
                  let parsed: ParsedAttempt | undefined;
                  pending = send(async () => {
                    attempts++;
                    stepAttempts++;
                    const value = await invoke(request);
                    if (tools && value?.kind === 'tool_calls') calls = value.calls;
                    parsed = parseAttempt(value);
                    if (parsed.usage.input !== null || parsed.usage.output !== null)
                      reservation?.recordUsage(parsed.usage);
                    return value;
                  }).then(
                    () => parsed ?? parseAttempt(undefined),
                    () => parseAttempt(undefined),
                  );
                }
              }
            } finally {
              if (!pending) {
                if (counted) summary.cancelAttempt(parentStep);
                reservation?.cancelBeforeSend();
              }
            }
            if (!pending) return checkStopped() ?? agentError('client_failure');
            return { kind: 'started', pending };
          };
          const scheduled = scheduling
            ? await scheduling.admission.direct(
                {
                  signal: controller.signal,
                  deadline: Math.min(deadline, scheduling.deadline ?? Infinity),
                  current: () => scheduling.current() && safeCurrent(),
                },
                perform,
              )
            : { kind: 'ready' as const, value: perform((send) => send()) };
          if (scheduled.kind !== 'ready') {
            if (scheduled.kind === 'llm_wait_timeout' || scheduled.kind === 'llm_provider_paused')
              return finish(checkStopped() ?? { kind: scheduled.kind });
            return finish(checkStopped() ?? { kind: 'cancelled' });
          }
          if (scheduled.value.kind !== 'started') return finish(scheduled.value);
          const result = await Promise.race([scheduled.value.pending, halted]);
          const after = checkStopped();
          if (after) return finish(after);
          summary.recordUsage(result.usage);
          const outcome = result.outcome;
          if (tools && !safeCurrent()) return finish({ kind: 'cancelled' });
          if (tools && calls) {
            if (
              !calls.length ||
              calls.length > 64 ||
              new Set(calls.map((c) => c.id)).size !== calls.length ||
              calls.some(
                (c) => !c.id || typeof c.name !== 'string' || typeof c.arguments !== 'string',
              )
            )
              return finish(agentError('invalid_response'));
            if (parentStep + 1 + tools.helperSteps() >= config.maxSteps)
              return finish({ kind: 'step_limit' });
            transcript.push({ role: 'assistant', toolCalls: calls });
            const pendingIds = calls.map((c) => c.id);
            const batchRequest = () => ({
              ...request,
              messages: [...request.messages, ...transcript.slice(request.messages.length)],
            });
            const isLoopCurrent = () => !checkStopped();
            tools.beginBatch(batchRequest(), pendingIds, parentStep + 1, isLoopCurrent);
            const execute = (call: LlmToolCall) => {
              const cached = executions.get(call.id);
              if (cached) {
                if (
                  cached.call.name !== call.name ||
                  cached.call.arguments !== call.arguments ||
                  !offered?.some((t) => t.name === call.name)
                )
                  return Promise.resolve('{"error":"tool_denied"}');
                return cached.text;
              }
              const text = tools.execute(call, offered ?? []);
              executions.set(call.id, { call, text });
              return text;
            };
            for (let i = 0; i < calls.length;) {
              if (checkStopped() || !safeCurrent()) return finish(stopped ?? { kind: 'cancelled' });
              const batch = [calls[i++]!];
              while (batch[0]!.name === 'delegate' && calls[i]?.name === 'delegate')
                batch.push(calls[i++]!);
              const results = await Promise.race([
                Promise.all(batch.map(execute)),
                halted.then(() => undefined),
              ]);
              const helperFailure = tools.modelFailure?.();
              if (helperFailure) return finish({ kind: helperFailure });
              if (tools.budgetExhausted?.()) return finish({ kind: 'token_budget_exhausted' });
              if (!results || !safeCurrent()) return finish(stopped ?? { kind: 'cancelled' });
              for (const [index, call] of batch.entries())
                transcript.push({ role: 'tool', callId: call.id, text: results[index]! });
              tools.beginBatch(batchRequest(), pendingIds.slice(i), parentStep + 1, isLoopCurrent);
            }
            parentStep++;
            stepAttempts = 0;
            continue;
          }
          if (outcome.kind === 'error' && outcome.code === 'server' && config.retryServerErrors) {
            if (stepAttempts >= config.maxAttemptsPerStep)
              return finish({ kind: 'attempt_limit', lastErrorCode: 'server' });
            const pause = new Promise<void>((resolve) => {
              pauseTimer = setTimeout(resolve, config.retryDelayMs);
            });
            try {
              await Promise.race([pause, halted]);
            } finally {
              clearTimeout(pauseTimer);
              pauseTimer = undefined;
            }
            continue;
          }
          return finish(outcome);
        }
      } catch {
        return finish(stopped ?? agentError('client_failure'));
      } finally {
        clearTimeout(deadlineTimer);
        clearTimeout(pauseTimer);
        try {
          prepared.signal?.removeEventListener('abort', onAbort);
        } catch {
          /* Без исходной диагностики. */
        }
      }
    },
  });
}
