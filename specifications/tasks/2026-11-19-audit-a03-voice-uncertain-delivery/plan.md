# План A03: Разделить голосовой fallback и неопределённый исход отправки VK

**Основание:** [task.md](task.md), [находка A03](../../../project-issues/specification-audit.md#a03-p2--голосовой-fallback-противоречит-запрету-повторной-отправки-при-неизвестном-результате-vk), [реестр задач](../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
Зависимые шаги условны до явного ответа на решения D*. План нельзя передавать исполнителю как согласованный.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

Один catch в групповой и личной ветвях `sendVoiceAwareResponse` охватывает TTS, upload и messages.send; любой сбой вызывает новую текстовую отправку. Старый сервис доставки субагентов может затем повторить весь результат.

| Материал | Владелец / назначение |
| --- | --- |
| [voiceResponseService.ts](../../../src/services/voice/voiceResponseService.ts) | sendVoiceAwareResponse |
| [senderService.ts](../../../src/services/sender/senderService.ts) | SenderService.send / uploadVoice |
| [vkService.ts](../../../src/services/vk/vkService.ts) | deliverAssistantMessage |
| [subagentResultDeliveryService.ts](../../../src/services/ai/subagentResultDeliveryService.ts) | доставка голосового результата |

Канонические описания: [voiceResponseService.md](../../project/src/services/voice/voiceResponseService.md), [vkService.md#лимиты-права-ошибки-и-побочные-эффекты](../../project/src/services/vk/vkService.md#лимиты-права-ошибки-и-побочные-эффекты), [subagentResultDeliveryService.md#доставка-результата](../../project/src/services/ai/subagentResultDeliveryService.md#доставка-результата).

## Принятые ограничения

Озвучка длинных ответов, разбиение ЛС, одна групповая отправка, reply/keyboard первой части и текстовый fallback до начала messages.send.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

| Решение | Что выбрать | Предложение и альтернатива | Зависимые шаги |
| --- | --- | --- | --- |
| A03-D1 | Внутренний контракт исхода доставки. | Рекомендую типизированный результат sent/not_sent/uncertain с номером части; альтернатива — классифицированная ошибка и прежний успешный результат. Согласовать всех callers, включая старую доставку. | S1–S3 |
| A03-D2 | Продолжение ЛС после uncertain. | Рекомендую прекратить оставшиеся части, не повторяя уже начатую; альтернатива — продолжить только ещё не начатые части с явным частичным исходом. | S2–S3 |
| A03-D3 | Сохранённая старая доставка при uncertain. | Рекомендую не ставить новый автоматический send без устойчивого идентификатора исходной попытки; способ хранения/продолжения согласовать отдельно, если текущего состояния недостаточно. | S3 |

Для каждого решения сейчас статус «ожидает ответа». Обсуждать по одному; выбранная в интерфейсе рекомендация, молчание или общий запрос на план не являются согласием.

## Предложенная последовательность

**S0.** Перед зависимыми изменениями разрешить перечисленные D*, если они есть, и сверить текущий baseline с источниками.

**S1.** Разделить фазы синтеза/upload и messages.send; fallback ограничить выбранным подтверждённо неотправленным состоянием.
Владелец: [sendVoiceAwareResponse](../../../src/services/voice/voiceResponseService.ts). Критерии: AC-1, AC-2.

**S2.** После D1/D2 передавать исход конкретной части без повторной генерации сообщения под новым randomId.
Владелец: [SenderService.send / uploadVoice](../../../src/services/sender/senderService.ts). Критерии: AC-2, AC-4.

**S3.** Согласовать обработку исходов в основном VK caller и старом subagent delivery, включая историю, usage и будущий повтор.
Владелец: [deliverAssistantMessage](../../../src/services/vk/vkService.ts). Критерии: AC-3, AC-4.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [voiceResponseService.md](../../project/src/services/voice/voiceResponseService.md); [sendVoiceAwareResponse](../../../src/services/voice/voiceResponseService.ts) | S1 | TTS fail и upload fail дают текст; send принял сообщение и выбросил timeout — без копии. |
| AC-2 | [voiceResponseService.md](../../project/src/services/voice/voiceResponseService.md); [sendVoiceAwareResponse](../../../src/services/voice/voiceResponseService.ts), [SenderService.send / uploadVoice](../../../src/services/sender/senderService.ts) | S1, S2 | TTS fail и upload fail дают текст; send принял сообщение и выбросил timeout — без копии. Ошибка на второй части ЛС не повторяет первую и соблюдает выбранное продолжение. |
| AC-3 | [voiceResponseService.md](../../project/src/services/voice/voiceResponseService.md); [deliverAssistantMessage](../../../src/services/vk/vkService.ts) | S3 | Интеграционный caller не превращает uncertain в fallback или обычный успешный статус. |
| AC-4 | [voiceResponseService.md](../../project/src/services/voice/voiceResponseService.md); [SenderService.send / uploadVoice](../../../src/services/sender/senderService.ts), [deliverAssistantMessage](../../../src/services/vk/vkService.ts) | S2, S3 | Ошибка на второй части ЛС не повторяет первую и соблюдает выбранное продолжение. Интеграционный caller не превращает uncertain в fallback или обычный успешный статус. |

## Проверки и имеющиеся свидетельства

Текущие voice-тесты проверяют TTS fallback и части, но не timeout после принятия сообщения.
Существующие относящиеся файлы: [voiceResponseService.test.ts](../../../test/voiceResponseService.test.ts), [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts), [subagentResultDeliveryService.test.ts](../../../test/subagentResultDeliveryService.test.ts).
При исполнении использовать существующие проверки `npm run check` и при необходимости `npm run build` внутри изолированного Node.js 22 согласно [operations](../../project/operations.md). Проверки специфичных сценариев из таблицы выполнить с подменёнными внешними вызовами/синтетическими данными; БД-гонки проверять на отдельной временной SQLite, а не на рабочем файле.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Для разделения фаз миграция не нужна. Устойчивые идентификаторы частей/статус неопределённой старой доставки могут потребовать изменений хранения; это зависит от D1/D3 и не разрешено автоматически.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [voiceResponseService.md](../../project/src/services/voice/voiceResponseService.md), [vkService.md#лимиты-права-ошибки-и-побочные-эффекты](../../project/src/services/vk/vkService.md#лимиты-права-ошибки-и-побочные-эффекты), [subagentResultDeliveryService.md#доставка-результата](../../project/src/services/ai/subagentResultDeliveryService.md#доставка-результата); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
