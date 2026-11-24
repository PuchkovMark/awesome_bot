import type { LlmResult } from '../llm/types';

export const llmRecoveryDefaults = Object.freeze({
  failureThreshold: 3,
  failureWindowMs: 30_000,
  initialPauseMs: 30_000,
  maxPauseMs: 300_000,
});

export interface LlmRecoverySettings {
  readonly failureThreshold: number;
  readonly failureWindowMs: number;
  readonly initialPauseMs: number;
  readonly maxPauseMs: number;
}

export type LlmAvailability = 'available' | 'paused' | 'probing' | 'stopped';

export interface LlmRecoveryPermit {
  readonly epoch: number;
  readonly probe: boolean;
}

export interface LlmRecovery {
  availability(): LlmAvailability;
  begin(): LlmRecoveryPermit | null;
  finish(permit: LlmRecoveryPermit, result: LlmResult | undefined): void;
}
