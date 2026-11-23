import type { LlmErrorCode, LlmUsage } from '../../llm/types';

export interface AgentLoopMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}
export interface AgentLoopInput {
  readonly system: string;
  readonly messages: readonly AgentLoopMessage[];
  readonly maxOutputTokens: number;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}
export interface AgentLoopOptions {
  readonly maxSteps?: number;
  /** Включает первую попытку шага. */
  readonly maxAttemptsPerStep?: number;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly retryServerErrors?: boolean;
}
export interface TokenCounter {
  readonly knownTokens: number | null;
  readonly unknownAttempts: number;
  readonly overflowed: boolean;
}
export interface AgentLoopSummary {
  readonly steps: number;
  readonly attempts: number;
  readonly attemptsPerStep: readonly number[];
  readonly durationMs: number;
  readonly usage: { readonly input: TokenCounter; readonly output: TokenCounter };
}
export type AgentLoopErrorCode =
  Exclude<LlmErrorCode, 'rate_limit' | 'cancelled'> | 'invalid_input' | 'client_failure';
export interface AttemptReservation {
  readonly cancelBeforeSend: () => void;
  readonly recordUsage: (usage: LlmUsage) => void;
}
export type AttemptAdmission =
  | boolean
  | AttemptReservation
  | 'quota_exhausted'
  | 'token_budget_exhausted'
  | 'initiative_budget_exhausted'
  | 'context_stale';
export type AgentLoopOutcome =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'incomplete'; readonly partialText: string }
  | {
      readonly kind:
        | 'refused'
        | 'empty'
        | 'rate_limit'
        | 'quota_exhausted'
        | 'token_budget_exhausted'
        | 'initiative_budget_exhausted'
        | 'tools_not_supported'
        | 'step_limit'
        | 'cancelled'
        | 'deadline_exceeded';
    }
  | { readonly kind: 'attempt_limit'; readonly lastErrorCode: 'server' }
  | { readonly kind: 'error'; readonly code: AgentLoopErrorCode; readonly message: string };
export type AgentLoopResult = AgentLoopOutcome & { readonly summary: AgentLoopSummary };
export interface AgentLoop {
  run(input: AgentLoopInput): Promise<AgentLoopResult>;
}

/** Доверенный сеанс инструментов одного задания. Параметры модели не содержат этот порт. */
export interface LoopTools {
  schemas(
    request: import('../../llm/types').LlmRequest,
  ): Promise<readonly import('../../llm/types').LlmToolDescription[]>;
  current(): boolean;
  budgetExhausted?(): boolean;
  helperSteps(): number;
  beginBatch(
    request: import('../../llm/types').LlmRequest,
    pending: readonly string[],
    parentSteps: number,
    isLoopCurrent: () => boolean,
  ): void;
  execute(
    call: import('../../llm/types').LlmToolCall,
    issued: readonly import('../../llm/types').LlmToolDescription[],
  ): Promise<string>;
  subjectIds?(): readonly import('../../contracts/index').UserId[];
  sourceIds(): readonly number[];
  trace(): readonly {
    name: string;
    outcome: 'success' | 'denied' | 'failed';
    bytes: number;
    durationMs: number;
  }[];
  labels(): readonly string[];
  helperSummary?(): ReadonlyArray<readonly import('../../llm/types').LlmUsage[]>;
}
