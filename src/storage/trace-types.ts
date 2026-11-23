import type { ConnectionScope } from '../contracts/index';
import type { ContextMetadata, PreparationFailure } from '../core/context/types';
import type { AgentLoopSummary } from '../core/agent-loop/types';
import type { RouteMetadata } from './queue-types';
export interface TracePublication {
  readonly rowId: string;
  readonly tableVersion: 1;
  readonly reaction: 'answer' | 'notice' | 'silence';
  readonly status: 'pending_checks' | 'allowed' | 'suppressed' | 'delivered' | 'failed' | 'unknown';
  readonly reason:
    | 'none'
    | 'no_port'
    | 'guard'
    | 'no_reply'
    | 'notice_period'
    | 'response_rate'
    | 'trace_write_failed'
    | 'publication_failed'
    | 'journal_failed'
    | 'partial_delivery';
}
export interface TracePayload {
  readonly disclosure?: { readonly version: number | null; readonly allowed: boolean };
  readonly model: { readonly name: string | null; readonly invoked: 'no' | 'possible' | 'yes' };
  readonly prompt: ContextMetadata['version'] | null;
  readonly context: ContextMetadata | null;
  readonly summary: AgentLoopSummary | null;
  readonly route: RouteMetadata | null;
  readonly resultKind: string | null;
  readonly preparationFailure: PreparationFailure | null;
  readonly publication: TracePublication;
  readonly degraded: boolean;
  readonly degradation: 'none' | 'write_failed' | 'size_exceeded' | 'legacy_metadata_missing';
  readonly tools: readonly {
    readonly name: string;
    readonly outcome: 'success' | 'failed' | 'denied';
    readonly bytes: number;
    readonly durationMs: number;
  }[];
}
export interface TraceRecord {
  readonly jobId: number;
  readonly messageId: number;
  readonly generation: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly expiresAt: number;
  readonly outcome: string | null;
  readonly payload: TracePayload;
}
export interface TraceReader {
  get(scope: ConnectionScope, jobId: number): Promise<TraceRecord | null>;
  last(scope: ConnectionScope): Promise<TraceRecord | null>;
}
