import { groupReplyModel } from '../core/message-router/group-reply-gate';
import { createLlmClient, type LlmClient, type LlmConfig } from '../llm/index';

export function createGroupReplyClient(
  llm: LlmConfig,
  auxiliaryModel: string,
  auxiliary: LlmClient,
  create = createLlmClient,
) {
  return auxiliaryModel === groupReplyModel
    ? auxiliary
    : create({ ...llm, model: groupReplyModel });
}
