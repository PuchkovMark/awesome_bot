export const thinkingModes = {
  low: { label: 'низкий', model: 'deepseek-v4.1-flash' },
  medium: { label: 'средний', model: 'claude-haiku-5-5' },
  max: { label: 'максимальный', model: 'gemini-4-argon' },
} as const;

export type ThinkingMode = keyof typeof thinkingModes;

export const DEFAULT_THINKING_MODE: ThinkingMode = 'low';

export function parseThinkingMode(value: string): ThinkingMode | null {
  switch (value.trim().toLocaleLowerCase('ru-RU')) {
    case 'low':
    case 'низкий':
      return 'low';
    case 'medium':
    case 'средний':
      return 'medium';
    case 'max':
    case 'максимальный':
    case 'максимум':
      return 'max';
    default:
      return null;
  }
}
