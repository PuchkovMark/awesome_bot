# План R11: Проверять доступ к локальной истории до разрешения авторов

**Основание:** [task.md](task.md), [находка R11](../../../../project-issues/specification-audit.md#r11-p2--разрешение-авторов-локальной-истории-происходит-до-проверки-доступа), [реестр задач](../../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
Зависимые шаги условны до явного ответа на решения D*. План нельзя передавать исполнителю как согласованный.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

createLocalChatHistoryTool вызывает resolveParticipants и может вернуть needs_clarification/not_found с именами и ID до checkAccess. Порядок проверен в execute; раскрытие конечному пользователю в полном runtime не воспроизводилось.

| Материал | Владелец / назначение |
| --- | --- |
| [localChatHistoryTool.ts](../../../../src/services/ai/tools/localChatHistoryTool.ts) | createLocalChatHistoryTool.execute / participantError |
| [vkService.ts](../../../../src/services/vk/vkService.ts) | checkReadToolAccess / resolveParticipants callback |
| [memoryService.ts](../../../../src/services/memory/memoryService.ts) | resolveConversationParticipants |

Канонические описания: [tools.md#get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history), [vkService.md#ai-инструменты-действия-и-доставка](../../../project/src/services/vk/vkService.md#ai-инструменты-действия-и-доставка).

## Принятые ограничения

Schema и статусы истории, предел 1–5 авторов, запрет participant-фильтра в ЛС, текущие лимиты и уточнение для разрешённого неоднозначного имени.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

| Решение | Что выбрать | Предложение и альтернатива | Зависимые шаги |
| --- | --- | --- | --- |
| R11-D1 | Повторная проверка после асинхронного resolver. | Рекомендую guard до resolver и непосредственно перед выдачей метаданных/чтением сообщений; альтернатива — единый серверный access snapshot с формально ограниченным временем действия, которое ещё не определено. | S1–S2 |

Для каждого решения сейчас статус «ожидает ответа». Обсуждать по одному; выбранная в интерфейсе рекомендация, молчание или общий запрос на план не являются согласием.

## Предложенная последовательность

**S0.** Перед зависимыми изменениями разрешить перечисленные D*, если они есть, и сверить текущий baseline с источниками.

**S1.** Переместить проверку доступа до resolver и participantError; оставить чистую валидацию аргументов перед I/O.
Владелец: [createLocalChatHistoryTool.execute / participantError](../../../../src/services/ai/tools/localChatHistoryTool.ts). Критерии: AC-1, AC-2.

**S2.** После D1 определить повторный guard для результата resolver, не расходовать бюджет выдачи по запрещённому чтению.
Владелец: [createLocalChatHistoryTool.execute / participantError](../../../../src/services/ai/tools/localChatHistoryTool.ts). Критерии: AC-3, AC-4.

**S3.** Проверить привязку к checkReadToolAccess в обычном/active запросе и неизменность questionnaireOnly.
Владелец: [checkReadToolAccess / resolveParticipants callback](../../../../src/services/vk/vkService.ts). Критерии: AC-2, AC-3.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [tools.md#get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history); [createLocalChatHistoryTool.execute / participantError](../../../../src/services/ai/tools/localChatHistoryTool.ts) | S1 | checkAccess denied, resolver-count=0, SQL-count=0 для ambiguous и not_found. |
| AC-2 | [tools.md#get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history); [createLocalChatHistoryTool.execute / participantError](../../../../src/services/ai/tools/localChatHistoryTool.ts), [checkReadToolAccess / resolveParticipants callback](../../../../src/services/vk/vkService.ts) | S1, S3 | checkAccess denied, resolver-count=0, SQL-count=0 для ambiguous и not_found. До decision, после delivery и обычное разрешённое чтение в группе/ЛС. |
| AC-3 | [tools.md#get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history); [createLocalChatHistoryTool.execute / participantError](../../../../src/services/ai/tools/localChatHistoryTool.ts), [checkReadToolAccess / resolveParticipants callback](../../../../src/services/vk/vkService.ts) | S2, S3 | Смена режима внутри resolver и разрешённые прежние ответы. До decision, после delivery и обычное разрешённое чтение в группе/ЛС. |
| AC-4 | [tools.md#get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history); [createLocalChatHistoryTool.execute / participantError](../../../../src/services/ai/tools/localChatHistoryTool.ts) | S2 | Смена режима внутри resolver и разрешённые прежние ответы. |

## Проверки и имеющиеся свидетельства

Существующий тест denied проверяет отсутствие getMessages; он не проверяет число вызовов resolver при participant-фильтре.
Существующие относящиеся файлы: [localChatHistoryTool.test.ts](../../../../test/localChatHistoryTool.test.ts), [vkMessageDeliveryIntegration.test.ts](../../../../test/vkMessageDeliveryIntegration.test.ts).
При исполнении использовать существующие проверки `npm run check` и при необходимости `npm run build` внутри изолированного Node.js 22 согласно [operations](../../../project/operations.md). Проверки специфичных сценариев из таблицы выполнить с подменёнными внешними вызовами/синтетическими данными; БД-гонки проверять на отдельной временной SQLite, а не на рабочем файле.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Не нужна. Политика чтения старых строк и способ временного курсора принадлежат Q03 и не меняются здесь.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [tools.md#get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history), [vkService.md#ai-инструменты-действия-и-доставка](../../../project/src/services/vk/vkService.md#ai-инструменты-действия-и-доставка); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
