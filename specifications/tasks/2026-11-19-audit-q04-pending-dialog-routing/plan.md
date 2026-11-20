# План Q04: Определить владельца ответа при нескольких ожидающих диалогах

**Основание:** [task.md](task.md), [находка Q04](../../../project-issues/specification-audit.md#q04-p2--несколько-ожидающих-диалогов-могут-претендовать-на-один-короткий-ответ), [реестр задач](../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
Зависимые шаги условны до явного ответа на решения D*. План нельзя передавать исполнителю как согласованный.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

Память, ReminderDraft, анкета и личные действия мафии имеют независимые pending states. Reminder draft принимает почти любой текст; manage_memory/manage_reminder занимают action-slot до проверки распознавания.

| Материал | Владелец / назначение |
| --- | --- |
| [vkService.ts](../../../src/services/vk/vkService.ts) | pendingMemorySelection / questionnaireOnly / reminderTool / memoryTool |
| [reminderService.ts](../../../src/services/reminders/reminderService.ts) | hasPendingDraft / shouldHandleMessage / handleMessage |
| [longTermMemoryService.ts](../../../src/services/memory/longTermMemoryService.ts) | hasPendingSelection / handleControlMessage |
| [memberService.ts](../../../src/services/member/memberService.ts) | shouldHandleQuestionnaireAnswer |
| [interactionTools.ts](../../../src/services/ai/tools/interactionTools.ts) | createBoundTool |
| [mafiaService.ts](../../../src/services/games/mafiaService.ts) | handlePrivateMessage |

Канонические описания: [vkService.md#маршрут-обычного-сообщения](../../project/src/services/vk/vkService.md#маршрут-обычного-сообщения), [reminderService.md#вход-и-диалоговые-черновики](../../project/src/services/reminders/reminderService.md#вход-и-диалоговые-черновики), [longTermMemoryService.md#явное-управление](../../project/src/services/memory/longTermMemoryService.md#явное-управление), [memberService.md#разбор-шаблона-и-пошаговый-ответ](../../project/src/services/member/memberService.md#разбор-шаблона-и-пошаговый-ответ).

## Принятые ограничения

Не расширять questionnaireOnly, quiet или права памяти; личные варианты не перечислять публично; slash-команды остаются явным отдельным маршрутом, а не ответом на любой draft.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

| Решение | Что выбрать | Предложение и альтернатива | Зависимые шаги |
| --- | --- | --- | --- |
| Q04-D1 | Выбор при двух подходящих pending. | Рекомендую отказаться от изменения и запросить явное указание операции существующим текстовым способом; альтернатива — фиксированный приоритет либо последний открытый диалог, который нужно формально выбрать. Никакой приоритет пока не принят. | S1–S2 |
| Q04-D2 | Граница распознавания и занятия action-slot. | Рекомендую отдельная чистая/читающая проверка принадлежности сообщения до beginAction, затем повторная проверка состояния при commit; альтернатива — единый router, выдающий ровно одного владельца. Не давать модели произвольные ID draft. | S2–S3 |

Для каждого решения сейчас статус «ожидает ответа». Обсуждать по одному; выбранная в интерфейсе рекомендация, молчание или общий запрос на план не являются согласием.

## Предложенная последовательность

**S0.** Перед зависимыми изменениями разрешить перечисленные D*, если они есть, и сверить текущий baseline с источниками.

**S1.** После D1 собрать только необходимые метаданные pending текущего sender/peer и описать приоритет существующих входов.
Владелец: [pendingMemorySelection / questionnaireOnly / reminderTool / memoryTool](../../../src/services/vk/vkService.ts). Критерии: AC-1.

**S2.** После D2 разделить распознавание и изменение reminder/memory/questionnaire, не расходовать beginAction при not_executed без эффекта.
Владелец: [hasPendingDraft / shouldHandleMessage / handleMessage](../../../src/services/reminders/reminderService.ts). Критерии: AC-2, AC-3.

**S3.** Согласовать routing с мафией в ЛС и R05 без автоматического удаления другого draft.
Владелец: [pendingMemorySelection / questionnaireOnly / reminderTool / memoryTool](../../../src/services/vk/vkService.ts). Критерии: AC-2, AC-4.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [vkService.md#маршрут-обычного-сообщения](../../project/src/services/vk/vkService.md#маршрут-обычного-сообщения); [pendingMemorySelection / questionnaireOnly / reminderTool / memoryTool](../../../src/services/vk/vkService.ts) | S1 | Все пары состояний и явный текст/короткий ответ/отмена/slash имеют один исход. |
| AC-2 | [vkService.md#маршрут-обычного-сообщения](../../project/src/services/vk/vkService.md#маршрут-обычного-сообщения); [hasPendingDraft / shouldHandleMessage / handleMessage](../../../src/services/reminders/reminderService.ts), [pendingMemorySelection / questionnaireOnly / reminderTool / memoryTool](../../../src/services/vk/vkService.ts) | S2, S3 | Первый неподходящий tool не блокирует второй подходящий; side effect по-прежнему единственный. Пары pending, чужой peer, тихая анкета и личная память в группе не раскрываются и не смешиваются. |
| AC-3 | [vkService.md#маршрут-обычного-сообщения](../../project/src/services/vk/vkService.md#маршрут-обычного-сообщения); [hasPendingDraft / shouldHandleMessage / handleMessage](../../../src/services/reminders/reminderService.ts) | S2 | Первый неподходящий tool не блокирует второй подходящий; side effect по-прежнему единственный. |
| AC-4 | [vkService.md#маршрут-обычного-сообщения](../../project/src/services/vk/vkService.md#маршрут-обычного-сообщения); [pendingMemorySelection / questionnaireOnly / reminderTool / memoryTool](../../../src/services/vk/vkService.ts) | S3 | Пары pending, чужой peer, тихая анкета и личная память в группе не раскрываются и не смешиваются. |

## Проверки и имеющиеся свидетельства

Integration test подменяет hasPendingSelection/hasPendingDraft и не проверяет реальные коллизии состояний.
Существующие относящиеся файлы: [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts).
При исполнении использовать существующие проверки `npm run check` и при необходимости `npm run build` внутри изолированного Node.js 22 согласно [operations](../../project/operations.md). Проверки специфичных сценариев из таблицы выполнить с подменёнными внешними вызовами/синтетическими данными; БД-гонки проверять на отдельной временной SQLite, а не на рабочем файле.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Рекомендованный отказ при коллизии может использовать существующие состояния без миграции. Выбор «последний открытый» требует проверки доступности timestamp у всех типов, а не предположения о нём.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [vkService.md#маршрут-обычного-сообщения](../../project/src/services/vk/vkService.md#маршрут-обычного-сообщения), [reminderService.md#вход-и-диалоговые-черновики](../../project/src/services/reminders/reminderService.md#вход-и-диалоговые-черновики), [longTermMemoryService.md#явное-управление](../../project/src/services/memory/longTermMemoryService.md#явное-управление), [memberService.md#разбор-шаблона-и-пошаговый-ответ](../../project/src/services/member/memberService.md#разбор-шаблона-и-пошаговый-ответ); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
