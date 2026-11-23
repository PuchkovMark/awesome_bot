import type { IncomingMessage, UserId } from '../contracts/index';
import type { GlobalVersionRef } from '../contracts/versioning';
import type { PublicationRequest, QueueCompletion } from '../core/index';
import type { LlmRequest } from '../llm/types';
import type { MessageInput } from '../storage/index';

export interface Observation {
  readonly request: LlmRequest | null;
  readonly answer: PublicationRequest | null;
  readonly historyTruncated: boolean;
  readonly publicationReason?: import('../storage/trace-types').TracePublication['reason'];
  readonly route?: import('../storage/queue-types').RouteMetadata | null;
  readonly initiativeCandidate?: boolean;
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
  readonly promptKey?: string;
  readonly initiative?: {
    readonly mode: 'active' | 'normal' | 'silent';
    readonly due?: boolean;
  };
  readonly address?: {
    readonly preference?: {
      readonly owner: UserId;
      readonly form: string;
      readonly state?: 'hidden' | 'reset' | 'neighbor';
    };
  };
  readonly history: readonly MessageInput[];
  readonly historyLimit?: number;
  readonly historyTimezone?: string;
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
