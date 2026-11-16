# memeDayService

**Тип:** сервис настроек расписания, статусов публикаций, истории и голосов. **Символы:** `MemeDayService`; singleton `memeDayService`. **Источник:** [memeDayService.ts](../../../../../src/services/fun/memeDayService.ts). Расписание и UI находятся в [memeDayJob](../../jobs/memeDayJob.md), [MemeService](memeService.md) и [VK-команде](../command/commands.md#command-memeday).

## Настройки и persistence

`MemeDaySettings` хранится JSON-строкой в `ChatSettings.memeDaySettings`. Defaults: `enabled=false`, `dailyTime=20:00`, `timezone=MEMEDAY_TIMEZONE`, `weeklyEnabled=false`, `allowNight=false`, `style=auto`, `allowParticipantMemes=false`, `participantFrequency=10`, `intensity=50`, `allowQuotes=false`, `manualEnabled=true`, `votingEnabled=true`, `excludedUserIds=[]`, `activeWithinHours=48`. Enum `MemeDayKind`: `daily`, `weekly`, `group`, `user`, `event`, `quote`, `absurd`, `prediction`.

Parser требует JSON-object и проверяет boolean поля; `dailyTime` по `HH:mm`, IANA timezone через `Intl.DateTimeFormat`, стиль по перечислению, participantFrequency/intensity — целые 0–100, activeWithinHours — целое 1–168, исключения — не более 100 цифровых строковых VK IDs. Ночное расписание 22:00–07:59 требует `allowNight=true`. Неизвестные дополнительные поля игнорируются. Ошибочный JSON/значение бросает ошибку при чтении настроек.

`getSettings` требует существующий `ChatSettings` (`findUniqueOrThrow`). `updateSettings` разбирает текущий JSON, накладывает patch, повторно валидирует и сохраняет сериализованный объект. Для `weeklyEnabled` он также обновляет отдельное `ChatSettings.memeDayWeeklyEnabled`, используемое памятью для недельного хранения сообщений; источник расписания читает значение из JSON. Прямой runtime merge этих двух полей при чтении не выполняется.

## Публикации и резервирование

`listEnabledChats` рассматривает только group conversations, пропускает строки с повреждёнными настройками, журналирует ошибку и возвращает чаты с `enabled || weeklyEnabled`.

`claimScheduled(conversationId, scheduleKey, kind)` использует уникальный `scheduleKey`. При отсутствии записи создаёт `pending`; конфликт unique `P2002` обрабатывается перечитыванием. Чужая беседа и статусы `published`/`skipped` отклоняются. Условный update допускает `pending`/`failed` либо `generating` с истёкшим lock, требует `attempts<3`, наступивший `nextAttemptAt` и отсутствие действующего `lockUntil`; claim ставит `generating`, увеличивает attempts и устанавливает 15-минутный lock. Это защита через БД для параллельных процессов, помимо process-local job guard.

Результаты переходов:

| Метод | Изменение |
| --- | --- |
| `beginManual` | Создаёт запись без `scheduleKey` сразу в `generating`; общее ограничение — менее трёх ручных записей `generating`/`published` за последний час на беседу. |
| `complete` | Записывает kind/topic/caption/FunOutput ID/attachment и URL `https://vk.com/<attachment>`, ставит `published`, снимает locks и retry time. |
| `markSkipped` | Ставит `skipped`, очищает lock/retry; такой schedule key больше не повторяется. |
| `markFailed` | Ручной/non-retryable или третья ошибка — terminal `failed`; иначе ставит `nextAttemptAt=now+attempts*10 минут`. Job всё равно требует совпадения точного `dailyTime`, поэтому retry позже целевой минуты обычно не случится в эту же дату. |
| `deleteFailedManual` | Удаляет только строку без `scheduleKey` и пока `status=generating`. |

## Выбор публикации в VK и генерация

Еженедельный scheduled kind сразу становится `weekly`. Для daily VK случайно проверяет `allowParticipantMemes`/`participantFrequency`; кандидатами становятся авторы пользовательских сообщений за сутки, затем исключаются `excludedUserIds`, личный `personalMemes` opt-out и авторы, которых нет в текущем составе беседы. Случайно выбирается один eligible author. Если персональный выбор не дал мем из-за малого/неподходящего контекста, `scheduledMemeDay` повторяет генерацию как общий мем.

При отсутствии персонального выбора kind вращается среди `group`, `event`, `absurd`, `prediction` и добавляет `quote`, если `allowQuotes`. Начальная позиция выбирается после последнего опубликованного вида. Для ручного `now` применяется та же daily selection; `all` принудительно использует group, `user` выбирает запросившего/указанного eligible участника. Командные ограничения и точные ответы перечислены в [каталоге](../command/commands.md#command-memeday).

`publishMemeDay` просит [MemeService](memeService.md) сгенерировать концепцию по контексту; `null` означает, что безопасных/достаточных сообщений не найдено. При публикации VK отправляет фото, подпись и клавиатуру если включено voting. Плановый выпуск передаёт стабильный random ID, рассчитанный из scheduleKey, ручной — без него. После отправки сервис записывает `published`; при ошибке VK/БД удаляется `FunOutput`, ошибка повторно бросается job/обработчику. Поскольку VK send и Prisma update не транзакционны, сбой записи после успешной отправки может привести к повторной публикации.

## История и голосование

`history` возвращает опубликованные публикации беседы, newest-first, default 5, limit 1–20, включая votes. `latest`/`latestWeekly` возвращают последний опубликованный daily-any-kind или weekly-kind. `random` выбирает случайный offset среди опубликованных строк. `top` вычисляет score по `fire=+2`, `laugh=+1`, `neutral=0`, `dislike=-1`, сортирует по score, затем времени, и ограничивает 1–10 (default5).

`vote` принимает только enum value и только публикацию со статусом `published` в текущем `conversationId`; vote upsert-ится по `(publicationId,vkUserId)`, поэтому новый голос заменяет старый. После сохранения сервис перечитывает все голоса и возвращает score/count. Отдельный `message_event` callback проверяет payload и `votingEnabled`; доступность ID в чужой беседе не раскрывается.

## Проверки

Тестов `MemeDayService`, `/memeday` либо выбора `chooseScheduledMemeKind` в `test/` нет. Уникальные claims, JSON migration state, timezone schedule, DB/VK failure window и scoring описаны по коду, но не подтверждены автоматическими тестами.
