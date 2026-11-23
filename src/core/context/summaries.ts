import { estimateRequestInput } from './budget';
import { appendSummaries } from './format';
import type { LlmRequest } from '../../llm/types';
export interface ContextSummary {
  readonly id: number;
  readonly level: 'fragment' | 'day' | 'rolling';
  readonly from: number;
  readonly to: number;
  readonly timezone: string;
  readonly text: string;
  readonly count: number;
  readonly ids: readonly number[];
}
export interface PreparedSummaries {
  readonly inputBudget: number;
  readonly entries: readonly ContextSummary[];
  current(ids: readonly number[]): boolean;
}
export function composeSummaries(
  entries: readonly ContextSummary[],
  index: number,
  request: LlmRequest,
  limit: number,
) {
  const target = request.messages[index];
  const used: ContextSummary[] = [];
  let composed = request;
  if (target?.role !== 'user') return { request, used };
  for (const entry of entries) {
    const data = [...used, entry].map(({ level, from, to, timezone, text, count }) => ({
      level,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timezone,
      availableMessages: count,
      text,
    }));
    const text = appendSummaries(target.text, data);
    if (!text) break;
    const messages = request.messages.slice();
    messages[index] = { ...target, text };
    const candidate = { ...request, messages };
    if (estimateRequestInput(candidate) > limit) continue;
    used.push(entry);
    composed = candidate;
  }
  return { request: composed, used };
}
