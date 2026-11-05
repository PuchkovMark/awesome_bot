export type SummaryHours = 2 | 6;

export function getSummaryHoursFromPayload(payload: unknown): SummaryHours | null {
  let value: unknown = payload;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || !('command' in value) || !('hours' in value)) {
    return null;
  }
  const data = value as { command?: unknown; hours?: unknown };
  if (data.command !== 'summary' || (data.hours !== 2 && data.hours !== 6)) return null;
  return data.hours;
}

export function getSummaryHoursFromText(text: string): SummaryHours | null {
  const match = text.match(/(?:^|\s)(?:за\s*)?(2|6)\s*(?:ч(?:ас(?:а|ов)?)?)?(?=$|\s)/iu);
  if (!match) return null;
  return Number(match[1]) as SummaryHours;
}

export function limitSentences(text: string, maximum: number): string {
  const segments = Array.from(
    new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(text.trim()),
    ({ segment }) => segment,
  );
  return segments.slice(0, maximum).join('').trim();
}
