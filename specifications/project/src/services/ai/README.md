# ИИ, история и инструменты

Текстовый ИИ доступен через контракт [AIProvider.ts](../../../../../src/services/ai/AIProvider.ts) и [providerFactory.ts](../../../../../src/services/ai/providerFactory.ts), который создаёт `OpenCodeProvider`. Список текстовых моделей и их нормализация находятся в [textModels.ts](../../../../../src/services/ai/textModels.ts): предусмотрены DeepSeek V4.1 Flash и Gemini 4 Argon. OpenAI используется отдельно для медиа, голоса и при настройке эмбеддингов памяти. Доступные модели и параметры уточняйте по коду и `.env.example`.

## Инструменты и контекст

Инструменты модели находятся в [src/services/ai/tools](../../../../../src/services/ai/tools). `vkService.ts` создаёт их для текущего события, передавая необходимые зависимости и контекст. Среди возможностей — справка и выполнение команд, история, время, погода, данные VK, вложения, изображения, игры, напоминания и память. Контекст отправителя и беседы, проверки прав и ограничения действий должны сохраняться при изменении инструментов.

Обычная история и долговременная память — разные механизмы. `memory/memoryService.ts` работает с контекстом диалога, `memory/longTermMemoryService.ts` — с долговременной памятью; границы хранения описаны в [data.md](../../../prisma/README.md). Инструкции персонажей и настройки находятся в `services/settings/`.

## Большая история и субагенты

`run_subagent` запускает фоновую задачу по сохранённой SQL-истории, а `get_subagent_status` возвращает состояние последней задачи. [subagentService.ts](../../../../../src/services/ai/subagentService.ts) управляет очередью, лимитами и обработкой частей; `subagentTools.ts` предоставляет чтение, поиск и суммаризацию истории, а также внешний инструмент текущего времени. `chatDigestService.ts` выполняет обработку фрагментов, а `subagentResultDeliveryService.ts` отвечает за доставку результата. Субагент не выполняет пользовательские действия и формирует внутренний отчёт для основной модели. Параметры лимитов указаны в `.env.example`; поведение восстановления и остановки проверяйте по реализации.


## Описание по модулям

- [AIProvider](AIProvider.md) — общий TypeScript-контракт запроса, ответа и инструмента.
- [chatDigestService](chatDigestService.md) — выборка истории, чанковая суммаризация и финальный пересказ.
- [chatCompletion](chatCompletion.md) — общий цикл запроса и инструментов.
- [capabilityService](capabilityService.md) — контекст возможностей для модели.
- [effort](effort.md) — уровни рассуждений.
- [providerFactory](providerFactory.md) — создание провайдера.
- [textModels](textModels.md) — модели, алиасы и нормализация.
- [Полный каталог инструментов](tools.md) — контракты и контексты доступности.
- [Общие helpers инструментов](tools/README.md) — строгий разбор дат и VK user information, используемые несколькими tool-модулями.
- [Инструмент времени](../time/timeService.md) и [погоды](../weather/weatherService.md) — внешние источники данных.
- [opencodeProvider](opencodeProvider.md)
- [subagentService](subagentService.md)
- [subagentResultDeliveryService](subagentResultDeliveryService.md)
