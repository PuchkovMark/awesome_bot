# Реестр покрытия спецификаций

## Инкрементальная сверка R08 — 20.11.2026

Область — текущие изменения доставки/восстановления игровых результатов в рабочем дереве поверх `b59077ba50077c2243e6f87491dbf70b03bd18f6`, сопоставленные с [заданием](../tasks/completed/2026-11-19-audit-r08-game-result-delivery/task.md), двумя планами и [ревью](../tasks/completed/2026-11-19-audit-r08-game-result-delivery/review.md). Прочие dirty/untracked изменения не приписываются R08. Статически прослежены оба cron-wrapper, readers и публичные writers трёх семейств, sendAdventureResult и его command/tool/job callers, scopes и ограничения доступа.

Синхронизированы [gameTimeoutJob](src/jobs/gameTimeoutJob.md#доставка-и-ошибки), [adventureVoteJob](src/jobs/adventureVoteJob.md#публикация-и-сбои), [GameService](src/services/games/gameService.md), [AdventureService](src/services/games/adventureService.md), [MafiaService](src/services/games/mafiaService.md), [VkService](src/services/vk/vkService.md#доставка-результата-приключения), [команды](src/services/command/commands.md#command-games), [GameSession](prisma/models.md#gamesession), индексы игр/jobs, пользовательская справка и [карта проверок](test/README.md#инкрементальная-сверка-r08--20112026). В области R08 изменены пять исходных модулей, но новых модулей, команд, публичных tools, Prisma-моделей и миграций нет: общий инвентарь не увеличивается. Необязательное поле JSON не является новым столбцом Prisma. Tool на finished не расширен.

Первичная синхронизация выполнялась статически. После поручения закрыть проверки выполнен отдельный итоговый проход I4: исправлена подмена Prisma/ожидание slash-команды существующего integration test; полный check — 165/165, build — успешно, временный стенд — 10/10 групп, включая 36 комбинаций обычных timeout-переходов и restart/read трёх семейств. Детали и ограничения — в карте тестов и заключительном разделе ревью. Использованы отдельная копия, Node.js 22.23.5, синтетическая SQLite и подменённые внешние API; live VK/AI и бот не запускались, npm ci не повторялся. Историческое полное обследование ниже не переаттестовано; production-код и содержание планов не менялись. По результатам I4 R08 переносится в completed с корректировкой ссылок.

## Инкрементальная сверка A01 — 20.11.2026

Область — текущие `chatInfoTool.ts` и относящиеся к get_chat_info guards
`vkService.ts` в рабочем дереве поверх `b59077ba50077c2243e6f87491dbf70b03bd18f6`;
остальные dirty/untracked изменения не приписываются A01. Сверены
[задание](../tasks/completed/2026-11-19-audit-a01-vk-info-permissions/task.md), принятые
решения и [ревью](../tasks/completed/2026-11-19-audit-a01-vk-info-permissions/review.md)
с фактическим кодом, callers и assertions.

Обновлены [get_chat_info](src/services/ai/tools.md#get_chat_info),
[VkService](src/services/vk/vkService.md#ai-инструменты-действия-и-доставка),
[карта тестов](test/README.md#инкрементальная-сверка-a01--20112026)
и пользовательская справка. Зафиксированы две внутренние категории доступа,
шесть вызовов callback, монотонное административное требование и повторная
проверка роли при выдаче. Отдельная категория не является новым tool:
число публичных tools, команд, модулей и моделей этим изменением не увеличилось.
Регистрация get_chat_info в обычном/active наборе и отсутствие в
questionnaireOnly/субагенте сохранены; новые схемы, настройки и миграции
не появились. Контракт vkUserInfo и родительские индексы проверены:
их структура и ответственность helper не меняются, новых сущностей нет.

Результаты 67/67 фокусных проверок, lint/format/build и отдельный сбой
integration на mock prisma.apiUsage.create относятся к ревью и описаны
в карте тестов. При этой актуализации выполняется статическая сверка
документов/ссылок, без повторного запуска тестов или бота. Историческая
полная инвентаризация ниже не переаттестована.

## Инкрементальная сверка R07 — 20.11.2026

Основание — текущая реализация в рабочем дереве поверх `b59077ba50077c2243e6f87491dbf70b03bd18f6`, сопоставленная с [задачей R07](../tasks/completed/2026-11-19-audit-r07-membership-sync-recovery/task.md) и [ревью](../tasks/completed/2026-11-19-audit-r07-membership-sync-recovery/review.md), а не все изменения относительно HEAD. Проверены `MembershipService`, membership-event ветка и `setApi` в VkService, команда `/membership`, action `membership` в `get_chat_info`, сохранение соседних readers/writers `ConversationMember`, legacy-поле `membershipLastSyncDay` и assertions трёх тестовых файлов. Удалённые private helpers и `syncIfStale` не считаются отдельными документируемыми сущностями; действующая секция «Синхронизация состава» сохранена как совместимый якорь с описанием удаления. Схема, число моделей, модулей, команд и публичных tools этим изменением не увеличились.

Обновлены сервисный контракт, VK events, command/tool каталоги, модельные матрицы, индексы, пользовательская справка и [карта тестов](test/README.md#инкрементальная-сверка-r07--20112026). Прямой пересчёт `$transaction` даёт 18 мест в пяти сервисах вместо 19 в шести до удаления snapshot writer. Предыдущие результаты 17/17, typecheck, lint и format приведены в ревью; в ходе актуализации выполнялись только статические проверки документации, без запуска тестов, бота, VK и operational DB. Историческая полная проверка ниже не переаттестована; посторонние изменения не входят в R07.

**Исторический полный снимок на 2026-11-16:** source-level обследование завершено по тогдашнему рабочему дереву (Git `2dbb190` плюс незакоммиченные изменения). Для каждой найденной сущности указан канонический документ или раздел; нерешённых пробелов документации в реестре нет. Реестр описывает фактическую реализацию и её ограничения, не оценивает желательность поведения.

| Область | Инвентарь и подтверждённое покрытие | Канонические документы |
| --- | --- | --- |
| Сервисные модули | Инкрементально пересчитано: 82 TypeScript-модуля `src/services/**/*.ts`: 64 вне `src/services/ai/tools/` имеют индивидуальные спецификации; 16 модулей с фабриками покрыты единым каталогом из 21 публичной секции; два общих helper-модуля (`dateTime.ts`, `vkUserInfo.ts`) имеют отдельные source-mirrored спецификации. Проверены индексы и ссылки на исходные символы. | [Индекс сервисов](src/services/README.md), соответствующие `README.md` подсистем и файлы entity; [инструменты](src/services/ai/tools.md), [общие helpers](src/services/ai/tools/README.md) |
| Инфраструктура `src/` | Bootstrap, config, Prisma client, DI container, logger, scheduler и 7 jobs имеют source-mirrored спецификации; ambient-декларация `node-cron` имеет отдельный compile-time контракт. Индексы каталогов ведут ко всем документам. `src/db/index.ts` является только переэкспортом клиента и описан в индексе БД, но не выделен как самостоятельная поведенческая сущность. | [Индекс `src`](src/README.md), [БД](src/db/README.md), [DI](src/di/README.md), [logger](src/logger/README.md), [jobs](src/jobs/README.md), [типы](src/types/README.md), [config](src/config/README.md) |
| VK-команды и callback | 56/56 ключей `commandAliases`, 43 case labels `CommandService`, 11 коротких adventure routes, внутренние `profile-delete`/`profile-delete-confirm`, отдельная raw-команда `/reaction`, прямые media/voice/fun routes и все 6 `message_event` payload значений имеют канонические секции. Синтаксис, алиасы, guards, ветви ошибок, side effects и precedence маршрутизации сведены в каталог и связанные service specs. | [Каталог команд](src/services/command/commands.md), [CommandService](src/services/command/commandService.md), [VkService](src/services/vk/vkService.md), [архитектура](src/architecture.md) |
| Model tools и provider call sites | 21 точное имя имеет секцию; 20 подключаются хотя бы в одном контексте, `get_vk_info` описан как фабрика без provider caller. Все 5 `provider.send` tool arrays сверены по основному, questionnaire-only, active-decision, subagent и digest контекстам. Описаны schemas, guards, result delivery и side effects. | [Единый каталог инструментов](src/services/ai/tools.md), индивидуальные AI service specs |
| Данные и миграции | Все 35 Prisma-моделей имеют разделы с полями, типами, defaults, relations и индексами. Прямые readers/writers/deletes сопоставлены; query scopes, access checks, retention и тестовые свидетельства классифицированы. После удаления batch-синхронизации R07 пересчитано 18 `$transaction` call sites в пяти сервисах. Все 23 migration SQL-файла сопоставлены с затронутыми моделями; R07 миграций не добавляет. | [Модели](prisma/models.md), [миграции](prisma/migrations.md), [индекс Prisma](prisma/README.md) |
| История и память | Prompt history, TTL, participant resolution, history paging, reset/forget, long-term extraction/validation, personal/group isolation, ranking, embeddings, merge/related links, control messages, pending deletion selection и archive job прослежены до VK callers. Инкрементальная сверка R11 уточняет отсутствие дополнительного access guard у двух основных инструментов истории при сохранении границ данных и жизненного цикла старых заданий. | [Индекс памяти](src/services/memory/README.md), [MemoryService](src/services/memory/memoryService.md), [инструменты истории](src/services/ai/tools.md#get_local_chat_history), [прямой субагент](src/services/ai/tools.md#run_subagent), [LongTermMemoryService](src/services/memory/longTermMemoryService.md), [memory safety](src/services/memory/memorySafety.md), [embedding provider](src/services/memory/memoryEmbeddings.md) |
| Участники и membership | Заполнение пошаговой и шаблонной анкеты, парсинг вопросов/ошибки, редактирование/удаление профиля, права команд, questionnaire-only routing, VK join/leave и event dedup описаны. Инкрементально по R07: полная daily-синхронизация и DB fallback удалены; count только из VK либо `null/unavailable`. Локальные профили/event-driven presence остаются. Сверены два production callers статистики и membership-event route; 17 существующих тестов не воспроизводят новый error path. | [MemberService](src/services/member/memberService.md), [membership](src/services/membership/README.md), [статистика](src/services/membership/membershipService.md#статистика), [команда](src/services/command/commands.md#command-membership), [tool](src/services/ai/tools.md#get_chat_info) |
| Доменные функции | Все 8 игровых TS-модулей, приключения, мафия, команды/callbacks; напоминания и parser/date-time; медиа и вложения; voice; юмор, meme generation, weekly meme и voting описаны по runtime сценариям, состояниям, permissions, ошибкам и зависимостям. | [Игры](src/services/games/README.md), [напоминания](src/services/reminders/README.md), [медиа](src/services/media.md), [fun](src/services/fun/README.md), соответствующие [jobs](src/jobs/README.md) |
| Жизненный цикл и расписания | 7 cron jobs плюс `scheduler.ts`: регистрация, выражение и timezone, выборка, переходы, local/DB locks, ошибки, restart и delivery прослежены до вызываемых сервисов. | [Bootstrap](src/bootstrap.md), [каталог jobs](src/jobs/README.md), [operations](operations.md) |
| Конфигурация и развёртывание | 60 ключей `AppConfig` сверены с типами/defaults/consumers и `.env.example`; дополнительно описаны `DATABASE_URL`, Node/container commands, Prisma generation/migrations и lifecycle. Секретные значения не читались. | [Конфигурация](src/config/index.md), [operations](operations.md) |
| Тестовые свидетельства | Все 23 имеющихся `test/*.test.ts` сопоставлены с подтверждаемыми контрактами и границами assertions. Отсутствие прямого теста отражено для соответствующей сущности; оно не обозначается как незакрытая документационная работа. | [Карта тестов](test/README.md) |

## Инкрементальная сверка задачи истории

16.11.2026 сверены изменения рабочего дерева относительно `b59077ba50077c2243e6f87491dbf70b03bd18f6`, включая новые неотслеживаемые модули: [DirectSubagentService](src/services/ai/directSubagentService.md), [historySnapshot](src/services/ai/historySnapshot.md), [historyTranscript](src/services/ai/historyTranscript.md), [historyText](src/services/memory/historyText.md), а также связанные инструменты, хранение, VK, конфигурация и shutdown. Исторический полный снимок выше не переобследовался целиком. Новые модули включены в текущий счёт сервисов; прежний инвентарь остальных областей сохранён как исторический. Прямой вызов provider не передаёт tools; прежняя матрица доступности дополнена в [каталоге](src/services/ai/tools.md).

## Инкрементальная сверка очереди команд

17.11.2026 по текущему рабочему дереву проверены `VkService` и `RequestQueue`: slash-префикс запускает общий обработчик вне очереди, другие сообщения и авто-реакции используют очередь. Обновлены [VkService](src/services/vk/vkService.md), [очередь](src/services/queue/requestQueue.md), [архитектура](src/architecture.md), [команда режима](src/services/command/commands.md#command-mode) и [карта тестов](test/README.md). Полный исторический снимок при этом не переобследовался.

## Инкрементальная сверка голосового в ответе

17.11.2026 проверены рабочее дерево, [`listen_reply_voice`](src/services/ai/tools.md#listen_reply_voice), его регистрация в VkService и VoiceService. Счёт модулей и публичных инструментов уточнён для текущего дерева; исторический полный снимок не переобследовался. Отсутствие постоянного теста и пределы временных проверок указаны в каталоге и [карте тестов](test/README.md).

## Инкрементальная сверка R11

20.11.2026 текущая реализация повторно сопоставлена с существующими спецификациями и [повторным ревью R11](../tasks/completed/2026-11-19-audit-r11-history-access-before-resolver/review.md#повторное-ревью--20112026). База синхронизации — рабочее дерево с прежними незакоммиченными изменениями; проверены обе фабрики истории, их два production callers в VkService, resolver, SQL scope, прямой и прежний пути субагента, а также два unit-набора. Хеши пяти файлов R11 совпали с зафиксированными в ревью. Остальные изменения относительно HEAD не включены в эту сверку.

В [каталоге инструментов](src/services/ai/tools.md#get_local_chat_history), [run_subagent](src/services/ai/tools.md#run_subagent), [VkService](src/services/vk/vkService.md#ai-инструменты-действия-и-доставка), [DirectSubagentService](src/services/ai/directSubagentService.md) и [MemoryService](src/services/memory/memoryService.md#сохранение-и-выборка-истории) отражено удаление дополнительного history access guard без переноса в resolver/store/snapshot. Сохранены фильтры текущей беседы/пользователя, валидация, лимиты, `beginAction` прежнего запуска и `isActive` старых snapshot tools. Отдельно подтверждены пять оставшихся привязок `checkReadToolAccess`: время, погода, локация, статус субагента и reply-голос. Уточнено общее описание прав в [пользовательском README](../../README.md).

В [карте тестов](test/README.md#инкрементальная-сверка-r11) актуализированы два набора: 12 + 12 существующих кейсов; access-сценарии и fixtures удалены внутри смешанных тестов. R11 не добавляет и не удаляет модули, публичные имена инструментов или тестовые файлы. Общие исторические счётчики других областей не пересчитывались, дата и границы полного снимка 2026-11-16 сохранены.

В этой синхронизации выполнена статическая сверка кода, описаний, относительных ссылок и якорей; тесты и приложение не запускались. Результаты предыдущих проверок реализации и ревью приведены в документе задачи; они не означают новое выполнение VK/SQL-сценария при актуализации.

## Инкрементальная сверка R09

20.11.2026 сопоставлены изменения атомарной квоты с текущим рабочим деревом;
посторонние изменения истории/прав не включены в R09. Добавлен один сервис
[ImageQuotaService](src/services/image/imageQuotaService.md), две модели в
[едином каталоге](prisma/models.md#imagedailyquota) и одна миграция
[image_daily_quota](prisma/migrations.md). Текущие счётчики: 82 сервисных модуля,
35 Prisma-моделей, 23 SQL-миграции; публичные имена tools и env не добавлены.

Актуализированы image/edit, generate_image, VkService, медиа, генератор, imageError,
Prisma, image indexes и [operations](operations.md#переключение-на-атомарную-квоту-изображений-r09).
Добавлены два тестовых набора и process fixture, обновлены image tool и VK integration;
контракты и ограничения отражены в [карте тестов](test/README.md).
Наличие тестового кода не доказывает выполнение AC; результаты сборки и проверок
сообщаются отдельно. Историческая дата полного обследования не изменена.

После [ревью R09](../tasks/completed/2026-11-19-audit-r09-image-quota-atomicity/review.md)
20.11.2026 выполнена повторная синхронизация по текущему рабочему дереву.
Хеши шести исходных файлов схемы/квоты/ошибок/генератора/tool/VkService совпали
со снимком ревью. Существующие контракты сохранены; исправлены сводки о количестве
транзакций (19 в шести сервисах), миграций (23), наличии реальных SQLite-тестов
и владельце IMAGE_MAX_PER_USER_PER_DAY. Уточнены нижняя граница release и описание
проверки slash-команды при занятой очереди в карте тестов.
В [пользовательском README](../../README.md) описаны общий UTC-лимит,
расход при неизвестном исходе/ошибке доставки и сохранение квоты при рестарте.
Добавлена связь с ревью и явно сохранено ограничение: тесты R09, общий check,
fresh/upgrade и фактический SQLite engine не проверялись. Это статическая
актуализация документации, не повторное полное обследование или runtime-приёмка.

## Инкрементальная сверка A05

20.11.2026 исправлено [замечание A05-R1](../tasks/2026-11-19-audit-a05-subagent-current-contract/review.md#подтверждённое-замечание-к-документации): в [SubagentService](src/services/ai/subagentService.md#входы-и-регистрация) явно отделён сохраняемый фоновый API от текущего [DirectSubagentService](src/services/ai/directSubagentService.md). По текущему рабочему дереву сверены VK caller с `runDirect`, ранний возврат фабрики до предоценки/startJob и выборка сохранённой `DigestJob` в getLatestStatus. Хеши этих исходников совпали со срезом ревью A05; посторонние изменения рабочего дерева в область синхронизации не включены.

В [каталоге get_subagent_status](src/services/ai/tools.md#get_subagent_status) уточнено, что результат может относиться к старой задаче беседы и не показывает прямую операцию. Подробный контракт прежнего сервиса, сохранённые jobs, лимиты, доставка и очистка сохранены. Существующие [индекс AI](src/services/ai/README.md#большая-история-и-субагенты) и [run_subagent](src/services/ai/tools.md#run_subagent) уже описывают прямой путь и сверены без переписывания.

Код, схема, конфигурация, тесты, планы и история ревью не менялись. Новых сущностей и публичных tools нет; счётчики полного снимка не пересчитывались. [Карта тестов](test/README.md) по-прежнему различает подменённые проверки старого startJob и status; её mapping не меняется. Проверки статические: относительные ссылки/якоря, согласованность контрактов и diff. Бот, тесты, VK/provider и рабочая БД не запускались; историческая дата полного обследования сохранена.

## Границы этого снимка

Источники и спецификации сверены статически. Тесты и бот не запускались; пользовательские тесты не добавлялись. Operational SQLite database, live secrets и внешние VK/OpenAI-провайдеры не читались и не вызывались. Поэтому реальное состояние конкретной БД, доступность внешних API и успешность runtime-сценариев этим реестром не подтверждаются; это границы исполнения и доступа, а не оставшиеся пробелы в описании исходников.

Материальные ограничения и расхождения реализации зафиксированы рядом с соответствующими контрактами, а не оставлены как задачи обследования. При изменении исходников реестр следует обновлять вместе с entity specs через [awesome-bot-spec-update](../../.agents/skills/awesome-bot-spec-update/SKILL.md).
