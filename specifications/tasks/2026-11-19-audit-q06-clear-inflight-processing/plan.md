# План Q06: Определить границу очистки при уже выполняющейся обработке

**Основание:** [task.md](task.md), [находка Q06](../../../project-issues/specification-audit.md#q06-p2--очистка-данных-не-описывает-взаимодействие-с-уже-выполняющейся-обработкой), [реестр задач](../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
Зависимые шаги условны до явного ответа на решения D*. План нельзя передавать исполнителю как согласованный.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

clearUserHistory удаляет Message выбранного автора/peer; явная очистка памяти удаляет LongTermMemory, а captureAutomatically работает fire-and-forget. Прямой пересказ хранит уже прочитанные сообщения/выжимки в процессе.

| Материал | Владелец / назначение |
| --- | --- |
| [memoryService.ts](../../../src/services/memory/memoryService.ts) | clearUserHistory |
| [longTermMemoryService.ts](../../../src/services/memory/longTermMemoryService.ts) | handleControlMessage / captureAutomatically / persistCandidate |
| [directSubagentService.ts](../../../src/services/ai/directSubagentService.ts) | run / stop / активные операции |
| [historySnapshot.ts](../../../src/services/ai/historySnapshot.ts) | createHistorySnapshot / readHistorySnapshotPage |
| [vkService.ts](../../../src/services/vk/vkService.ts) | scheduleAutomaticMemoryCapture / финальная доставка |
| [commandService.ts](../../../src/services/command/commandService.ts) | reset / forget |
| [schema.prisma](../../../prisma/schema.prisma) | User / Conversation / LongTermMemory / Message |

Канонические описания: [commands.md#command-reset](../../project/src/services/command/commands.md#command-reset), [commands.md#command-forget](../../project/src/services/command/commands.md#command-forget), [longTermMemoryService.md#автоматическое-сохранение](../../project/src/services/memory/longTermMemoryService.md#автоматическое-сохранение), [longTermMemoryService.md#явное-управление](../../project/src/services/memory/longTermMemoryService.md#явное-управление), [directSubagentService.md#обработка](../../project/src/services/ai/directSubagentService.md#обработка).

## Принятые ограничения

/forget не становится удалением всего аккаунта. Профили, напоминания, игры и чужие данные не удаляются; уже начатый VK send нельзя объявить отменённым. Различать личную историю, общую историю и долговременные факты.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

| Решение | Что выбрать | Предложение и альтернатива | Зависимые шаги |
| --- | --- | --- | --- |
| Q06-D1 | Незавершённая работа после очистки. | Рекомендую запретить новые записи в очищаемую область и новые отправки из прежнего снимка после подтверждения; альтернатива — разрешать ранее начатому снимку завершение при явном предупреждении и запрете повторного сохранения очищенных фактов. | S1–S3 |
| Q06-D2 | Механизм барьера и область гарантий. | Рекомендую устойчивую ревизию очищаемого owner/scope с проверкой в commit и перед send для нескольких процессов; альтернатива — отмена/ожидание активных работ с явно ограниченной одним процессом гарантией. Схема и межпроцессный контракт ещё не согласованы. | S2–S3 |
| Q06-D3 | Цитаты и ранее сохранённые производные копии. | Рекомендую перечислить остающиеся самостоятельные сущности в подтверждении и не вводить каскадное удаление чужих цитат без отдельного правила; альтернативу очистки известных копий согласовать по владению и объёму. | S1–S3 |

Для каждого решения сейчас статус «ожидает ответа». Обсуждать по одному; выбранная в интерфейсе рекомендация, молчание или общий запрос на план не являются согласием.

## Предложенная последовательность

**S0.** Сначала получить необходимые решения из [Q03](../2026-11-19-audit-q03-history-time-retention-policy/plan.md), [Q04](../2026-11-19-audit-q04-pending-dialog-routing/plan.md) и решений D* этой задачи. Статическое уточнение источников и подготовка сценариев могут выполняться независимо.

**S1.** После D1/D3 определить точную область каждой существующей операции, включив уже прочитанный snapshot и сохранённые quote-поля.
Владелец: [clearUserHistory](../../../src/services/memory/memoryService.ts). Критерии: AC-1.

**S2.** После D2 связать очистку и отметку барьера атомарно; stale extraction проверяет owner/scope ещё раз непосредственно при persist.
Владелец: [handleControlMessage / captureAutomatically / persistCandidate](../../../src/services/memory/longTermMemoryService.ts). Критерии: AC-2, AC-4.

**S3.** Связать snapshot/активные операции и финальную доставку с выбранным барьером, отдельно обработать уже начатый VK send и новые сообщения.
Владелец: [run / stop / активные операции](../../../src/services/ai/directSubagentService.ts). Критерии: AC-3, AC-4.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [commands.md#command-reset](../../project/src/services/command/commands.md#command-reset); [clearUserHistory](../../../src/services/memory/memoryService.ts) | S1 | Матрица личная/общая память, одна/все беседы, сообщения/факты/цитаты. |
| AC-2 | [commands.md#command-reset](../../project/src/services/command/commands.md#command-reset); [handleControlMessage / captureAutomatically / persistCandidate](../../../src/services/memory/longTermMemoryService.ts) | S2 | Extraction приостановлен, выполнена очистка, ответ AI продолжен; старый факт не появляется в запрещённом scope. |
| AC-3 | [commands.md#command-reset](../../project/src/services/command/commands.md#command-reset); [run / stop / активные операции](../../../src/services/ai/directSubagentService.ts) | S3 | Пересказ до/после чтения страницы, очистка в другом peer, рестарт и два процесса по согласованной гарантии. |
| AC-4 | [commands.md#command-reset](../../project/src/services/command/commands.md#command-reset); [handleControlMessage / captureAutomatically / persistCandidate](../../../src/services/memory/longTermMemoryService.ts), [run / stop / активные операции](../../../src/services/ai/directSubagentService.ts) | S2, S3 | Extraction приостановлен, выполнена очистка, ответ AI продолжен; старый факт не появляется в запрещённом scope. Пересказ до/после чтения страницы, очистка в другом peer, рестарт и два процесса по согласованной гарантии. |

## Проверки и имеющиеся свидетельства

Существующий integration test подменяет память и не проверяет гонку очистки с extraction/snapshot; восстановление данных пока только сценарий риска.
Существующие относящиеся файлы: [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts).
При исполнении использовать существующие проверки `npm run check` и при необходимости `npm run build` внутри изолированного Node.js 22 согласно [operations](../../project/operations.md). Проверки специфичных сценариев из таблицы выполнить с подменёнными внешними вызовами/синтетическими данными; БД-гонки проверять на отдельной временной SQLite, а не на рабочем файле.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Устойчивая ревизия может потребовать служебных полей owner/scope и совместимого начального значения; миграция не выбрана. Новое удаление аккаунта, массовая перепись старой истории и удаление чужих цитат не разрешены.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [commands.md#command-reset](../../project/src/services/command/commands.md#command-reset), [commands.md#command-forget](../../project/src/services/command/commands.md#command-forget), [longTermMemoryService.md#автоматическое-сохранение](../../project/src/services/memory/longTermMemoryService.md#автоматическое-сохранение), [longTermMemoryService.md#явное-управление](../../project/src/services/memory/longTermMemoryService.md#явное-управление), [directSubagentService.md#обработка](../../project/src/services/ai/directSubagentService.md#обработка); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
