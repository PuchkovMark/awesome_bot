import type { ConnectionScope } from '../contracts/index';

export interface ProfileCommandEvent {
  readonly scope: ConnectionScope;
  readonly messageId: string;
  readonly at: number;
}

export type ProfileCommandChange =
  | { readonly kind: 'correct'; readonly value: string }
  | { readonly kind: 'hide' }
  | { readonly kind: 'reject' };

export interface ProfileCommandEdit {
  readonly messageId: string;
  readonly at: number;
  readonly replyId: string;
  readonly position: number;
  readonly change: ProfileCommandChange;
}

export type ProfileCommandEditResult =
  'applied' | 'duplicate' | 'stale' | 'not_inferred' | 'conflict' | 'questionnaire';
