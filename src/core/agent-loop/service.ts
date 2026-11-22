import type { LlmClient, LlmRequest } from '../../llm/types.js';
import { agentError } from './errors.js';
import { createAttemptSummary } from './summary.js';
import { loopOptions, parseAttempt, prepareLoopInput } from './validation.js';
import type { ParsedAttempt } from './validation.js';
import type { AgentLoop, AgentLoopInput, AgentLoopOptions, AgentLoopOutcome, AgentLoopResult } from './types.js';

type Stop = { readonly kind: 'cancelled' | 'deadline_exceeded' };
/** Только внедрённый клиент. Фабрика не создаёт инфраструктурные ресурсы. */
export function createAgentLoop(client: LlmClient, options: AgentLoopOptions = {},onAttempt?:(summary:import('./types.js').AgentLoopSummary)=>void): AgentLoop {
  const config = loopOptions(options);
  let invoke: LlmClient['complete'];
  try {
    const complete = client.complete;
    if (typeof complete !== 'function') throw Error();
    invoke = complete.bind(client);
  } catch { throw new TypeError('Некорректный клиент агентного цикла.'); }
  return Object.freeze({
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      const started = performance.now();
      const summary = createAttemptSummary();
      const finish = (outcome: AgentLoopOutcome): AgentLoopResult => Object.freeze({
        ...outcome, summary: summary.snapshot(Math.max(0, performance.now() - started)),
      });
      let prepared: AgentLoopInput;
      try { prepared = prepareLoopInput(input); }
      catch { return finish(agentError('invalid_input')); }
      if (prepared.signal?.aborted) return finish({ kind: 'cancelled' });
      const controller = new AbortController();
      const deadline = started + config.timeoutMs;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let pauseTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped: Stop | undefined;
      let resolveStop: (value: ParsedAttempt) => void = () => {};
      const halted = new Promise<ParsedAttempt>((resolve) => { resolveStop = resolve; });
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
        let attempts = 0;
        for (;;) {
          const before = checkStopped();
          if (before) return finish(before);
          // Единственный логический шаг. Вызов получает собственную изменяемую копию.
          const request: LlmRequest = {
            system: prepared.system, messages: prepared.messages.map((message) => ({ role: message.role, text: message.text })),
            maxOutputTokens: prepared.maxOutputTokens, sessionId: prepared.sessionId, signal: controller.signal,
          };
          summary.beginAttempt();
          attempts++;
          onAttempt?.(summary.snapshot(Math.max(0,performance.now()-started)));
          let pending: Promise<ParsedAttempt>;
          try { pending = Promise.resolve(invoke(request)).then(parseAttempt, () => parseAttempt(undefined)); }
          catch { pending = Promise.resolve(parseAttempt(undefined)); }
          const result = await Promise.race([pending, halted]);
          const after = checkStopped();
          if (after) return finish(after);
          summary.recordUsage(result.usage);
          const outcome = result.outcome;
          if (outcome.kind === 'error' && outcome.code === 'server' && config.retryServerErrors) {
            if (attempts >= config.maxAttemptsPerStep) return finish({ kind: 'attempt_limit', lastErrorCode: 'server' });
            const pause = new Promise<void>((resolve) => { pauseTimer = setTimeout(resolve, config.retryDelayMs); });
            try { await Promise.race([pause, halted]); }
            finally { clearTimeout(pauseTimer); pauseTimer = undefined; }
            continue;
          }
          return finish(outcome);
        }
      } catch { return finish(stopped ?? agentError('client_failure')); }
      finally {
        clearTimeout(deadlineTimer);
        clearTimeout(pauseTimer);
        try { prepared.signal?.removeEventListener('abort', onAbort); } catch { /* Без исходной диагностики. */ }
      }
    },
  });
}
