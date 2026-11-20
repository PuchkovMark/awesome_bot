# План A05: Разделить текущий прямой пересказ и старый фоновый путь в документации

**Основание:** [task.md](task.md), [находка A05](../../../project-issues/specification-audit.md#a05-p2--текущий-и-прежний-пути-субагента-конкурируют-за-описание-основного-сценария), [реестр задач](../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
План не вводит новый контракт исполнения. Авторизация на реализацию/изменение общей документации отдельно этим предложением не подразумевается.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

Текущий VK создаёт createSubagentTool с runDirect; SubagentService.md продолжает называть основным фоновый запуск через estimate/startJob. get_subagent_status читает только сохранённые DigestJob.

| Материал | Владелец / назначение |
| --- | --- |
| [vkService.ts](../../../src/services/vk/vkService.ts) | создание createSubagentTool с runDirect |
| [subagentTool.ts](../../../src/services/ai/tools/subagentTool.ts) | createSubagentTool |
| [subagentService.ts](../../../src/services/ai/subagentService.ts) | SubagentService / getLatestStatus |
| [subagentService.md](../../project/src/services/ai/subagentService.md) | входы и регистрация |
| [tools.md](../../project/src/services/ai/tools.md) | run_subagent / get_subagent_status |
| [README.md](../../project/src/services/ai/README.md) | большая история и субагенты |

Канонические описания: [subagentService.md#входы-и-регистрация](../../project/src/services/ai/subagentService.md#входы-и-регистрация), [tools.md#run_subagent](../../project/src/services/ai/tools.md#run_subagent), [tools.md#get_subagent_status](../../project/src/services/ai/tools.md#get_subagent_status), [directSubagentService.md](../../project/src/services/ai/directSubagentService.md).

## Принятые ограничения

Прямой результат основной модели, отсутствие новых DigestJob и дневного лимита, прекращение по общему timeout, сохранение старых записей и jobs. Не менять прежние планы/историю ревью.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

Существенных новых выборов поведения нет. Если проверка перед исполнением обнаружит расхождение с зафиксированным фактом, остановить зависимую правку и согласовать изменение области.

## Предложенная последовательность

**S0.** Перед зависимыми изменениями разрешить перечисленные D*, если они есть, и сверить текущий baseline с источниками.

**S1.** Статически проследить текущий caller, прямой сервис и выборку getLatestStatus; составить список конкурирующих утверждений.
Владелец: [создание createSubagentTool с runDirect](../../../src/services/vk/vkService.ts). Критерии: AC-1, AC-2.

**S2.** Исправить позиционирование старого сервиса, status и ссылки в общей спецификации, сохранив его реальный контракт для совместимости.
Владелец: [входы и регистрация](../../project/src/services/ai/subagentService.md). Критерии: AC-1, AC-2, AC-3.

**S3.** Сверить новые формулировки с поздними решениями прежней задачи и провести проверку ссылок.
Владелец: [run_subagent / get_subagent_status](../../project/src/services/ai/tools.md). Критерии: AC-3, AC-4.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [subagentService.md#входы-и-регистрация](../../project/src/services/ai/subagentService.md#входы-и-регистрация); [создание createSubagentTool с runDirect](../../../src/services/vk/vkService.ts), [входы и регистрация](../../project/src/services/ai/subagentService.md) | S1, S2 | Для одного текущего tool call нет startJob/создания новой DigestJob. Термины «текущий» и «старый» одинаковы во всех затронутых документах. |
| AC-2 | [subagentService.md#входы-и-регистрация](../../project/src/services/ai/subagentService.md#входы-и-регистрация); [создание createSubagentTool с runDirect](../../../src/services/vk/vkService.ts), [входы и регистрация](../../project/src/services/ai/subagentService.md) | S1, S2 | Для одного текущего tool call нет startJob/создания новой DigestJob. Термины «текущий» и «старый» одинаковы во всех затронутых документах. |
| AC-3 | [subagentService.md#входы-и-регистрация](../../project/src/services/ai/subagentService.md#входы-и-регистрация); [входы и регистрация](../../project/src/services/ai/subagentService.md), [run_subagent / get_subagent_status](../../project/src/services/ai/tools.md) | S2, S3 | Термины «текущий» и «старый» одинаковы во всех затронутых документах. Diff затрагивает только общую документацию; прежние планы и review сохранены. |
| AC-4 | [subagentService.md#входы-и-регистрация](../../project/src/services/ai/subagentService.md#входы-и-регистрация); [run_subagent / get_subagent_status](../../project/src/services/ai/tools.md) | S3 | Diff затрагивает только общую документацию; прежние планы и review сохранены. |

## Проверки и имеющиеся свидетельства

Эти существующие тесты используют старый startJob/getStatus и не доказывают прямое исполнение; для документации достаточно статической сверки.
Существующие относящиеся файлы: [subagentTool.test.ts](../../../test/subagentTool.test.ts), [subagentStatusTool.test.ts](../../../test/subagentStatusTool.test.ts).
Для этой документационной задачи достаточно статической сверки кода, примеров, ссылок и diff; запуск приложения и Node.js-проверок не требуется.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Не требуется. Новый runtime-статус прямой операции, изменение tool schema и удаление старых jobs не входят в задачу.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [subagentService.md#входы-и-регистрация](../../project/src/services/ai/subagentService.md#входы-и-регистрация), [tools.md#run_subagent](../../project/src/services/ai/tools.md#run_subagent), [tools.md#get_subagent_status](../../project/src/services/ai/tools.md#get_subagent_status), [directSubagentService.md](../../project/src/services/ai/directSubagentService.md); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
