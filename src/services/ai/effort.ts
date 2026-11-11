export const TEXT_MODEL = 'gemini-4-argon';

export const reasoningEfforts = {
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
} as const;

export type ReasoningEffort = keyof typeof reasoningEfforts;

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

export function parseReasoningEffort(value: string): ReasoningEffort | null {
  switch (value.trim().toLocaleLowerCase('ru-RU')) {
    case 'low':
    case 'низкий':
      return 'low';
    case 'medium':
    case 'средний':
      return 'medium';
    case 'high':
    case 'высокий':
      return 'high';
    default:
      return null;
  }
}

export function resolveReasoningEffort(
  saved: string | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort | null {
  return saved === undefined ? fallback : parseReasoningEffort(saved);
}
