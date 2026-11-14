import type { ModelReasoningEffort, ReasoningEffort } from './effort.js';

export type TextModelId = 'deepseek-v4.1-flash' | 'gemini-4-argon';

export type TextModelDefinition = {
  id: TextModelId;
  label: string;
  aliases: readonly string[];
};

export const DEFAULT_TEXT_MODEL: TextModelId = 'deepseek-v4.1-flash';

export const TEXT_MODELS: readonly TextModelDefinition[] = [
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    aliases: ['deepseek', 'flash', 'дипсик'],
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    aliases: ['argon', 'gemini', 'аргон'],
  },
];

export function normalizeTextModel(value: string | null | undefined): TextModelId | undefined {
  const normalized = value?.trim().toLocaleLowerCase('ru-RU');
  if (!normalized) return undefined;
  return TEXT_MODELS.find((model) => model.id === normalized || model.aliases.includes(normalized))
    ?.id;
}

export function resolveTextModel(saved: string | null | undefined, fallback: string): string {
  const normalizedSaved = normalizeTextModel(saved);
  const normalizedFallback = normalizeTextModel(fallback);
  return normalizedSaved ?? normalizedFallback ?? (fallback.trim() || DEFAULT_TEXT_MODEL);
}

export function textModelLabel(id: string): string {
  return TEXT_MODELS.find((model) => model.id === id)?.label ?? id;
}

export function reasoningEffortForModel(
  model: string,
  effort: ReasoningEffort,
): ModelReasoningEffort {
  if (model === 'deepseek-v4.1-flash') {
    if (effort === 'high') return 'max';
    if (effort === 'medium') return 'high';
    return 'low';
  }
  return effort;
}
