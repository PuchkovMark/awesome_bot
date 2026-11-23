export interface QuestionnaireReply {
  readonly receipt: string;
  readonly eventId: number;
  readonly text: string;
}

export type QuestionnaireReplyResult =
  | { readonly status: 'applied'; readonly count: number }
  | { readonly status: 'closed' | 'stale' | 'empty' | 'too_long' | 'invalid' | 'duplicate' };
export const questionnaireFieldPrefix = 'questionnaire:';
export const questionnaireReviewDelayMs = 15 * 60_000;
export const questionnaireAccessOpenSql =
  "coalesce(a.decision='open' OR (a.decision IS NULL AND a.prompt_delivered_at<=@autoOpenThrough),0)";
