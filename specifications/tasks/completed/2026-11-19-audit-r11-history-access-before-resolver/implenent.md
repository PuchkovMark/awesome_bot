# Подробный план реализации R11: убрать дополнительную проверку доступа к истории

**Дата:** 20.11.2026. **Статус:** готов к будущей реализации; обязательные решения согласованы. Текущий запрос разрешает только документы: код и тесты пока не менять.

**Требования:** актуальная редакция [task.md](task.md). **Действующий план:** [plan-2026-11-20.md](plan-2026-11-20.md). [Первоначальный plan.md](plan.md) сохранён как историческое предложение усилить проверку; исполнять его вместо действующего плана нельзя.

## Проверенный исходный контекст

Основание — текущее рабочее дерево от 20.11.2026, HEAD b59077b. В дереве уже есть несвязанные незакоммиченные изменения, в том числе в VkService, subagentTool, MemoryService и прямом субагенте; новые модули прямого чтения истории ещё не отслеживаются Git. Не откатывать их и не заменять файлы версиями из HEAD.

Статически проверены две фабрики, их VK-подключения, все найденные callers в src/test, два unit-набора, окружающий VK integration test, источники снимка и канонические разделы. Бот, тесты, VK/AI и рабочая БД не запускались.

Точки вызова подтверждены кодом:

| Фабрика/слой | Текущее место | Планируемая правка |
| --- | --- | --- |
| createLocalChatHistoryTool | [LocalHistoryToolContext / execute](../../../../src/services/ai/tools/localChatHistoryTool.ts) | Удалить поле checkAccess и блок вызова перед чтением страницы. |
| createSubagentTool | [SubagentToolContext / execute](../../../../src/services/ai/tools/subagentTool.ts) | Удалить поле checkAccess и блок перед resolver, общий для прямого и прежнего запуска. |
| VK caller обеих фабрик | [localHistoryTool / subagentTool](../../../../src/services/vk/vkService.ts) | Удалить две привязки проверки: одну ссылку на helper и один отдельный callback. |
| Unit callers | [makeTool обычной истории](../../../../test/localChatHistoryTool.test.ts), [makeTool субагента](../../../../test/subagentTool.test.ts) | Удалить access fixtures и связанные сценарии отказа. |

## Согласованные решения и границы

- **R11-N1:** полностью удалить дополнительную проверку доступа во всех местах таблицы действующего плана, где она есть. Не оставлять optional checkAccess, фиктивный разрешающий callback или перенесённый guard.
- **R11-N2:** удалить все тестовые сценарии и вспомогательные конструкции самой проверки доступа; новых тестов вместо них не создавать. В смешанных кейсах самостоятельные проверки аргументов сохраняются.
- **Текущий этап:** только актуализация задачи/плана и составление этого документа. Указание «код пока не меняй» остаётся действующим.
- **Область реализации:** три исходных файла и два тестовых файла из таблицы. Схемы БД, зависимости, конфигурация, новые команды и tools не меняются.
- **Сохраняемые условия:** текущие peerId/senderId, фильтры участников и ЛС, даты, лимиты, пагинация, статусы остальных результатов и ошибок.
- **Самостоятельные guards:** checkToolAccess/checkReadToolAccess у других инструментов, входные условия маршрута, доставка сообщений, beginAction прежнего фонового запуска и isActive() старого snapshot-контекста сохраняются.

Обязательных открытых решений по этому объёму нет. Локальные правки типов и fixtures ниже следуют из удаления согласованной зависимости.

## Шаги реализации

### I0. Зафиксировать исходное дерево

**Зависимость:** отдельный последующий запрос пользователя на реализацию.

Перед редактированием проверить git status и diff пяти целевых файлов, прочитать эти документы и сверить владельцев логики. Сохранить прежние изменения. Если появились новые callers или изменился контракт, сопоставить их с R11-N1/R11-N2 до зависимых правок.

На текущем этапе I0–I6 не выполняются; ниже описана будущая работа.

### I1. Удалить guard основной истории

