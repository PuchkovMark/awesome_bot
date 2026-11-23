export const passportSections = ['topic', 'rules', 'traditions', 'glossary', 'events'] as const;
export const passportSectionBytes = 3000;
export const passportPromptLifetime = 15 * 60_000;

export type PassportSection = (typeof passportSections)[number];
export type PassportPromptAction = 'edit' | 'clear';

export interface PassportEntry {
  readonly section: PassportSection;
  readonly revision: number;
  readonly text: string | null;
}

export interface PassportReply {
  readonly receipt: string;
  readonly eventId: number;
  readonly text: string;
}

export type PassportReplyResult =
  'applied' | 'closed' | 'stale' | 'too_long' | 'empty' | 'invalid_confirmation' | 'duplicate';
