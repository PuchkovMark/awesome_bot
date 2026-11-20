# План Q03: Уточнить время периода и предел доступа к сохраняемой истории

**Основание:** [task.md](task.md), [находка Q03](../../../project-issues/specification-audit.md#q03-p2--период-истории-и-срок-её-доступности-имеют-разные-основания), [реестр задач](../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
Зависимые шаги условны до явного ответа на решения D*. План нельзя передавать исполнителю как согласованный.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

MemoryService/get_local_chat_history фильтруют createdAt и включают before; прямой snapshot использует sentAt с fallback и [from,to). Cleanup может хранить weekly строки семь дней, тогда как обычный prompt и прямой пересказ ограничены сутками.

| Материал | Владелец / назначение |
| --- | --- |
| [memoryService.ts](../../../src/services/memory/memoryService.ts) | getHistoryPage / getContextForUser / getRecentChatContext / cleanupOldContext |
| [historySnapshot.ts](../../../src/services/ai/historySnapshot.ts) | createHistorySnapshot |
| [localChatHistoryTool.ts](../../../src/services/ai/tools/localChatHistoryTool.ts) | before / next_before / defaultBefore |
| [commandService.ts](../../../src/services/command/commandService.ts) | summarizeConversation |
| [memeService.ts](../../../src/services/fun/memeService.ts) | createFromContext |

Канонические описания: [memoryService.md#сохранение-и-выборка-истории](../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории), [historySnapshot.md](../../project/src/services/ai/historySnapshot.md), [tools.md#get_local_chat_history](../../project/src/services/ai/tools.md#get_local_chat_history), [cleanupJob.md#действия-и-состояние](../../project/src/jobs/cleanupJob.md#действия-и-состояние).

## Принятые ограничения

Уже принятый прямой run_subagent ограничен последними 24 часами; не возвращать массовую перепись старой истории, старые общие лимиты или сохранение транскриптов. Weekly хранение для мемов остаётся отдельным назначением.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

| Решение | Что выбрать | Предложение и альтернатива | Зависимые шаги |
| --- | --- | --- | --- |
| Q03-D1 | Единый смысл времени сообщения. | Рекомендую sentAt ?? createdAt для пользовательского периода и пометку приблизительной даты; альтернатива — сохранить различия читателей и явно назвать период временем записи там, где используется createdAt. | S1–S2 |
| Q03-D2 | Доступ к weekly-данным вне мема. | Рекомендую оставлять расширенное хранение назначением weekly-мема, а прочих читателей ограничивать своим явным TTL; альтернатива — разрешить pager читать всю сохранённую историю при явном контракте. Прямые сутки не расширять. | S1–S3 |
| Q03-D3 | Границы и совместимость before. | Рекомендую сохранить публичный inclusive before как курсор и явно отделить его от exclusive to прямого периода; унифицировать границы можно только с согласованием схемы/клиентов. При изменении порядка нужен согласованный устойчивый tie-break. | S2–S3 |

Для каждого решения сейчас статус «ожидает ответа». Обсуждать по одному; выбранная в интерфейсе рекомендация, молчание или общий запрос на план не являются согласием.

## Предложенная последовательность

**S0.** Перед зависимыми изменениями разрешить перечисленные D*, если они есть, и сверить текущий baseline с источниками.

**S1.** После D1–D3 составить таблицу всех текущих читателей Message, включив summary и memeday, а не только tools.
Владелец: [getHistoryPage / getContextForUser / getRecentChatContext / cleanupOldContext](../../../src/services/memory/memoryService.ts). Критерии: AC-1.

**S2.** Реализовать выбранный источник времени и совместимый порядок/курсор в затронутых readers, не перечитывая весь объём в модель ради сортировки.
Владелец: [createHistorySnapshot](../../../src/services/ai/historySnapshot.ts). Критерии: AC-2, AC-3.

**S3.** Применить выбранный access-age при чтении, отделив его от физического cleanup; описать взаимодействие weekly on/off.
Владелец: [getHistoryPage / getContextForUser / getRecentChatContext / cleanupOldContext](../../../src/services/memory/memoryService.ts). Критерии: AC-3, AC-4.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [memoryService.md#сохранение-и-выборка-истории](../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории); [getHistoryPage / getContextForUser / getRecentChatContext / cleanupOldContext](../../../src/services/memory/memoryService.ts) | S1 | Для задержанной записи, TTL и каждой границы есть заранее определённый состав. |
| AC-2 | [memoryService.md#сохранение-и-выборка-истории](../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории); [createHistorySnapshot](../../../src/services/ai/historySnapshot.ts) | S2 | Одинаковые timestamps на страницах, пропущенный sentAt и исключённые ID. |
| AC-3 | [memoryService.md#сохранение-и-выборка-истории](../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории); [createHistorySnapshot](../../../src/services/ai/historySnapshot.ts), [getHistoryPage / getContextForUser / getRecentChatContext / cleanupOldContext](../../../src/services/memory/memoryService.ts) | S2, S3 | Одинаковые timestamps на страницах, пропущенный sentAt и исключённые ID. До/после TTL без cron, weekly on/off, прямой пересказ старше суток остаётся запрещён. |
| AC-4 | [memoryService.md#сохранение-и-выборка-истории](../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории); [getHistoryPage / getContextForUser / getRecentChatContext / cleanupOldContext](../../../src/services/memory/memoryService.ts) | S3 | До/после TTL без cron, weekly on/off, прямой пересказ старше суток остаётся запрещён. |

## Проверки и имеющиеся свидетельства

Существующий pager-тест проверяет createdAt anchor и неповторение в mocked store, не текущие Prisma-фильтры/TTL.
Существующие относящиеся файлы: [localChatHistoryTool.test.ts](../../../test/localChatHistoryTool.test.ts), [chatDigestService.test.ts](../../../test/chatDigestService.test.ts).
При исполнении использовать существующие проверки `npm run check` и при необходимости `npm run build` внутри изолированного Node.js 22 согласно [operations](../../project/operations.md). Проверки специфичных сценариев из таблицы выполнить с подменёнными внешними вызовами/синтетическими данными; БД-гонки проверять на отдельной временной SQLite, а не на рабочем файле.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Документирование текущих различий не требует миграции. Если выбор единого индексируемого времени потребует поля или backfill, согласовать это отдельно; массовую очистку существующих строк не выполнять.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [memoryService.md#сохранение-и-выборка-истории](../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории), [historySnapshot.md](../../project/src/services/ai/historySnapshot.md), [tools.md#get_local_chat_history](../../project/src/services/ai/tools.md#get_local_chat_history), [cleanupJob.md#действия-и-состояние](../../project/src/jobs/cleanupJob.md#действия-и-состояние); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