**Файл:** [localChatHistoryTool.ts](../../../../src/services/ai/tools/localChatHistoryTool.ts). **Зависимость:** I0.

1. Из LocalHistoryToolContext удалить обязательное поле checkAccess с Promise union результата.
2. В createLocalChatHistoryTool.execute удалить целиком блок const access = await context.checkAccess() и следующий if (!access.allowed), возвращающий not_executed.
3. Соединить существующие проверки бюджетов с вычислением effectiveLimit и чтением getMessages. Не менять момент увеличения calls, расход бюджетов и excludeIds.
4. Не переносить guard перед resolveParticipants/participantError или после чтения.

**Результат:** инструмент не зависит от роли, режима, maintenance, active decision и состояния отправки через удалённый callback. Валидация входа, ошибки getMessages, participants, страницы и формат результата остаются прежними.

### I2. Удалить guard запуска субагента

**Файл:** [subagentTool.ts](../../../../src/services/ai/tools/subagentTool.ts). **Зависимость:** I0.

1. Из SubagentToolContext удалить checkAccess.
2. В execute удалить блок const access = await context.checkAccess() с возвратом отказа. Он находится после проверки participants и до let resolvedParticipants.
3. Сохранить resolver и обработку ambiguous/notFound, затем существующее разветвление runDirect / estimateMessages → startJob.
4. Сохранить все проверки периода, количества, формата, лимита вывода и бюджета. Не переписывать прямую или прежнюю ветвь ради удаления guard.

**Результат:** дополнительной проверки нет перед обеими существующими ветвями. Отдельный beginAction VK callback старого startJob остаётся проверкой запуска действия с доставкой, а не новой проверкой чтения.

### I3. Удалить callbacks в VK caller

**Файл:** [vkService.ts](../../../../src/services/vk/vkService.ts). **Зависимость:** I1–I2, в той же логической правке.

1. В объекте для createLocalChatHistoryTool удалить только checkAccess: checkReadToolAccess. Сохранить scope, contextMessageCount, defaultBefore, seenMessageIds, resolver и getHistoryPage callback.
2. В объекте для createSubagentTool удалить весь checkAccess: async () => { ... }, расположенный между runDirect и resolveParticipants: проверки hasAttempted, activeResponseDecision и вызов checkToolAccess.
3. Сохранить общий helper checkReadToolAccess и его подключения к currentDateTimeTool, weatherTool, locationTool, subagentStatusTool и replyVoiceTool.
4. Сохранить runDirect → DirectSubagentService, startJob → SubagentService, beginAction, acknowledge/onStarted, правила внешней доставки и provider tool arrays.
5. Не менять альтернативные строки таблицы, где удаляемой проверки нет: [MemoryService](../../../../src/services/memory/memoryService.ts), [historySnapshot](../../../../src/services/ai/historySnapshot.ts), [DirectSubagentService](../../../../src/services/ai/directSubagentService.ts), [CommandService / summary](../../../../src/services/command/commandService.ts), [старые snapshot tools](../../../../src/services/ai/tools/subagentTools.ts).

**Границы данных:** оставить String(peerId) во всех выборках; у личного getHistoryPage сохранить vkUserId: senderId. Не менять источники participantUserIds/includeBot и передачу текущего имени персонажа resolver.

**Поток выполнения:** основной provider по-прежнему получает оба инструмента в обычном/active наборе и не получает их в questionnaireOnly. Текущий runDirect возвращает результат основной модели без собственной отправки; прежний fallback сохраняет свой жизненный цикл. Субагент прямого пути по-прежнему не получает tools.

### I4. Удалить access-сценарий обычной истории

**Файл:** [localChatHistoryTool.test.ts](../../../../test/localChatHistoryTool.test.ts). **Зависимость:** I1 и I3.

