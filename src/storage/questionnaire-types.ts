export interface QuestionnaireReply {
  readonly receipt: string;
  readonly eventId: number;
  readonly text: string;
}

export type QuestionnaireReplyResult =
  | { readonly status: 'applied'; readonly count: number }
  | { readonly status: 'closed' | 'stale' | 'empty' | 'too_long' | 'invalid' | 'duplicate' };
export const questionnaireFieldPrefix = 'questionnaire:';
