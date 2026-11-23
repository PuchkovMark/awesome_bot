export const passportSections = ['topic', 'rules', 'traditions', 'glossary', 'events'] as const;

export type PassportSection = (typeof passportSections)[number];

export interface PassportRevision {
  readonly section: PassportSection;
  readonly revision: number;
}

export interface PassportEntry extends PassportRevision {
  readonly text: string | null;
}
