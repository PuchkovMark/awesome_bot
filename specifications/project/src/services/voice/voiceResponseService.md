# voiceResponseService

[voiceResponseService.ts](../../../../../src/services/voice/voiceResponseService.ts) при отсутствии выбранного голоса отправляет текст. В группе формируется один текстовый ответ с голосовым вложением из усечённой версии текста; в ЛС текст делится на части и каждая отправляется с собственным аудио. При ошибке синтеза или загрузки отправляется текст с пометкой о неудачной озвучке. Для учёта использования вызывается необязательный callback; его ошибка логируется и не отменяет доставку.

`voiceResponseService.test.ts` содержит шесть source-level сценариев: text-only без TTS; group single attachment; group text-limit truncation с синхронной озвучкой отправленной части; private split с отдельным audio per part и reply/keyboard только на первой части; group synthesis failure с text fallback/notice; private failure с доставкой text segment. Тесты не запускались при составлении спецификации.
