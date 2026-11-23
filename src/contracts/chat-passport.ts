export const passportSections = ['topic', 'rules', 'traditions', 'glossary', 'events'] as const;

export type PassportSection = (typeof passportSections)[number];

export interface PassportEntry {
  readonly section: PassportSection;
  readonly revision: number;
  readonly text: string | null;
}
