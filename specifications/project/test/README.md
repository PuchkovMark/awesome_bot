# Карта проверенных тестовых сценариев

Карта перечисляет имеющиеся файлы `test/*.test.ts` и описывает проверяемые контракты с существенными границами. Основная инвентаризация выполнялась статически; фактически выполненные проверки отдельных задач и даты запусков приведены в инкрементальных разделах ниже. Наличие сценария само по себе не подтверждает, что он проходит или полностью покрывает подсистему.

## Инкрементальная сверка R08 — 20.11.2026

Сопоставлены исходники пяти изменённых модулей и существующий [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts) с [ревью R08](../../tasks/completed/2026-11-19-audit-r08-game-result-delivery/review.md). В сценарии game-first GameInteractionService.handle подменён сообщением «Состояние игры.»: утверждение одной отправки и блокировки следующего действия не проверяет настоящие игровые transitions/readers, lastPublicResult или cron-wrapper. Постоянные тесты R08 не добавлены; общая граница отсутствия прямых игровых/job тестов сохраняется.

Итоговый проход I4 20.11.2026: исправлены подмена Prisma apiUsage.create (Reflect.set/восстановление вместо несовместимого t.mock.method) и ожидание завершения slash-команды вне RequestQueue. Теперь тест ждёт раннюю текстовую доставку либо finally image-операции, сохраняя конкурентный command/tool сценарий с заблокированной генерацией. Фокусный integration — **1/1**, полный `npm run check` — **165/165**, включая lint/format/typecheck; `npm run build` — успешно. Проверки выполнены в копии проекта, Docker Node.js 22.23.5, без сети; зависимости взяты из image без нового npm ci. Бот, живые VK/AI и рабочая БД не запускались.

Новый временный стенд вне репозитория — **10/10 групп успешно**: реальные timeout-переходы 36 сочетаний обычных режимов (9 × autoAdvance on/off × промежуточный/последний раунд), who, difficulty vote, waiting/paused/legacy, командная ничья, active priority и scopes; текущая/финальная сцена приключения, участие и следующий самостоятельный deadline; десять timeout/раздача-переходов мафии, управление/leave/legacy; изоляция ошибок jobs и три send-ветки uncertain/recordImage. Тройные reads и чтение отдельным процессом той же синтетической SQLite не меняют сессии, очки, события и статистику. Точный перечень и промежуточные ошибки стенда сохранены в заключительном разделе ревью. Временный стенд не добавлен в test/; assertions существующего game-first по-прежнему не заменяют реальные игровые проверки. Предыдущие 9/9 и 2704 комбинации функции подсчёта относятся к прошлому ревью, а прежний результат 164/165 больше не описывает текущий снимок. Гонки R03 и атомарность A06 остаются вне R08; callbacks cron вызывались вручную, рестарт — отдельным процессом.

## Инкрементальная сверка A01 — 20.11.2026

