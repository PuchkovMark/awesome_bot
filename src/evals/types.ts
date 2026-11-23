import type { IncomingMessage } from '../contracts/index';
import type { GlobalVersionRef } from '../contracts/versioning';
import type { PublicationRequest, QueueCompletion } from '../core/index';
import type { LlmRequest } from '../llm/types';
import type { MessageInput } from '../storage/index';

export interface Observation {
  readonly request: LlmRequest | null;
  readonly answer: PublicationRequest | null;
  readonly historyTruncated: boolean;
}

interface Criterion {
  readonly id: string;
  readonly description: string;
  readonly check: (observation: Observation) => boolean;
  readonly vk?: string;
}

export interface Scenario {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly prompt: string;
  readonly history: readonly MessageInput[];
  readonly historyLimit?: number;
  readonly input: IncomingMessage;
  readonly answer: string;
  readonly criteria: readonly Criterion[];
  readonly vkSteps: readonly string[];
}

type LoopResult = NonNullable<QueueCompletion['result']>;
type TechnicalReason =
  | 'setup_failed'
  | 'not_queued'
  | 'settlement_timeout'
  | 'trace_missing'
  | 'publication_failed'
  | 'attempt_limit'
  | 'rate_limit'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'processing_failed'
  | NonNullable<QueueCompletion['preparationFailure']>
  | Extract<LoopResult, { kind: 'error' }>['code'];

export interface EvaluationResult {
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly model: string | null;
  readonly prompt: GlobalVersionRef | null;
  readonly outcome: 'passed' | 'failed' | 'technical_error';
  readonly reason: TechnicalReason | null;
  readonly criteria: readonly {
    readonly id: string;
    readonly outcome: 'passed' | 'failed' | 'not_checked';
    readonly reason: 'matched' | 'mismatch' | 'technical_error';
  }[];
}
