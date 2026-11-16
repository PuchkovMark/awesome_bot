# Ограничения голосового ответа

**Тип:** константы и predicate. **Источник:** [voiceLimits.ts](../../../../../src/services/voice/voiceLimits.ts): `MIN_AUTO_VOICE_CHARACTERS = 500`, `MAX_VOICE_TEXT_LENGTH = 4096`, `isLongEnoughForAutomaticVoice`.

Автоматическая озвучка включается, если `Array.from(text).length > 500`, то есть ровно 500 символов недостаточно; подсчёт идёт по Unicode code points, а не UTF-16 code units. Максимальный размер текста отдельного voice-участка задан как 4096. Используется сервисом ответа и инструкциями возможностей; включённость модуля и настройка пользователя проверяются вызывающим кодом.