Повторно сопоставлены неизменённые assertions
[chatInfoTool.test.ts](../../../test/chatInfoTool.test.ts) и
[vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts)
с реализацией [get_chat_info](../src/services/ai/tools.md#get_chat_info)
и [VkService](../src/services/vk/vkService.md#ai-инструменты-действия-и-доставка).
Восемь постоянных unit-тестов по-прежнему проверяют страницы/поля состава,
дни рождения, область ЛС, ранний отказ и условия membership. Их callback —
noop: категории, монотонное требование и позднюю проверку роли этот файл
не проверяет. Новые assertions в репозиторий не добавлялись.

[Ревью A01](../../tasks/completed/2026-11-19-audit-a01-vk-info-permissions/review.md)
фиксирует успешный прогон 67/67: 8 постоянных тестов, 57 сценариев временного
стенда и 2 родительские группы. Временный стенд исполнял настоящие tool
и middleware с подменёнными VK/provider/settings/sender: матрицу четырёх
ролей и областей, категории callback, внешние ID/reply группы и отказ в ЛС,
оба порядка mixed calls, отзыв роли, сбой поздней проверки, смену режимов,
запрет прямой доставки/действия после VK-данных, историю и uncertain send.
Это результаты отдельной изолированной проверки, не новый постоянный набор
и не проверка настоящего VK или ролей в рабочей БД.

Отдельный integration run в ревью завершился 0/1 на строке 549:
`t.mock.method(prisma.apiUsage, 'create', ...)` получает undefined вместо метода
и выдаёт ERR_INVALID_ARG_VALUE. Полный успешный check не подтверждён;
прежние 164/165 относятся к этапу реализации. Линтер, форматирование и build
прошли в ревью. Во время настоящей синхронизации никакие тесты не запускались;
этот раздел не переаттестовывает сценарии других задач.

## Инкрементальная сверка R07 — 20.11.2026

Сверены assertions трёх неизменённых файлов: четыре сценария `membershipService`, пять `membershipCommand`, восемь `chatInfoTool` (включая сценарии вне action `membership`). Их предыдущий совместный прогон в Node.js 22 Bullseye дал 17/17 согласно [ревью R07](../../tasks/completed/2026-11-19-audit-r07-membership-sync-recovery/review.md); здесь прогон не повторялся. Formatter-тест `db` проверяет только сохранённую legacy-ветку, а не действующий fallback: после R07 fallback отсутствует. Command/tool тесты используют mock-агрегаты с числовым count и источником `vk`; новые `current=null` и `current_source='unavailable'`, реальный запрос VK, ошибка API и отсутствие чтения локального состава ими не воспроизводятся. Эти изменения подтверждены статическим чтением сервиса и обоих callers; отдельный runtime-сценарий не заявляется.

| Исходный тест | Проверяемое поведение |
| --- | --- |
| [subagentTools.test.ts](../../../test/subagentTools.test.ts) | История субагента: pager страницы/`next_before` и reply-target metadata; поиск без учёта регистра и число совпадений; сжатая выжимка, лимит суммаризации и неактивная задача; состав набора из трёх history tools и инструмента времени. Snapshot и provider подменены. |
| [subagentService.test.ts](../../../test/subagentService.test.ts) | Девять сценариев сервиса: порог частей, уникальность/дедупликация активной задачи, суточный лимит, статус, очистка по сроку, удаление прерванных задач, подсчёт активных и остановка. Prisma/очередь подменены; обработка provider и доставка через VK не проверяются. |
| [subagentResultDeliveryService.test.ts](../../../test/subagentResultDeliveryService.test.ts) | Три сценария доставки: групповой ответ с голосом, разбиение личного ответа с голосом по частям и текстовая отправка при выключенном голосе. Не проверяет query selection, timeout/retry, scheduler или повтор после успешной VK-отправки при сбое обновления БД. |
| [chatCompletion.test.ts](../../../test/chatCompletion.test.ts) | Два сценария `sendChatCompletion`: раздельное использование reasoning tokens в usage и `AIOutputLimitError` с запрошенным пределом. Инструментальный цикл, malformed/unknown calls и лимит вызовов в этом файле не тестируются. |
| [chatDigestService.test.ts](../../../test/chatDigestService.test.ts) | 12 сценариев: SQL выборка, пустой результат, count/cap, estimate limits, usage budget, финальный пересказ и actual count, retry с увеличенным output, split chunk, детерминированный merge fallback и поля снимка для субагента. Провайдер/Prisma подменены; внешние модели и фактическая SQLite не проверяются. |
| [personalityService.test.ts](../../../test/personalityService.test.ts) | Четыре сценария каталога и aliases персонажей: встроенный Nikon вместо Joker, retired IDs/aliases, сохранение несвязанных legacy aliases и запрет повторного создания retired ID. Полный `CharacterService` prompt/settings lifecycle не тестируется этим файлом. |
| [textModels.test.ts](../../../test/textModels.test.ts) | Три сценария выбора модели: нормализация aliases и fallback на DeepSeek, отображение DeepSeek `high` в модельный максимум и стандартные reasoning levels Argon. |
| [currentDateTime.test.ts](../../../test/currentDateTime.test.ts) | 14 сценариев `get_current_datetime` и `TimeService`: первичный/резервный поставщик, отклонение ошибочных UTC timestamp, ошибка обоих источников, выбор chat/user scope, явная зона, DST, московский fallback, аргументы и доступ, форматирование результата, а также возврат результата модели через локальный completion server. Реальные внешние API не вызываются. |
| [subagentTool.test.ts](../../../test/subagentTool.test.ts) | Прежний фоновый путь без `runDirect`: 12 сценариев `run_subagent`: короткая/чрезмерная по сообщениям или символам выборка, успешный диапазон, формат/лимит вывода, автоматический порог частей, активная задача, фильтр участников (включая неоднозначность и ЛС), валидация аргументов и периода. Estimate и startJob подменены; реальный SQL, конкурентная запись Prisma и доставка результата не покрыты. |
| [subagentStatusTool.test.ts](../../../test/subagentStatusTool.test.ts) | Четыре сценария `get_subagent_status`: готовый результат и метаданные; `processing` и `failed`; отсутствие задачи и отказ доступа; отклонение аргументов. Чтение статуса подменено, поэтому Prisma-запрос, сортировка задач и обработка ошибки БД не проверяются. |
| [localChatHistoryTool.test.ts](../../../test/localChatHistoryTool.test.ts) | 12 сценариев основной реализации `get_local_chat_history`: пагинация/курсор и неповторение, бюджеты, обрезание, пустой результат, валидация аргументов, direct scope, участники, `in_context`, ambiguous/not-found. Store и resolver замоканы; реальные Prisma-запросы и достижимость инструмента через VK-маршрут не проверяются. |
| [vkFileDownload.test.ts](../../../test/vkFileDownload.test.ts) | Проверка URL документов принимает примеры HTTPS-хостов VK и отклоняет HTTP, чужой/поддельный хост, встроенные учётные данные и нестандартный порт. Тест не запускает реальную загрузку файла. |
| [voiceResponseService.test.ts](../../../test/voiceResponseService.test.ts) | Шесть сценариев: text-only; одно групповое voice attachment; group truncation согласует озвученный и отправленный текст; личный ответ делится с аудио на каждую часть, reply/keyboard только у первой; group voice failure даёт notice fallback; private failure всё равно отправляет text part. Проверяется через mock sender/TTS, тесты не запускались. |
| [messageDelivery.test.ts](../../../test/messageDelivery.test.ts) | Контракт `send_vk_message`: режимы доставки, проверка участника по страницам, неоднозначные/ошибочные lookup, область текущего peer, fallback на mention, uncertain-отправка и защита от повторного/дублирующего ответа. Косвенно проверяет shared `participantId`/`participantPage`/`matchesParticipant` из `vkInfoTool.ts` через адресный поиск; сам `createVkInfoTool` не вызывается. |
| [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts) | Интеграционная доставка участнику через VkService, таймаут VK после потенциальной отправки, подавление fallback-дубля, active-mode decision, play_game inspect и отказ execute_bot_command после ранее начатого действия. Memory callers подменены; поиск/извлечение/сохранение памяти и все callback interactionTools не проверяются. R09 добавляет отдельную SQLite для общего последнего слота command/tool из разных бесед, timestamp usage, ранних отказов и сбоев API/VK/usage/finish. Конкурентный сценарий вызывает /image при занятой tool очереди автора; прежняя временная проверка /help в файл не перенесена. Подробности и ограничения — в разделе R09 ниже. |
| [chatInfoTool.test.ts](../../../test/chatInfoTool.test.ts) | Восемь сценариев `get_chat_info`: страницы состава/hidden fields, дни рождения и границы ЛС, ранний отказ доступа, агрегаты membership, admin-only, неприменимость в ЛС, проверка периода и допустимости `days`. Не покрывает `overview`, `member`, VK collection sections и lookup target. |
| [attachmentTool.test.ts](../../../test/attachmentTool.test.ts) | Девять сценариев `analyze_attachment`: три вида вложений, отсутствующий/неподдерживаемый файл, проверка доступа до загрузки, ошибка анализа, повтор после начала анализа и валидация аргументов. Не проверяет лимиты downloader и VK-attachment selection в `VkService`. |
| [locationTool.test.ts](../../../test/locationTool.test.ts) | Семь тестов в одном файле: четыре `manage_location` проверяют defaults, callback после mock-записи города, отказ участнику группы и ambiguity; три `get_weather` — московский fallback, игнорирование неупомянутого в текущем сообщении города и текстовое уточнение неоднозначного места. Для location tool не покрыты реальное сохранение/геокодирование, timezone, очистка, direct scope и ошибки БД. Пограничная валидация/ошибки погодных API напрямую не покрыты. |
| [imageTool.test.ts](../../../test/imageTool.test.ts) | Прежние пять сценариев и проверки валидации/access/photo до reserve, ошибки БД/replay, release только до API, uncertain после API, сбои finish/usage, timestamp и потеря ACK. Квота и генератор подменены; реальные SQLite/загрузка фото не покрыты этим файлом. |
| [imageQuotaService.test.ts](../../../test/imageQuotaService.test.ts) | Реальные миграции и синтетическая SQLite: seed автора/features/UTC-дня, одноразовая инициализация, расход сверх лимита, повтор ID, release/терминальные состояния, rollback при отказе вставки и нарушении счётчика, полночь, два процесса с IPC-барьером, аварийная остановка после commit и независимый автор, upgrade с сохранением usage/стоимости. [Worker](../../../test/fixtures/imageQuotaWorker.ts) использует отдельный PrismaClient; SQLITE_BUSY допускается как отказ без генерации. Рабочая БД не используется. |
| [imageGenerationService.test.ts](../../../test/imageGenerationService.test.ts) | Подготовка (download/Sharp/нет клиента) до Images API; moderation/HTTP/timeout/пустой ответ после API сохраняют обычную ошибку; успешные буферы. Клиент подменён, живых VK/AI нет. |
| [membershipCommand.test.ts](../../../test/membershipCommand.test.ts) | Пять сценариев `/membership`: алиасы, отказ обычному участнику, недопустимость в ЛС, проверка периода и формат агрегатов. Prisma/service результаты подменены. |
| [membershipService.test.ts](../../../test/membershipService.test.ts) | Четыре проверки форматирования membership aggregates: строка отчёта, русские формы дней, частичный учёт/legacy `currentSource='db'` и отрицательное сальдо. После R07 сервис больше не производит `db`, но formatter поддерживает этот вход. Реальный сбор Prisma/VK и новый `null/unavailable` не покрыты. |

Для шести `message_event` callback-действий (`menu_page`, `personality_select`, summary по `hours`, `meme_vote`, `fun_feedback`, `fun_again`) отдельные тесты в `test/` не обнаружены. `vkMessageDeliveryIntegration.test.ts` проверяет интеграционные сценарии доставки и AI-инструментов, но не эти callback ветви.

Отдельного репозиторного теста `listen_reply_voice` нет; при реализации выполнены временные проверки с подменёнными VK и провайдером.

Прямых репозиторных тестов новых `DirectSubagentService`, `historySnapshot`, `historyTranscript` и `historyText` не обнаружено; сценарии с подменёнными зависимостями описаны в [ревью задачи](../../tasks/completed/2026-11-16-message-history-rework/review.md).

## Инкрементальная сверка R11

20.11.2026 сверены два набора выше: после удаления дополнительного history access guard в каждом осталось по 12 кейсов. Удалены access-сценарии внутри смешанных кейсов, тип `Access`, параметр `access` и mock `checkAccess`; самостоятельные проверки аргументов/периода и отсутствия чтения/запуска при неверных аргументах сохранены. Текущие имена — `get_local_chat_history validates input` и `run_subagent validates input and period`.

В этой синхронизации тесты не запускались. Фактический прогон 24 фокусных сценариев и его ограничения, включая первый сбой прав рабочего лог-файла и успешный повтор во временной копии, записаны в [ревью R11](../../tasks/completed/2026-11-19-audit-r11-history-access-before-resolver/review.md#фактические-проверки). [Повторное ревью R11](../../tasks/completed/2026-11-19-audit-r11-history-access-before-resolver/review.md#повторное-ревью--20112026) подтвердило тот же состав наборов и сохранность независимых assertions без нового запуска тестов. Прямой `runDirect`, SQL и полный VK-маршрут этими unit-наборами не воспроизводятся.

## Инкрементальная сверка R09

Инкремент R09: [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts)
также использует отдельную синтетическую SQLite и реальные production command/tool callers.
Проверяет последний слот для конкурентных tool/команды из разных бесед, отсутствие дубля,
timestamp image usage, отказ конфигурации/БД/отсутствия фото, ошибки подготовки/API/VK,
независимость квоты от usage и доставку готовой картинки при сбое finish.
Все внешние сервисы подменены; это не проверка рабочих запросов.
Результаты запуска не выводятся из наличия тестового кода.

20.11.2026 assertions повторно сопоставлены с текущим кодом и
[ревью](../../tasks/completed/2026-11-19-audit-r09-image-quota-atomicity/review.md).
Регрессионные тесты R09, конкуренция процессов, рестарт и fresh/upgrade
в этой сессии не выполнялись. Сборка и линтер, выполненные до ревью,
не считаются результатом этих сценариев.

## Фоновые задания

Прямых тестов семи cron wrappers и `scheduler.ts` в `test/` нет. `subagentService.test.ts` проверяет очистку завершённых задач и удаление прерванных задач на уровне сервиса; `subagentResultDeliveryService.test.ts` проверяет три варианта отправки результата. Ни один из них не проверяет расписание, `running` guard или таймерный retry. Тестов на cleanup памяти, напоминания, game timeout, приключения, мемы дня и архивирование долговременной памяти не обнаружено. Тесты `membershipCommand`/`membershipService` описывают только указанные в таблице сценарии. Подробные факты и пределы утверждений для каждого job указаны в [каталоге заданий](../src/jobs/README.md).

Все существующие test-файлы сопоставлены с владельцами и проверяемыми контрактами; это не утверждение полного source coverage. Известные пути без тестов или без прямой интеграционной проверки перечислены рядом с соответствующими спецификациями.
