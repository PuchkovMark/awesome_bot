import type { GlobalVersionRef } from '../../contracts/versioning';
import type { AgentLoopInput } from '../agent-loop/types';
export type PreparationFailure =
  | 'missing_system_prompt'
  | 'static_budget_too_small'
  | 'current_message_too_large'
  | 'internal_error';
export interface ContextMetadata {
  readonly version: GlobalVersionRef;
  readonly cutoffId: number;
  readonly messageIds: readonly number[];
  readonly layerBytes: Readonly<{ system: number; environment: number; messages: number }>;
  readonly estimatedTokens: number;
  readonly scanned: number;
  readonly historyTruncated: boolean;
  readonly reply: 'none' | 'included' | 'truncated' | 'unavailable';
  readonly absentLayers: readonly string[];
}
export type PreparationResult =
  | {
      readonly kind: 'ready';
      readonly input: Omit<AgentLoopInput, 'signal'>;
      readonly metadata: ContextMetadata;
    }
  | { readonly kind: 'failed'; readonly reason: PreparationFailure }
  | { readonly kind: 'cancelled' | 'unavailable' | 'deadline_exceeded' };
