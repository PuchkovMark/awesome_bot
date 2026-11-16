# Уровень рассуждений

**Тип:** типы и функции нормализации. **Источник:** [effort.ts](../../../../../src/services/ai/effort.ts): `reasoningEfforts`, `parseReasoningEffort`, `resolveReasoningEffort`, `DEFAULT_REASONING_EFFORT`.

Допустимые настройки: `low`, `medium`, `high`, с русскими эквивалентами; значение по умолчанию `low`. `parseReasoningEffort` игнорирует края и регистр с локалью `ru-RU`; неизвестная строка даёт `null`. `resolveReasoningEffort` использует fallback только при `undefined`; заданное, но неверное сохранённое значение даёт `null`. Тип `ModelReasoningEffort` дополнительно допускает `max`, который используется как преобразование для конкретной модели в [textModels](textModels.md). Модуль не сохраняет настройки и не проверяет права.
