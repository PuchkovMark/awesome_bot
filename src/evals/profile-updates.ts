import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { estimateRequestInput } from '../core/context/budget';
import {
  parseProfileUpdates,
  profileUpdatePromptRevision,
  profileUpdateRequest,
} from '../core/profile-updates/request';
import type { LlmClient, LlmResult } from '../llm/types';
import { profileUpdateCases } from './scenarios';
import type { EvaluationResult } from './types';

type Sample = (typeof profileUpdateCases)[number];

function sources(sample: Sample) {
  return sample.messages.map(({ user, text }, i) => ({ id: i + 1, at: i + 1, user, text }));
}

function assess(
  sample: Sample,
  response: LlmResult,
  model: string,
  mocked: boolean,
): EvaluationResult {
  const parsed =
    response.kind === 'complete' ? parseProfileUpdates(sources(sample), response.text) : null;
  const actual = parsed
    ?.sort((left, right) => left.messageId - right.messageId)
    .map((fact) => ({
      messageId: fact.messageId,
      fieldKey: fact.change.kind === 'set' ? fact.change.fieldKey : null,
      value: fact.change.kind === 'set' ? fact.change.value : null,
    }));
  const technical =
    response.kind === 'error' || response.kind === 'incomplete' || response.kind === 'empty';
  const passed =
    response.kind === 'complete' &&
    (mocked && 'mockRejected' in sample
      ? parsed === null
      : isDeepStrictEqual(actual, sample.expected));
  return {
    scenarioId: 'profile-update-' + sample.id,
    scenarioRevision: 1,
    model,
    prompt: null,
    outcome: technical ? 'technical_error' : passed ? 'passed' : 'failed',
    reason: response.kind === 'error' ? response.code : technical ? 'processing_failed' : null,
    criteria: [
      {
        id: mocked ? 'verified-attribution' : 'selected-facts',
        outcome: technical ? 'not_checked' : passed ? 'passed' : 'failed',
        reason: technical ? 'technical_error' : passed ? 'matched' : 'mismatch',
      },
    ],
  };
}

export function runProfileUpdateMocks() {
  return profileUpdateCases.map((sample) =>
    assess(
      sample,
      { kind: 'complete', text: sample.mockOutput, usage: { input: null, output: null } },
      'synthetic-local',
      true,
    ),
  );
}

export async function runProfileUpdateModel(client: LlmClient, model: string, caseId?: string) {
  const session = randomUUID();
  const cases =
    caseId === undefined
      ? profileUpdateCases
      : profileUpdateCases.filter(({ id }) => id === caseId);
  const plan = cases.map((sample, i) => {
    const request = profileUpdateRequest(sources(sample), session + '-' + i, 1024);
    return { sample, request, estimated: estimateRequestInput(request) };
  });
  const reserve = plan.reduce(
    (tokens, { request, estimated }) => tokens + estimated + request.maxOutputTokens,
    0,
  );
  if (!plan.length || plan.length > 7 || reserve > (caseId === undefined ? 7_500 : 1_500))
    throw Error('profile_eval_budget');

  const results: EvaluationResult[] = [];
  for (const { sample, request, estimated } of plan) {
    const response = await client.complete(request);
    results.push({
      ...assess(sample, response, model, false),
      extraction: {
        requestRevision: profileUpdatePromptRevision,
        inputEstimate: estimated,
        outputReserve: request.maxOutputTokens,
        inputTokens: 'usage' in response ? response.usage.input : null,
        outputTokens: 'usage' in response ? response.usage.output : null,
      },
    });
  }
  return results;
}
