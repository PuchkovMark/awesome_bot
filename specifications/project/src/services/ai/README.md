# ИИ, история и инструменты

Текстовый ИИ доступен через контракт [AIProvider.ts](../../../../../src/services/ai/AIProvider.ts) и [providerFactory.ts](../../../../../src/services/ai/providerFactory.ts), который создаёт `OpenCodeProvider`. Список текстовых моделей и их нормализация находятся в [textModels.ts](../../../../../src/services/ai/textModels.ts): предусмотрены DeepSeek V4.1 Flash и Gemini 4 Argon. OpenAI используется отдельно для медиа, голоса и при настройке эмбеддингов памяти. Доступные модели и параметры уточняйте по коду и `.env.example`.

## Инструменты и контекст

Инструменты модели находятся в [src/services/ai/tools](../../../../../src/services/ai/tools). `vkService.ts` создаёт их для текущего события, передавая необходимые зависимости и контекст. Среди возможностей — справка и выполнение команд, история, время, погода, данные VK, вложения, изображения, игры, напоминания и память. Контекст отправителя и беседы, проверки прав и ограничения действий должны сохраняться при изменении инструментов.

Обычная история и долговременная память — разные механизмы. `memory/memoryService.ts` работает с контекстом диалога, `memory/longTermMemoryService.ts` — с долговременной памятью; границы хранения описаны в [data.md](../../../prisma/README.md). Инструкции персонажей и настройки находятся в `services/settings/`.

## Большая история и субагенты

`run_subagent` в текущем VK-пути ожидает [прямую обработку](directSubagentService.md) сохранённой истории и возвращает текст основной модели. Старые [SubagentService](subagentService.md), его инструменты и доставка сохраняются для фонового пути; `get_subagent_status` относится к сохранённым заданиям, не к прямой операции.


## Описание по модулям

- [DirectSubagentService](directSubagentService.md) — прямой последовательный пересказ.
- [historySnapshot](historySnapshot.md) — фиксирование ID и постраничное чтение.
- [historyTranscript](historyTranscript.md) — границы и деление Unicode-текста.
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
