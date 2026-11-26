import type { Timestamp } from '../contracts/index';

export interface QuestionnaireReply {
  readonly receipt: string;
  readonly eventId: number;
  readonly eventAt: Timestamp;
  readonly text: string;
}

export type QuestionnaireReplyResult =
  | { readonly status: 'applied'; readonly count: number }
  | {
      readonly status: 'confirm';
      readonly before: number;
      readonly shown: number;
      readonly question: string;
    }
  | {
      readonly status:
        'kept' | 'choose' | 'closed' | 'stale' | 'empty' | 'too_long' | 'invalid' | 'duplicate';
    };
export const questionnaireFieldPrefix = 'questionnaire:';

export function questionnaireMessageSequence(id: string): number | null {
  const sequence = Number(id);
  return Number.isSafeInteger(sequence) && sequence > 0 && String(sequence) === id
    ? sequence
    : null;
}
