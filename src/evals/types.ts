import type { PassportSection } from '../contracts/chat-passport';
import type { IncomingMessage, UserId } from '../contracts/index';
import type { GlobalVersionRef, VersionRef } from '../contracts/versioning';
import type { PublicationRequest, QueueCompletion } from '../core/index';
import type { LlmRequest } from '../llm/types';
import type { MessageInput } from '../storage/index';

export type HistorySearchOutcome = 'found' | 'empty' | 'failed';

export interface Observation {
  readonly firstRequest?: LlmRequest;
  readonly request: LlmRequest | null;
  readonly answer: PublicationRequest | null;
  readonly historyTruncated: boolean;
  readonly publicationReason?: import('../storage/trace-types').TracePublication['reason'];
  readonly route?: import('../storage/queue-types').RouteMetadata | null;
  readonly initiativeCandidate?: boolean;
  readonly grantsUnchanged?: boolean;
  readonly personaVersion?: VersionRef;
  readonly modelAttempts?: number;
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
  readonly passport?: {
    readonly local: Partial<Record<PassportSection, string>>;
    readonly neighbor?: Partial<Record<PassportSection, string>>;
    readonly tryGrant?: true;
  };
  readonly persona?: {
    readonly id: string;
    readonly useDefault?: true;
    readonly profile?: {
      readonly userId: UserId;
      readonly name: string;
      readonly visible: string;
      readonly hidden: string;
    };
  };
  readonly history: readonly MessageInput[];
  readonly historyLimit?: number;
  readonly historyTimezone?: string;
  readonly historySearch?: HistorySearchOutcome;
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
  readonly persona?: VersionRef | null;
  readonly extraction?: {
    readonly requestRevision: number;
    readonly inputEstimate: number;
    readonly outputReserve: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
  readonly outcome: 'passed' | 'failed' | 'technical_error';
  readonly reason: TechnicalReason | null;
  readonly criteria: readonly {
    readonly id: string;
    readonly outcome: 'passed' | 'failed' | 'not_checked';
    readonly reason: 'matched' | 'mismatch' | 'technical_error';
  }[];
}
