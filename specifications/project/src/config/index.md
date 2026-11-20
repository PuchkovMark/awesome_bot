# Конфигурация приложения

Источник значений и проверки — [config/index.ts](../../../../src/config/index.ts), примеры — [.env.example](../../../../.env.example); для SQLite `DATABASE_URL` читается также [schema.prisma](../../../../prisma/schema.prisma). Ниже перечислены ключи `AppConfig`, их типы, прямые потребители и фактическое влияние. Реальный `.env` и секреты не читались.

`required` требует непустой `VK_TOKEN` и `VK_GROUP_ID` в `NODE_ENV=production`; в других режимах отсутствие выдаёт предупреждение и пустую строку. Почти все числовые лимиты обрабатываются `positiveInteger`: отсутствие даёт значение по умолчанию, нецелое или меньше единицы вызывает ошибку. `PORT` использует `optionalNumber`, а `CONTEXT_TTL_HOURS` дополнительно ограничивается 24 часами. Булевы переменные сравниваются со строками: `VOICE_ENABLED` включён только при `true`, `IMAGE_ADMIN_ONLY` выключен только при `false`.

## Интеграции и модели

| Ключ | Значение без переменной и назначение |
| --- | --- |
| `VK_TOKEN`, `VK_GROUP_ID` | Пусто вне production; токен и ID сообщества. |
| `VK_SERVICE_TOKEN`, `OPENCODE_API_KEY`, `OPENAI_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY` | Необязательные ключи соответствующих интеграций; отсутствие может отключить отдельные функции. |
| `OPENCODE_MODEL` | `deepseek-v4.1-flash`, текстовая модель; сохранённые настройки могут переопределять выбор. |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/go/openai/v1`. |
| `AI_EFFORT` | `low`; допустимы `low`, `medium`, `high`. |
| `AI_MAX_OUTPUT_TOKENS` | 32768, положительное целое не более 32768. |
| `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL` | `gpt-4.1-mini`, `gpt-image-2.6-flare` для анализа и изображений. |
| `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_TTS_MODEL` | `gpt-transcribe`, `gpt-4o-mini-tts` для голоса. |
| `VOICE_ENABLED` | `false`, если переменная отсутствует; пример окружения задаёт `true`. Личная настройка пользователя дополнительно влияет на голосовые ответы. |
| `WEB_SEARCH_PROVIDER` | `serper`; допустимы `none`, `serper`, `tavily`. |
| `MEMORY_EMBEDDING_API_KEY` | При отсутствии используется `OPENAI_API_KEY`, иначе ключ отсутствует. |
| `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small`. |

## Лимиты и общие настройки

| Ключ | Значение без переменной |
| --- | --- |
| `VK_ADMIN_IDS` | Пустой список; строка разбивается по запятым. |
| `IMAGE_ADMIN_ONLY`, `IMAGE_MAX_PER_USER_PER_DAY` | `true`, 20. |
| `AI_MAX_RETRIES`, `AI_MAX_TOOL_CALLS` | 2, 10. |
| `MAX_REQUESTS_PER_MINUTE`, `MAX_HISTORY_MESSAGES`, `MAX_INPUT_CHARS` | 10, 30, 12000. |
| `CONTEXT_TTL_HOURS`, `MAX_HISTORY_TOKENS` | 24 часа и 4000 токенов; TTL не больше 24 часов. |
| `MEMEDAY_TIMEZONE` | `UTC`; значение проверяется как IANA-зона. У беседы могут быть свои настройки. |
| `PORT`, `LOG_LEVEL`, `BOT_NAME` | 3000, `info`, `awesome_bot`; наличие `PORT` само по себе не доказывает запуск HTTP-сервера. |

## Суммаризация и субагенты

| Ключ | Значение без переменной |
| --- | --- |
| `SUMMARY_MODEL` | `claude-haiku-5-5`. |
| `SUMMARY_CHUNK_MESSAGES`, `SUMMARY_CHUNK_CHARS` | 300 сообщений, 12000 символов. |
| `SUMMARY_CHUNK_OUTPUT_TOKENS`, `SUMMARY_CHUNK_OUTPUT_TOKENS_MAX` | 1200 и 2400; оба ограничены `AI_MAX_OUTPUT_TOKENS`, второй не меньше первого. |
| `SUMMARY_MAX_DIGEST_CHARS`, `SUMMARY_MAX_CHARS` | 8000 и 2000. |
| `SUBAGENT_MAX_MESSAGES`, `SUBAGENT_MIN_MESSAGES` | 3000 и 100. |
| `SUBAGENT_MAX_TOOL_CALLS`, `SUBAGENT_MAX_OUTPUT_CHARS` | 8 и 2000. |
| `SUBAGENT_TIMEOUT_MINUTES`, `SUBAGENT_PART_TIMEOUT_MINUTES` | 30 и 15 минут. |
| `SUBAGENT_DAILY_LIMIT`, `SUBAGENT_CONCURRENCY` | 10 задач на пользователя и 2 одновременно. |
| `SUBAGENT_MAX_PARTS`, `SUBAGENT_SECOND_PART_MIN_MESSAGES` | 2 и 500 сообщений. |
| `SUBAGENT_PROVIDER_CONCURRENCY`, `SUBAGENT_SUMMARIZE_CONCURRENCY` | 6 и 3. |
| `SUBAGENT_MAX_SUMMARY_CHARS`, `SUBAGENT_MAX_SUMMARY_CHUNKS` | 300000 и 25. |
| `SUBAGENT_MAX_ESTIMATED_INPUT_TOKENS`, `SUBAGENT_MAX_INPUT_TOKENS`, `SUBAGENT_MAX_OUTPUT_TOKENS` | 90000, 120000 и 35000. |
| `SUBAGENT_MAX_SUMMARIZE_CALLS`, `SUBAGENT_MAX_SEARCH_RESULTS`, `SUBAGENT_RESULT_RETENTION_DAYS` | 1, 50 и 7 дней. |

Для прямого `run_subagent` из перечисленных ограничений используется `SUBAGENT_PROVIDER_CONCURRENCY`; остальные `SUBAGENT_*` лимиты относятся к старому фоновому пути или иным потребителям. Прямой путь задаёт `maxOutputTokens=8000` явно, независимо от `AI_MAX_OUTPUT_TOKENS`, и использует `SUMMARY_MODEL`. См. [DirectSubagentService](../services/ai/directSubagentService.md).

Все 60 ключей `AppConfig` присутствуют в `.env.example`; единственный дополнительный ключ `DATABASE_URL` принадлежит Prisma, а не `AppConfig`. Сверка литеральных значений примера с кодом показала одно намеренное различие: в примере `VOICE_ENABLED=true`, при отсутствии переменной код выключает голос. Все потребители ниже найдены статическим поиском по текущему рабочему дереву.

## Прямые потребители `AppConfig`

Значения по умолчанию перечислены в таблицах выше. В колонке «Потребитель» указаны все найденные прямые чтения `config.KEY`; использование одной настройки через уже загруженные объекты (например, `ChatSettings`) описывается отдельно ниже.

| Ключ | Тип | Потребитель и эффект |
| --- | --- | --- |
| `VK_TOKEN` | `string` | [VkService](../../../../src/services/vk/vkService.ts) запускает Long Poll; [SenderService](../../../../src/services/sender/senderService.ts) отправляет сообщения и загружает вложения. |
| `VK_SERVICE_TOKEN` | `string?` | [VkService](../../../../src/services/vk/vkService.ts) создаёт отдельный API-клиент для публичных данных; без ключа такой клиент отсутствует. |
| `VK_GROUP_ID` | `string` | [DetectorService](../../../../src/services/detector/detectorService.ts) распознаёт упоминание сообщества; [VkService](../../../../src/services/vk/vkService.ts) задаёт polling group; [SenderService](../../../../src/services/sender/senderService.ts) проверяет доступ к личным сообщениям. |
| `VK_ADMIN_IDS` | `string[]` | [SettingsService](../../../../src/services/settings/settingsService.ts) добавляет ID к роли администратора и защищает их от снятия роли. |
| `OPENCODE_API_KEY` | `string?` | [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts) авторизует запросы текстовой модели; отсутствие ключа выявляется при создании/вызове провайдера, а не общей проверкой конфигурации. |
| `OPENCODE_MODEL` | `string` | [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts) выбирает текстовую модель по умолчанию; [CommandService](../../../../src/services/command/commandService.ts) показывает эффективную модель с учётом сохранённого override. |
| `OPENCODE_BASE_URL` | `string` | [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts) задаёт endpoint API. |
| `AI_EFFORT` | `ReasoningEffort` | [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts) использует как fallback; [CommandService](../../../../src/services/command/commandService.ts) показывает и меняет эффективный уровень. |
| `AI_MAX_OUTPUT_TOKENS` | `number` | [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts) ограничивает ответ; [SubagentService](../../../../src/services/ai/subagentService.ts) использует как предел в отдельных запросах. |
| `AI_MAX_RETRIES` | `number` | Ограничивает повторы SDK-клиентов [OpenCode](../../../../src/services/ai/opencodeProvider.ts), [документов](../../../../src/services/document/documentAnalysisService.ts), [изображений](../../../../src/services/image/imageAnalysisService.ts), [генерации изображений](../../../../src/services/image/imageGenerationService.ts) и [голоса](../../../../src/services/voice/voiceService.ts). |
| `AI_MAX_TOOL_CALLS` | `number` | [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts) ограничивает циклы вызова инструментов основной модели. |
| `OPENAI_API_KEY` | `string?` | Используется в [capabilityService](../../../../src/services/ai/capabilityService.ts), [attachment tool](../../../../src/services/ai/tools/attachmentTool.ts), [image tool](../../../../src/services/ai/tools/imageTool.ts), [CommandService](../../../../src/services/command/commandService.ts), [DocumentAnalysisService](../../../../src/services/document/documentAnalysisService.ts), [ImageAnalysisService](../../../../src/services/image/imageAnalysisService.ts), [ImageGenerationService](../../../../src/services/image/imageGenerationService.ts), [VkService](../../../../src/services/vk/vkService.ts) и [VoiceService](../../../../src/services/voice/voiceService.ts). Включает/авторизует соответствующие OpenAI-функции, но не обязателен для запуска процесса. |
| `OPENAI_MODEL` | `string` | [DocumentAnalysisService](../../../../src/services/document/documentAnalysisService.ts) и [ImageAnalysisService](../../../../src/services/image/imageAnalysisService.ts) выбирают модель анализа. |
| `OPENAI_IMAGE_MODEL` | `string` | [ImageTool](../../../../src/services/ai/tools/imageTool.ts), [ImageGenerationService](../../../../src/services/image/imageGenerationService.ts) и [VkService](../../../../src/services/vk/vkService.ts) выбирают модель генерации/редактирования. |
| `OPENAI_TRANSCRIPTION_MODEL` | `string` | [VoiceService](../../../../src/services/voice/voiceService.ts) выбирает модель транскрибации. |
| `OPENAI_TTS_MODEL` | `string` | [VoiceService](../../../../src/services/voice/voiceService.ts) выбирает модель синтеза речи. |
| `VOICE_ENABLED` | `boolean` | [capabilityService](../../../../src/services/ai/capabilityService.ts), [SubagentResultDeliveryService](../../../../src/services/ai/subagentResultDeliveryService.ts), [CommandService](../../../../src/services/command/commandService.ts), [VkService](../../../../src/services/vk/vkService.ts) и [VoiceService](../../../../src/services/voice/voiceService.ts) проверяют глобальный switch. Пользовательская настройка применяется дополнительно для автоматической озвучки ответов. |
| `IMAGE_ADMIN_ONLY` | `boolean` | Только [SettingsService](../../../../src/services/settings/settingsService.ts): задаёт `ChatSettings.imageAccess` при первом создании настроек беседы. Существующее сохранённое значение этой переменной не перезаписывается. |
| `IMAGE_MAX_PER_USER_PER_DAY` | `number` | [ImageQuotaService](../../../../src/services/image/imageQuotaService.ts) проверяет лимит внутри атомарной резервации автора/UTC-дня, общей для команд и image tool. [Tool](../../../../src/services/ai/tools/imageTool.ts) и [VkService](../../../../src/services/vk/vkService.ts) также используют значение в сообщении об исчерпании квоты. |
| `MAX_REQUESTS_PER_MINUTE` | `number` | [VkService](../../../../src/services/vk/vkService.ts) создаёт rate limiter для запросов пользователя. |
| `MAX_HISTORY_MESSAGES` | `number` | [MemoryService](../../../../src/services/memory/memoryService.ts) ограничивает число сообщений в нескольких выборках контекста. |
| `MAX_HISTORY_TOKENS` | `number` | [MemoryService](../../../../src/services/memory/memoryService.ts) ограничивает token budget контекста. |
| `MAX_INPUT_CHARS` | `number` | [VkService](../../../../src/services/vk/vkService.ts), [command execution tool](../../../../src/services/ai/tools/commandExecutionTool.ts) и [interaction tools](../../../../src/services/ai/tools/interactionTools.ts) ограничивают размер входа/действия. |
| `CONTEXT_TTL_HOURS` | `number` | [MemoryService](../../../../src/services/memory/memoryService.ts) ограничивает срок локального контекста; значение уже ограничено 24 часами при разборе конфигурации и снова ограничивается в сервисе. |
| `MEMORY_EMBEDDING_API_KEY` | `string?` | [MemoryEmbeddings](../../../../src/services/memory/memoryEmbeddings.ts) создаёт embedding-клиент; значение конфигурации использует fallback на `OPENAI_API_KEY`. |
| `MEMORY_EMBEDDING_MODEL` | `string` | [MemoryEmbeddings](../../../../src/services/memory/memoryEmbeddings.ts) выбирает модель embedding. |
| `WEB_SEARCH_PROVIDER` | `'none' \| 'serper' \| 'tavily'` | [SearchService](../../../../src/services/search/searchService.ts), [capabilityService](../../../../src/services/ai/capabilityService.ts) и [VkService](../../../../src/services/vk/vkService.ts) выбирают/объявляют автоматический поиск. |
| `SERPER_API_KEY` | `string?` | [SearchService](../../../../src/services/search/searchService.ts), [capabilityService](../../../../src/services/ai/capabilityService.ts) и [VkService](../../../../src/services/vk/vkService.ts) проверяют доступность Serper. |
| `TAVILY_API_KEY` | `string?` | [SearchService](../../../../src/services/search/searchService.ts), [capabilityService](../../../../src/services/ai/capabilityService.ts) и [VkService](../../../../src/services/vk/vkService.ts) проверяют доступность Tavily. |
| `MEMEDAY_TIMEZONE` | `string` | [MemeDayService](../../../../src/services/fun/memeDayService.ts) задаёт часовую зону по умолчанию; сохранённая зона беседы имеет приоритет. |
| `SUMMARY_MODEL` | `string` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts) выбирает модель промежуточных и финальных сводок субагента. |
| `SUMMARY_CHUNK_MESSAGES` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts) и [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) задают размер чанка по сообщениям. |
| `SUMMARY_CHUNK_CHARS` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts) и [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) задают предел размера текста чанка. |
| `SUMMARY_CHUNK_OUTPUT_TOKENS` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts) ограничивает вывод одной промежуточной выжимки. |
| `SUMMARY_CHUNK_OUTPUT_TOKENS_MAX` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts) задаёт верхний лимит повторной попытки для chunk summary. |
| `SUMMARY_MAX_DIGEST_CHARS` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts), [SubagentService](../../../../src/services/ai/subagentService.ts) и [subagent tools](../../../../src/services/ai/tools/subagentTools.ts) ограничивают передаваемые выжимки. |
| `SUMMARY_MAX_CHARS` | `number` | Прямого чтения в `src/` не найдено; сейчас это разобранное, но не влияющее на runtime значение. |
| `SUBAGENT_MAX_MESSAGES` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts), [SubagentService](../../../../src/services/ai/subagentService.ts), [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) и [VkService](../../../../src/services/vk/vkService.ts) ограничивают выборку истории. |
| `SUBAGENT_MIN_MESSAGES` | `number` | [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) отказывает при слишком короткой выборке. |
| `SUBAGENT_MAX_TOOL_CALLS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) ограничивает число итераций инструментов внутри задания. |
| `SUBAGENT_MAX_OUTPUT_CHARS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) и [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) ограничивают сохранённый/возвращаемый результат. |
| `SUBAGENT_TIMEOUT_MINUTES` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) определяет устаревание/общий timeout задания. |
| `SUBAGENT_PART_TIMEOUT_MINUTES` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) задаёт timeout обработки части истории. |
| `SUBAGENT_DAILY_LIMIT` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) ограничивает число заданий пользователя за сутки. |
| `SUBAGENT_CONCURRENCY` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) задаёт параллелизм основной очереди. |
| `SUBAGENT_MAX_PARTS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) и [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) определяют максимальное разбиение задачи. |
| `SUBAGENT_SECOND_PART_MIN_MESSAGES` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) и [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) определяют порог второй части. |
| `SUBAGENT_PROVIDER_CONCURRENCY` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) и [DirectSubagentService](../../../../src/services/ai/directSubagentService.ts) ограничивают параллельные запросы провайдера отдельными счётчиками. |
| `SUBAGENT_SUMMARIZE_CONCURRENCY` | `number` | [ChatDigestService](../../../../src/services/ai/chatDigestService.ts) и [subagent tools](../../../../src/services/ai/tools/subagentTools.ts) ограничивают параллельные summarize-вызовы. |
| `SUBAGENT_MAX_SUMMARY_CHARS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) и [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) ограничивают объём исходной истории в символах. |
| `SUBAGENT_MAX_SUMMARY_CHUNKS` | `number` | [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) ограничивает оценочное число чанков. |
| `SUBAGENT_MAX_ESTIMATED_INPUT_TOKENS` | `number` | [subagent tool](../../../../src/services/ai/tools/subagentTool.ts) отклоняет чрезмерную расчётную выборку до запуска job. |
| `SUBAGENT_MAX_INPUT_TOKENS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) задаёт фактический input budget. |
| `SUBAGENT_MAX_OUTPUT_TOKENS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) задаёт фактический output budget. |
| `SUBAGENT_MAX_SUMMARIZE_CALLS` | `number` | [subagent tools](../../../../src/services/ai/tools/subagentTools.ts) ограничивает вызовы инструмента `summarize_history` на задачу. |
| `SUBAGENT_MAX_SEARCH_RESULTS` | `number` | [subagent tools](../../../../src/services/ai/tools/subagentTools.ts) ограничивает число результатов `search_history`. |
| `SUBAGENT_RESULT_RETENTION_DAYS` | `number` | [SubagentService](../../../../src/services/ai/subagentService.ts) задаёт срок хранения завершённых заданий. |
| `LOG_LEVEL` | `string` | [logger](../../../../src/logger/index.ts) задаёт уровень логирования. |
| `BOT_NAME` | `string` | [bootstrap.ts](../../../../src/bootstrap.ts) использует только в стартовом сообщении журнала; распознавание обращений к боту это значение не меняет. |
| `PORT` | `number` | Прямого чтения в `src/` не найдено; HTTP-сервер, использующий этот порт, отсутствует в проверенном runtime. |

## Применение и приоритет сохранённых настроек

- `OPENCODE_MODEL` и `AI_EFFORT` являются fallback для основной текстовой модели и рассуждения. Если в `AppSetting` сохранены `ai_model` или `ai_effort`, провайдер использует сохранённые допустимые значения; проверки находятся в [OpenCodeProvider](../../../../src/services/ai/opencodeProvider.ts), изменение — в [команде model](../services/command/commands.md#command-model) и [команде effort](../services/command/commands.md#command-effort).
- `IMAGE_ADMIN_ONLY` применяется только при создании новой строки `ChatSettings` в [SettingsService](../../../../src/services/settings/settingsService.ts). Существующее поле `imageAccess` и команда `/imageaccess` имеют приоритет, а проверки медиа используют именно сохранённое значение беседы. Комментарий `.env.example` описывает итоговое ограничение шире, чем реальная роль этого ключа.
- `VOICE_ENABLED` — глобальный рубильник; автоматическая речь дополнительно зависит от `UserSettings.voiceEnabled`. Явный `/say` требует глобально включённого модуля и OpenAI ключа, но не проверяет личный автоматический переключатель.
- `MEMORY_EMBEDDING_API_KEY` при пустом значении наследует `OPENAI_API_KEY`. Поисковые ключи используются только вместе с `WEB_SEARCH_PROVIDER`; при включённом поиске сервис может переключиться на второй настроенный провайдер.
- `MEMEDAY_TIMEZONE` используется как значение по умолчанию для настроек публикации; явная зона, сохранённая для беседы, перекрывает его.
- `BOT_NAME` не влияет на обращения: [DetectorService](../../../../src/services/detector/detectorService.ts) проверяет жёстко заданные формы «Пенёк» и «Пенёчек». Комментарий в `.env.example` об изменении распознаваемого имени не подтверждается кодом.
- `PORT` и `SUMMARY_MAX_CHARS` валидируются/сохраняются в объекте конфигурации, но найденных runtime-потребителей нет. Комментарий `SUMMARY_MAX_CHARS` в `.env.example` не подтверждается текущим кодом.

Проверка соответствия окружения: **60/60** полей `AppConfig` представлены в `.env.example`; дополнительный `DATABASE_URL` читается Prisma из [schema.prisma](../../../../prisma/schema.prisma). `VOICE_ENABLED=true` в примере отличается от fallback `false`, поэтому поведение без переменной и при копировании примера различается. Другие значения-примеры соответствуют текущим fallback или выбранным явным настройкам; credentials оставлены пустыми/placeholders.
