# Каталог текстовых моделей

**Тип:** каталог и преобразования. **Источник:** [textModels.ts](../../../../../src/services/ai/textModels.ts): `TEXT_MODELS`, `DEFAULT_TEXT_MODEL`, `normalizeTextModel`, `resolveTextModel`, `textModelLabel`, `reasoningEffortForModel`.

Известны `deepseek-v4.1-flash` (алиасы `deepseek`, `flash`, `дипсик`) и `gemini-4-argon` (`argon`, `gemini`, `аргон`); fallback по умолчанию — DeepSeek. Нормализация принимает ID или алиас с обрезкой пробелов и локализованным lowercase. `resolveTextModel` предпочитает корректное сохранённое значение, затем корректный fallback, затем непустой исходный fallback и только потом default ID. Для DeepSeek effort отображается как low→low, medium→high, high→max; для других моделей сохраняется исходный уровень. Настройки пользователя и права изменяются вне этого модуля.
