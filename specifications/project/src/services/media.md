# Изображения, документы и голос

Документ описывает статически проверенные сервисы `src/services/image/`, `document/`, `voice/`, загрузку VK и direct-command routes в `VkService`. Контракты AI-инструментов `generate_image` и `analyze_attachment` — в [каталоге инструментов](ai/tools.md).


## Описание по модулям

- [vkFileDownload](vk/vkFileDownload.md)
- [imageGenerationService](image/imageGenerationService.md)
- [imageAnalysisService](image/imageAnalysisService.md)
- [imageDocument](image/imageDocument.md)
- [imageError](image/imageError.md)
- [documentAnalysisService](document/documentAnalysisService.md)
- [voiceService](voice/voiceService.md)
- [voiceLimits](voice/voiceLimits.md)
- [voiceResponseService](voice/voiceResponseService.md)

## VK-вложения и direct commands

`DetectorService.parseImageCommand` распознаёт `/` или `!` image/edit после удаления адресного префикса бота; aliases нормализуются через общий `commandAliases`. Prompt — весь остаток строки после команды. Пустой prompt возвращает подсказку. Для image/edit не-администратор бота допускается только при `ChatSettings.imageAccess=all`. Один дневной UTC счётчик объединяет image generate и edit по `ApiUsage`; лимит берётся из `IMAGE_MAX_PER_USER_PER_DAY`.

| Команда | Выбор и маршрут |
| --- | --- |
| `/image` | Создаёт новое изображение через `ImageGenerationService.generate`, отправляет фото и записывает usage. |
| `/edit` | Выбирает первое photo attachment текущего сообщения (при необходимости force-load), иначе первое фото reply; вызывает edit и отправляет результат. Если фото нет — сообщает, где его приложить. |
| `/analyze` | Тот же image access guard. Сначала ищет фото текущего сообщения/reply; при отсутствии — документ. Фото анализирует `ImageAnalysisService`, документ — `DocumentAnalysisService`. |
| `/ocr` | Тот же guard, но принимает только фото и вызывает OCR prompt `ImageAnalysisService`; если фото нет, предлагает `/document`. |
| `/document` | Требует документ и запускает `DocumentAnalysisService`. Код сначала ищет фото; если найдено фото, поиск документа не производится и возвращается подсказка о поддерживаемом типе команды. |
| `/meme` | Тот же image access guard; фото по возможности скачивается и отдельно получает нейтральное описание через `ImageAnalysisService`, затем `MemeService.create`; отправляется JPEG с `fun_feedback` keyboard. Без фото используется текстовый запрос. |

Для `analyze`, `ocr`, `document` выбираются attachment текущего сообщения раньше reply; helper force-load-ит payload при необходимости. `PhotoAttachment` имеет приоритет над документом. При отсутствии вложения маршрутизатор предлагает приложить файл или ответить на сообщение с ним. Ошибка image-analysis/doc-analysis отображается общим сообщением про формат/размер/API key; сервисы сохраняют специализированные проверки и детали в журнале. `/image`/`/edit` отдельно отображают отказ moderation, ошибку VK 917 и общую ошибку модели.

## Голосовые сценарии

Входящее `AudioMessageAttachment` транскрибируется только когда включён `VOICE_ENABLED` и `UserSettings.voiceEnabled`; транскрипт заменяет текст сообщения и дальше проходит обычный addressed/command/AI pipeline. При отключённом голосе сообщение пропускается; при ошибке отправляется уведомление, текст не передаётся дальше. Успешная транскрипция учитывается как `voice_transcription`.

`/say <текст>` синтезирует выбранным пользовательским голосом, default `coral`; в беседе без аргумента можно ответить на текстовое сообщение. Ответ с аудио содержит исходный текст и вложение. Проверяются модуль, ключ, длина до 4096 JS code units и rate limit группы. При ошибке синтеза/загрузки отправляется текст с `VOICE_FAILURE_NOTICE`; успешный вызов учитывается как `voice_say`.

Автоматический голосовой ответ выбирается после AI, если модуль и пользовательская настройка включены, а ответ длиннее 500 Unicode code points. В группе синтезируется один усечённый audio segment вместе с текстом; в ЛС текст делится и каждый непустой фрагмент озвучивается отдельно. Ошибка генерации озвучки даёт текстовый fallback и не отменяет уже отправленные фрагменты. Usage `voice` записывается только для удачных voice uploads. Функция ответа описана в [voiceResponseService](voice/voiceResponseService.md); выбор голоса управляется [командой `/voice`](command/commands.md#command-voice).

## Свидетельства

Тесты, относящиеся к части маршрута: `vkFileDownload.test.ts` проверяет загрузку и URL guards; `voiceResponseService.test.ts` — отправку/fallback озвучки; `vkMessageDeliveryIntegration.test.ts` проверяет интеграционный delivery harness, а не полный media `runBotCommand`. Прямых тестов `VkService` для каждого image/document/meme/say маршрута и тестов самих image/document service нет; runtime/VK/OpenAI не запускались.
