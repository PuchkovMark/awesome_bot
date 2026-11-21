import type { LlmErrorCode } from '../../llm/types.js';

export interface AgentLoopMessage { readonly role: 'user' | 'assistant'; readonly text: string }
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
export type AgentLoopErrorCode = Exclude<LlmErrorCode, 'rate_limit' | 'cancelled'> | 'invalid_input' | 'client_failure';
export type AgentLoopOutcome =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'incomplete'; readonly partialText: string }
  | { readonly kind: 'refused' | 'empty' | 'rate_limit' | 'tools_not_supported' | 'cancelled' | 'deadline_exceeded' }
  | { readonly kind: 'attempt_limit'; readonly lastErrorCode: 'server' }
  | { readonly kind: 'error'; readonly code: AgentLoopErrorCode; readonly message: string };
export type AgentLoopResult = AgentLoopOutcome & { readonly summary: AgentLoopSummary };
export interface AgentLoop { run(input: AgentLoopInput): Promise<AgentLoopResult> }
