export { passportSections } from '../contracts/chat-passport';
export type { PassportEntry, PassportSection } from '../contracts/chat-passport';

export const passportSectionBytes = 3000;
export const passportPromptLifetime = 15 * 60_000;

export type PassportPromptAction = 'edit' | 'clear';

export interface PassportReply {
  readonly receipt: string;
  readonly eventId: number;
  readonly text: string;
}

export type PassportReplyResult =
  'applied' | 'closed' | 'stale' | 'too_long' | 'empty' | 'invalid_confirmation' | 'duplicate';