1. Удалить type Access.
2. Из options helper makeTool удалить access?: Access.
3. Из контекста createLocalChatHistoryTool в makeTool удалить checkAccess, использующий options.access.
4. В кейсе get_local_chat_history validates input and access удалить целиком const denied = JSON.parse(...), включая вложенный makeTool с allowed: false, затем assertions denied.status и denied.message.
5. Переименовать сохраняемый кейс в get_local_chat_history validates input.
6. Сохранить проверки invalidBefore, invalidRange, invalidLimit, unknownKey и future, а также существующий assert requests.length === 0 для этого основного экземпляра.
7. Остальные кейсы файла оставить. Новые проверки доступа или тесты разрешённого вызова вместо удалённого сценария не добавлять.

### I5. Удалить access-сценарий субагента

**Файл:** [subagentTool.test.ts](../../../../test/subagentTool.test.ts). **Зависимость:** I2 и I3.

1. Удалить type Access, options.access и checkAccess из helper makeTool.
2. В кейсе run_subagent validates input, period, and access удалить const denied = JSON.parse(...), вложенный blocked tool с allowed: false и два assertions denied.status/denied.message.
3. Переименовать сохраняемый кейс в run_subagent validates input and period.
4. Сохранить invalidTask, both, invalidRange, future и requests.length === 0, а также все прочие кейсы запуска/лимитов/участников.
5. Удалить и дополнительные найденные сценарии именно этого guard, если они появились после обследования. Независимые тесты иных инструментов, доставки и isActive() к R11-N2 не относятся.

Удаление касается access-сценариев внутри смешанных кейсов и всей их инфраструктуры. Два тестовых файла целиком не удаляются: в них остаются независимые проверки.

### I6. Проверить результат и границы

**Зависимость:** I1–I5.

**Статический контроль.** В двух исходных инструментах не должно остаться checkAccess/checkReadToolAccess; в двух unit-наборах — Access, access option, options.access, checkAccess и denied-сценариев удалённого guard. Примеры команд из корня репозитория, где сейчас недоступен rg:

    grep -nE 'checkAccess|checkReadToolAccess' src/services/ai/tools/localChatHistoryTool.ts src/services/ai/tools/subagentTool.ts
    grep -nE 'type Access|access\?:|options\.access|checkAccess|const denied|Нет доступа' test/localChatHistoryTool.test.ts test/subagentTool.test.ts
    grep -R -nE 'create(LocalChatHistory|Subagent)Tool\(' src test

Для первых двух поисков ожидается отсутствие совпадений: exit code 1 у grep в этом случае означает ожидаемый результат. Третий поиск проверяет все callers после изменения типов.

В diff [VkService](../../../../src/services/vk/vkService.ts) отдельно проверить отсутствие двух history callbacks и сохранность пяти перечисленных подключений общего helper. Внутренние SQL-условия, другие строки таблицы и tool arrays сравнить с исходным деревом. Не требовать исчезновения checkReadToolAccess из всего VK файла: он нужен оставшимся инструментам.

**Окружение проверки.** Контейнерные команды использовать с базой docker, которую возвращает containerToolsConfig; образ Node.js 22 соответствует [Dockerfile](../../../../Dockerfile). Подготовить отдельную временную копию текущего рабочего дерева с нужными tracked/untracked файлами, исключив секретные .env, рабочие SQLite-файлы, логи, node_modules, dist и .git. Исходный рабочий каталог для проверки не подключать с записью. Внутри копии задать DATABASE_URL на временный файл и не передавать боевые токены.

**Точные команды внутри одноразового Node.js 22 контейнера:**

    npm ci
    npm run prisma:generate
    npm run check

Для Alpine окружению нужен OpenSSL, как в существующем Dockerfile. Установка зависимостей и генерация клиента выполняются только в временной копии; migrations и docker compose up не являются шагом проверки этой задачи.

npm run check уже включает lint, format:check, typecheck и полный существующий test suite. Тесты подменяют внешние сервисы; реальные VK/AI-запросы и запуск приложения не нужны. Не запускать дополнительные повторные проверки после успешного обязательного набора без новой причины.

Если конкретный сбой требует фокусной диагностики, внутри того же подготовленного контейнера использовать:

    node --import tsx --test test/localChatHistoryTool.test.ts test/subagentTool.test.ts test/subagentTools.test.ts test/vkMessageDeliveryIntegration.test.ts

