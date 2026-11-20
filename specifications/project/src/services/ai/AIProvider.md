# AIProvider

**Тип сущности:** общий контракт текстового AI-провайдера и типы запросов/ответов.
**Runtime identity:** `AIProvider`; типы `AIMessage`, `AIResponse`, `AITool`, `AIRequestOptions`.
**Источник:** [`src/services/ai/AIProvider.ts`](../../../../../src/services/ai/AIProvider.ts).

## Контракт

- `AIMessage` содержит `role` из `system | user | assistant` и строковый `content`. Формат tool-сообщений сюда не входит: инструменты представлены отдельно в `AIRequestOptions.tools`.
- `AIResponse` всегда содержит `content`; `id`, `provider`, суммарные `tokens` и раздельные `inputTokens`, `outputTokens`, `reasoningTokens` необязательны. Вызывающий код должен учитывать отсутствие отдельных счётчиков.
- `AITool` задаёт `name`, `description`, JSON Schema-подобное `parameters: Record<string, unknown>` и асинхронный `execute(args: unknown): Promise<string>`. Сам тип не проверяет схему или права; проверка аргументов и доступности выполняется в реализации цикла инструментов и в фабриках конкретных инструментов.
- `AIRequestOptions` позволяет передать `signal` для отмены, `sessionId`, только для чтения массив `tools`, `model`, `maxOutputTokens` и `maxToolCalls`. Тип не задаёт значения по умолчанию и не гарантирует, что конкретная реализация применяет каждую опцию.
- `AIProvider` предоставляет имя `name` и `send(messages, options?)`, возвращающий `Promise<AIResponse>`.

## Реализация и потребители

Текущая реализация текстового провайдера — [`OpenCodeProvider`](opencodeProvider.md), создаваемый [`getAIProvider`](providerFactory.md). [`sendChatCompletion`](chatCompletion.md) выполняет запросы с инструментами и проверяет ответы. Отдельный сервис [`chatDigestService`](chatDigestService.md) использует тот же интерфейс для чанкового суммирования истории и финального текста. Медиа-клиенты OpenAI не обязаны реализовывать этот контракт.

`AIProvider` не фиксирует транспорт, повторы, сетевой таймаут, формат вызова инструмента, доставку сообщения пользователю и сохранение истории. Эти свойства принадлежат провайдеру и вызывающему сервису. Для изменений контракта сверяйте всех потребителей и тесты конкретных реализаций.

## Проверки и ограничения

Отдельные тесты типа/интерфейса не обнаружены. Это статическая TypeScript-граница; поведение проверяется на уровнях [`chatCompletion`](chatCompletion.md), провайдера и сервисов-потребителей. Тесты документацией не запускались.