[tsconfig.json](../../../../tsconfig.json) включает только src, поэтому одного typecheck недостаточно для проверки fixtures: lint использует отдельный [tsconfig.eslint.json](../../../../tsconfig.eslint.json), а suite запускает оставшиеся сценарии.

**Ожидаемый результат:** удалённый guard и связанные сценарии/fixtures отсутствуют; валидация, пагинация, лимиты, participants и прежняя ветвь субагента проходят оставшиеся проверки. Отсутствие runtime-проверки прямого SQL-пути в существующих unit-наборах отметить как ограничение; статическое удаление guard не считать воспроизведённым end-to-end поведением VK.

Если существующие проверки падают по несвязанной причине, отделить её от новой правки и сообщить фактическое ограничение. Не исправлять несвязанные функции или отключать проверки.

## Соответствие критериям

| Критерий | Шаги | Владелец / контракт | Свидетельство |
| --- | --- | --- | --- |
| AC-N1 | I1, I3, I6 | [get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history), [localChatHistoryTool.ts](../../../../src/services/ai/tools/localChatHistoryTool.ts) | Удалены поле, вызов и VK-привязка; статический поиск и оставшиеся проверки pager. |
| AC-N2 | I2, I3, I6 | [run_subagent](../../../project/src/services/ai/tools.md#run_subagent), [subagentTool.ts](../../../../src/services/ai/tools/subagentTool.ts) | Общий guard обеих ветвей и VK callback удалены; прямой путь проверен статически, прежняя ветвь — существующими сценариями. |
| AC-N3 | I1–I6 | [MemoryService](../../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории), [каталог истории](../../../project/src/services/ai/tools.md#get_local_chat_history) | Сохранены условия данных и входная валидация; оставшиеся unit-кейсы и npm run check. |
| AC-N4 | I0, I3, I6 | [VK guards](../../../project/src/services/vk/vkService.md#ai-инструменты-действия-и-доставка), таблица рабочего плана | Сопоставлена вся таблица; другие helper bindings, beginAction, isActive и маршруты сохранены. |
| AC-N5 | Только текущая подготовка документов | Прямое указание пользователя | Изменены документы; исходники, тесты, конфигурация и БД не меняются, runtime не запускается. |
| AC-N6 | I4–I6 | [unit pager](../../../../test/localChatHistoryTool.test.ts), [unit субагента](../../../../test/subagentTool.test.ts) | Удалены связанные access-сценарии/fixtures; независимые assertions сохранены, новых тестов взамен нет. |

## Документация, данные и завершение

Данные и Prisma schema не меняются; миграции, восстановление истории, настройки и развёртывание не нужны.

Для последующей отдельно порученной синхронизации затрагиваются [get_local_chat_history](../../../project/src/services/ai/tools.md#get_local_chat_history), [run_subagent](../../../project/src/services/ai/tools.md#run_subagent), [VkService](../../../project/src/services/vk/vkService.md#ai-инструменты-действия-и-доставка), [DirectSubagentService](../../../project/src/services/ai/directSubagentService.md), упоминание доступа в [MemoryService](../../../project/src/services/memory/memoryService.md#сохранение-и-выборка-истории), строки двух unit-наборов в [карте тестов](../../../project/test/README.md) и при необходимости [реестр покрытия](../../../project/coverage.md). Сейчас эти канонические документы не переписываются как будто изменение реализовано.

Будущая реализация считается проверенной после I1–I6 и сопоставления AC-N1–N4/AC-N6 с фактическими результатами. AC-N5 относится к нынешнему этапу планирования. Готовность этого документа не отменяет запрет менять код до нового поручения.

Исполнитель следует актуальному task.md, действующему plan-2026-11-20.md и этому implenent.md. При новом существенном выборе или расхождении с кодом сначала сообщает проблему и задаёт один вопрос, затем ждёт ответа до зависимых изменений. Во время реализации не создаёт и не меняет планы без отдельного указания пользователя, включая статусы, прогресс и результаты проверок. Прогресс и проверки сообщает в чате; историю документов и несвязанные правки сохраняет.
