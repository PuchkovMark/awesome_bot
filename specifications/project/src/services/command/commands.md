# Команды бота

Канонический каталог исполняемых команд и callback-действий. Сверен с текущими `commandAliases`, ветвями `CommandService.executeCommand`, специальными обработчиками `VkService.runBotCommand` и callback builders. Аргументы команд игры и их переходы описаны в [GameService](../games/gameService.md), игровые и VK-маршруты — ниже; доказательства тестов см. в [карте](../../../test/README.md), общее состояние — в [реестре покрытия](../../../coverage.md).

## Указатель

- [image](#command-image), [edit](#command-edit), [analyze](#command-analyze), [ocr](#command-ocr), [document](#command-document), [meme](#command-meme), [say](#command-say) — изображения, документы и голос.

- [admin](#command-admin)
- [battle](#command-battle)
- [broadcast](#command-broadcast)
- [city](#command-city)
- [effort](#command-effort)
- [forget](#command-forget)
- [fun](#command-fun)
- [funsettings](#command-funsettings)
- [games](#command-games)
- [help](#command-help)
- [imageaccess](#command-imageaccess)
- [joke](#command-joke)
- [logs](#command-logs)
- [maintenance](#command-maintenance)
- [membership](#command-membership)
- [mode](#command-mode)
- [model](#command-model)
- [personality](#command-personality)
- [prediction](#command-prediction)
- [profile-delete-confirm](#command-profile-delete-confirm)
- [profile-delete](#command-profile-delete)
- [profile](#command-profile)
- [profiles](#command-profiles)
- [questionnaire](#command-questionnaire)
- [randomjoke](#command-randomjoke)
- [rating](#command-rating)
- [react](#command-react), [reaction](#command-reaction)
- [reset](#command-reset)
- [roast](#command-roast)
- [settings](#command-settings)
- [stats](#command-stats)
- [story](#command-story)
- [summary](#command-summary)
- [system](#command-system)
- [timezone](#command-timezone)
- [translate](#command-translate)
- [users](#command-users)
- [voice](#command-voice)
- [welcome](#command-welcome)
- [adventure](#command-adventure)
- [hint](#command-hint)
- [inspect](#command-inspect)
- [inventory](#command-inventory)
- [journal](#command-journal)
- [look](#command-look)
- [map](#command-map)
- [memeday](#command-memeday)
- [status](#command-status)
- [talk](#command-talk)
- [use](#command-use)
- [vote](#command-vote)

## Общий вход и распределение исполнения

В снимке 2026-11-16 таблица содержит 56 ключей `commandAliases`; каждому соответствует отдельная `command-*` секция. В каталоге всего 59 секций: три дополнительных имени — внутренние `profile-delete`, `profile-delete-confirm` и поддерживаемый raw `/reaction`, которого нет в alias map. `/анкета` без аргумента нормализуется в `/profile edit`; `/удалить профиль` и `/подтвердить удаление профиля` переводятся в два внутренних действия. Неизвестное имя после `/` остаётся командой и получает ответ `Неизвестная команда: <имя>`, без перехода к AI.

Входная адресация, очередь, maintenance, `quiet`, rate limit, неизвестные команды и общий порядок ветвей описаны в [architecture.md](../../architecture.md). Парсер принимает `/` и `!`; в группах slash-команда является прямой командой без обращения к боту, тогда как `!` требует обращения/ответа боту, кроме маршрутов анкеты. Эти общие условия применяются до вызова отдельных контрактов ниже.

| Группа входов | Фактический владелец и дополнительная маршрутизация |
| --- | --- |
| Команды с `CommandService.executeCommand` ветвью | 43 явные `case`-ветви; общие проверки полномочий выполняются до `switch`, а ошибки нормализуются catch-блоком. Полный базовый обработчик — [commandService.md](commandService.md). `image`, `edit` и `document` имеют fallback case, но обычный VK путь перехватывает их в `runBotCommand`. |
| `/image`, `/edit` | Отдельный `DetectorService.parseImageCommand`, затем генерация/редактирование изображения в `VkService`; обычный `CommandService` не вызывается. |
| `/say`, `/analyze`, `/ocr`, `/document`, `/meme`, `/memeday` | Специальные ветви `VkService.runBotCommand`; контракты приведены ниже. `document` перехватывается и при отсутствии подходящего вложения, после чего возвращает подсказку. |
| `/adventure`, `/inventory`, `/look`, `/inspect`, `/talk`, `/use`, `/status`, `/vote`, `/journal`, `/map`, `/hint` | Набор `adventureCommands` в `VkService`; короткие имена преобразуются в аргументы `AdventureService.handleCommand`. `/games adventure` и `/games detective` — дополнительная legacy-форма запуска приключения. |
| `/summary`, `/personality`, `/help`, `/admin`, развлекательные команды | Некоторые команды остаются в общем сервисе, но `VkService` добавляет специальную обработку: summary payload/голос/кнопки, меню персонажа, пагинацию и feedback-клавиатуру. Отдельные упоминания в `profile`, `admin` и `joke` предварительно разрешаются в VK ID; `translate` при необходимости загружает текст reply. |

Статическая сверка покрывает 56/56 ключей alias map, 43 `CommandService` case labels, 11 short adventure commands, внутренние многословные действия профиля, прямые media/voice/fun routes и все шесть callback payloads. Контракты ниже фиксируют доступные синтаксисы, значимые проверки, эффекты и ошибки; общие пред- и постусловия маршрута находятся в [`VkService`](../vk/vkService.md) и [`CommandService`](commandService.md). Тесты сопоставлены отдельно в [карте](../../../test/README.md): большинство команд не имеет прямого теста.

### Иллюстративные примеры входов

Примеры показывают вид входного текста; состояние, права и ответ сервиса остаются обязательными условиями. Строки в третьей колонке иллюстрируют конкретный отказ/ошибку, а `—` означает, что у команды нет отдельной валидации аргументов помимо общего маршрута.

| Раздел | Допустимый вход | Отказ или ошибочный вход |
| --- | --- | --- |
| [admin](#command-admin) | `/admin 2` | `/admin add 123` от пользователя без роли создателя — отказ |
| [battle](#command-battle) | `/battle start 3` | `/battle submit шутка` без активного раунда — отказ сервиса |
| [broadcast](#command-broadcast) | `/broadcast confirm Важное сообщение` | `/broadcast` — usage; одиночный `confirm` становится preview текстом |
| [city](#command-city) | `/city set Москва, Москва, Россия` | `/city set` — usage |
| [effort](#command-effort) | `/effort high` | `/effort maximum` — список low/medium/high |
| [forget](#command-forget) | `/forget` | — (переданный аргумент не используется) |
| [fun](#command-fun) | `/fun` | — (команда только показывает меню) |
| [funsettings](#command-funsettings) | `/funsettings intensity 70` | `/funsettings intensity 101` — значение вне 0–100 |
| [games](#command-games) | `/games list` | `/games start unknown` — неизвестная игра |
| [help](#command-help) | `/help 2` | `/help abc` — требуется номер страницы |
| [imageaccess](#command-imageaccess) | `/imageaccess all` | `/imageaccess public` — допустимы только `admins_only`/`all` |
| [joke](#command-joke) | `/joke random` в группе | `/joke random` в ЛС — действие доступно только в группе |
| [logs](#command-logs) | `/logs` от bot admin | `/logs` от обычного участника — отказ |
| [maintenance](#command-maintenance) | `/maintenance on` | `/maintenance maybe` — usage |
| [membership](#command-membership) | `/membership 7` от bot admin в группе | `/membership 0` — период вне 1–3650 |
| [mode](#command-mode) | `/mode active` | `/mode silent` — допустимы active/normal/quiet |
| [model](#command-model) | `/model argon` | `/model gpt` — список моделей |
| [personality](#command-personality) | `/personality list` | `/personality default nikon` без bot admin — отказ |
| [prediction](#command-prediction) | `/prediction дождливый день` | `/prediction 123` в ЛС — выбор участника доступен только в группе |
| [profile-delete-confirm](#command-profile-delete-confirm) | `/подтвердить удаление профиля` при активном запросе | Та же команда без активного запроса — предложение начать заново |
| [profile-delete](#command-profile-delete) | `/удалить профиль` при заполненной анкете | Та же команда без заполненного профиля — отказ |
| [profile](#command-profile) | `/профиль edit 2 Новый ответ` | `/профиль clear 0` — номер должен быть положительным |
| [profiles](#command-profiles) | `/анкеты 2` в группе | `/анкеты abc` — usage |
| [questionnaire](#command-questionnaire) | `/опрос on` от администратора группы | `/опрос maybe` — usage |
| [randomjoke](#command-randomjoke) | `/randomjoke про космос` | — (пустая тема заменяется стандартной) |
| [rating](#command-rating) | `/rating` | — (аргумент необязателен) |
| [react](#command-react) | ответом на текст: `/react саркастично` | `/react` без reply и текста — просьба указать текст |
| [reaction](#command-reaction) | `/reaction неожиданное сообщение` | `/reaction` без reply и текста — usage |
| [reset](#command-reset) | `/reset` | — (аргумент не требуется) |
| [roast](#command-roast) | `/roast` при включённых персональных шутках | `/roast` при opt-out — инструкция по включению |
| [settings](#command-settings) | `/settings` | — (команда показывает состояние) |
| [stats](#command-stats) | `/stats` | — (чужой VK ID не принимается) |
| [story](#command-story) | `/story короткая` | `/story continue` без предыдущей истории — предложение создать её |
| [summary](#command-summary) | `/summary 6 часов` | `/summary` при пустой истории — сообщение об отсутствии текста |
| [system](#command-system) | `/system clear` | `/system global текст` — устаревший префикс отклоняется |
| [timezone](#command-timezone) | `/timezone set Europe/Moscow` | `/timezone set Mars/Olympus` — невалидная зона |
| [translate](#command-translate) | `/translate en: Доброе утро` | `/translate` без reply и текста — usage |
| [users](#command-users) | `/users` от bot admin | `/users` от обычного участника — отказ |
| [voice](#command-voice) | `/voice on` | `/voice whale` — список доступных голосов |
| [welcome](#command-welcome) | `/welcome set Привет, {name}!` | `/welcome set` — usage |
| [adventure](#command-adventure) | `/adventure start detective` | `/adventure join` без активного lobby — ответ состояния сервиса |
| [hint](#command-hint) | `/hint` при участии и включённых подсказках | `/hint` без участия — отказ |
| [inspect](#command-inspect) | `/inspect запертую дверь` | `/inspect` без цели — usage |
| [inventory](#command-inventory) | `/inventory` во время приключения | `/inventory` без участия — отказ |
| [journal](#command-journal) | `/journal` для текущей/последней сессии | `/journal` без доступной сессии — пустое состояние |
| [look](#command-look) | `/look` при активном приключении | `/look` без участия — отказ |
| [map](#command-map) | `/map` при активном приключении | `/map` без участия — отказ |
| [memeday](#command-memeday) | `/memeday history` | `/memeday settings time 25:90` — недопустимое время |
| [status](#command-status) | `/status` при активном приключении | `/status` без участия — отказ |
| [talk](#command-talk) | `/talk бармен` | `/talk` без цели — usage |
| [use](#command-use) | `/use ключ` при наличии предмета | `/use ключ` без ключа в инвентаре — отказ действия |
| [vote](#command-vote) | `/vote за проводника` в режиме голосования | `/vote` без допустимого аргумента/фазы — подсказка сервиса |
| [image](#command-image) | `/image ночной город под дождём` | `/image` без описания — usage |
| [edit](#command-edit) | `/edit преврати в акварель` с фото | `/edit` без фотографии — просьба приложить фото |
| [analyze](#command-analyze) | `/analyze что изображено?` с фото | `/analyze` без вложения — запрос вложения |
| [ocr](#command-ocr) | `/ocr` с фотографией | `/ocr` без фотографии — предложение `/document` для документа |
| [document](#command-document) | `/document кратко перескажи` с PDF | `/document` без документа — запрос вложения |
| [meme](#command-meme) | `/meme кот опоздал на работу` | `/meme` при недоступном ключе модели — сообщение об ошибке генерации |
| [say](#command-say) | `/say Доброе утро` | `/say` без текста и без reply — usage |

Для adventure/memeday и прочих сервисных ветвей примеры ошибки относятся к указанным предпосылкам; точный ответ определяется связанной спецификацией сервиса. Эти строки иллюстративны и не являются результатами выполнения тестов.

## command-admin

### /admin

**Тип:** команда. **Алиасы:** `/admin`, `/админка`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Без аргумента показывает первую из трёх панелей; `/admin <1–3>` открывает страницу, другой формат/диапазон возвращает подсказку. Только создатель может выполнить `add|добавить <цифровой VK ID>` или `remove|удалить <ID>`. Нельзя снять роль создателя или собственную; администратор, заданный через `VK_ADMIN_IDS`, не снимается этим путём. Успешное изменение журналируется и пытается разрешить display name. В VK-обработчике одиночное упоминание преобразуется в ID. Отдельного прямого теста команды нет.


## command-battle

### /battle

**Алиас:** `/баттл`. **Источник:** [CommandService.handleFunBattle](../../../../../src/services/command/commandService.ts).

Доступна только в группе и выполняется через `serializeGameConversation`. `start [1–5]` создаёт `GameSession` с ведущим, раундом и участниками; по умолчанию три раунда, второй активный баттл не допускается. `join` добавляет участника до начала отправки шуток; повторное вступление отклоняется.

`submit <шутка>` требует минимум двух участников, членства автора и длины 2–500 символов; каждый участник отправляет одну шутку за раунд. После ответа всех участников текстовый ИИ выбирает победителя в JSON, сервис проверяет, что победитель входит в список, и увеличивает его `GameScore`. Затем начинается следующий раунд или сессия завершается. Некорректный JSON или неизвестный победитель вызывают ошибку обработчика. `score` показывает очки, `stop` разрешён ведущему или администратору бота.

## command-broadcast

### /broadcast

**Тип:** команда. **Алиасы:** `/broadcast`, `/рассылка`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор бота. Вход `/broadcast <текст>` или `/broadcast confirm <текст>` принимает непустой текст до 1000 символов. Первый вызов показывает размер актуальной выборки бесед с сообщениями за семь дней (до 50), а подтверждённый вызов заново вычисляет адресатов и последовательно отправляет каждому; preview не фиксирует неизменяемый набор. Одиночный `confirm` без текста распознаётся как текст preview, а не подтверждение. Ошибки отдельных отправок считаются, журналируется итог `sent/failed`; ошибка чтения адресатов или журнала проходит общий обработчик ошибки. ИИ-инструмент не выполняет эту команду. Прямого теста нет.


## command-city

### /city

**Алиасы:** `/город`, `/местоположение`, `/location`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), `manageCity`; [locationService.ts](../../../../../src/services/settings/locationService.ts).

Без аргумента, `show`, `status` или `показать` показывает сводку. В группе используется область беседы, в ЛС — автора. `set <город>, <регион>, <страна>` или просто `<город>` ищет населённый пункт; неоднозначный поиск показывает до пяти вариантов и просит уточнить регион или страну. `reset`, `clear`, `delete`, `сброс`, `удалить` сбрасывают город. Изменение в группе требует прав администратора беседы, бота или создателя; обычный участник получает отказ. Ошибка поиска или отсутствие результата сообщаются пользователю. Связанный часовой пояс — в [timezone](commands.md#command-timezone).

## command-effort

### /effort

**Тип:** команда. **Алиасы:** `/effort`, `/усилие`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор бота. Без аргумента показывает эффективное значение настройки и параметр `reasoning_effort` для текущей модели; `low|medium|high` записывает `AppSetting.ai_effort`, пишет AdminLog и показывает отображённое эффективное значение. Неверный аргумент возвращает список вариантов, повреждённое сохранённое значение предлагает установить заново. Три уровня преобразуются отдельно для `deepseek`/`argon`; детали — в [effort](../ai/effort.md). Прямого теста команды нет.


## command-forget

### /forget

**Тип:** команда. **Алиасы:** `/forget`, `/забыть`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Удаляет сообщения автора во всех беседах через `clearUserHistory(senderId)`, затем устанавливает личный `systemPrompt=null`; отвечает числом удалённых сообщений. Это не удаляет `LongTermMemory`, записи `ConversationMember`, membership events, usage, игровые очки и настройки. Сбой после очистки истории до сброса prompt оставляет частично выполненное действие; общей транзакции нет. Прямого теста команды нет.


## command-fun

### /fun

**Алиас:** `/развлечения`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

Возвращает статический список одиннадцати команд: `randomjoke`, `meme`, `joke`, `roast`, `prediction`, `react`, `rating`, `story`, `battle`, `funsettings`, `memeday`. Генерацию и изменение настроек не запускает; неизвестных параметров нет. Перечень выводится `CommandService.executeCommand`. Прямого теста меню нет.

## command-funsettings

### /funsettings

**Алиас:** `/настройкиюмора`. **Источник:** [CommandService.updateFunSettings](../../../../../src/services/command/commandService.ts), [funService](../../../../../src/services/fun/funService.ts).

Без аргумента показывает настройки. Личные `intensity`, `sarcasm`, `absurdity` принимают 0–100, а `emojis`, `jokes`, `memes` — `on|off`. Общие `chat intensity|sarcasm|absurdity <0–100>` и `chat emojis on|off`, а также `auto on|off`, `probability 1–30`, `interval 60–3600` доступны только в группе администратору бота. Неверные аргументы отклоняются с подсказкой; права администратора беседы сами по себе для этих ветвей недостаточны.

## command-games

### /games

**Алиас:** `/игры`. **Источник:** [CommandService.gamesCommand](../../../../../src/services/command/commandService.ts), [GameService.handleCommand](../../../../../src/services/games/gameService.ts).

Без аргумента показывает список игр. `start|начать <игра> [настройки]` создаёт игру; имя игры без `start` также распознаётся как запуск. Поддерживаются `list|список|help|помощь`, `top|рейтинг [общий]`, `stats|статистика`, `privacy|приватность on|off`, `join|присоединиться|войти`, `difficulty|сложность [1–4|название]`, `harder|сложнее`, `easier|легче|проще`, `score|счёт`, `team|команда <ID> <1|2>`, `captain|капитан <ID>`, `pause|пауза`, `resume|продолжить`, `stop|end|стоп|закончить`, `hint|подсказка`, `skip|пропуск|пропустить`, `repeat|повторить`, `next|следующий`, `pass|пас`. Настройки старта: сложность, раунды/вопросы, число игроков, время, подсказки, попытки, командный/индивидуальный режим, пропуск, автоматический переход и категория. Границы, полномочия, статистика, участники и переходы описаны в [GameService](../games/gameService.md), парсинг — в [gameEngine](../games/gameEngine.md); мафия делегируется [MafiaService](../games/mafiaService.md).

## command-help

### /help

**Алиасы:** `/помощь`, `/команды`. **Источник:** [CommandService.helpText](../../../../../src/services/command/commandService.ts), [HELP_PAGES](../../../../../src/services/command/commandHelp.ts).

`/help [страница]` показывает одну из `HELP_PAGES`, по умолчанию страницу 1. Аргумент должен быть только цифрами и безопасным целым в пределах массива; разный текст и выход за диапазон возвращают разные подсказки. VK добавляет `menu_page` keyboard; переход повторно проверяет верхнюю границу в `helpText`. Содержимое справки хранится отдельно от dispatcher, поэтому может расходиться с исполняемыми маршрутами; фактический каталог этого файла является источником runtime-поведения. Прямого теста нет.

Callback `menu_page` используется и для этой справки, и для `/admin`; payload, обработка страницы и ограничения описаны в [разделе callback-действий](#menu-page).

## command-imageaccess

### /imageaccess

**Тип:** команда. **Алиасы:** `/imageaccess`, `/доступккартинкам`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор; `admins_only` или `all`, сохраняет доступ для `peerId` и журналирует изменение. Пустое или другое значение отклоняется.


## command-joke

### /joke

**Алиас:** `/шутка`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

`/joke [all|random|участник|тема]` генерирует доброжелательную шутку. `all` и `random` требуют группу; `random` выбирает из присутствующих участников, разрешивших персональные шутки. При числовом ID участник должен присутствовать и разрешать шутки. VK-обработчик преобразует упоминания. При отсутствии подходящих участников или отказе возвращается сообщение без персональной генерации.

## command-logs

### /logs

**Алиас:** `/журнал`. **Источник:** [CommandService.getRecentAdminLogs](../../../../../src/services/command/commandService.ts).

Требует администратора бота. Возвращает до десяти последних действий из `AdminLog` с временем, именем администратора и действием; при пустом журнале сообщает об этом. Не следует путать с `/journal` — журналом приключения.

## command-maintenance

### /maintenance

**Тип:** команда. **Алиасы:** `/maintenance`, `/обслуживание`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор; `on`/`off` меняет глобальный `AppSetting` и журналирует действие. Пустой аргумент возвращает синтаксис, хотя справка показывает квадратные скобки.


## command-membership

### /membership

**Тип:** команда. **Алиасы:** `/membership`, `/участники`, `/состав`, `/статистикаучастников`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор бота и только группа; аргумент — безопасное целое число дней 1–3650, по умолчанию 30. Неверный формат, дробное число и выход за диапазон возвращают usage. Передаёт запрос `membershipService.getStats` и форматирует результат. [`membershipCommand.test.ts`](../../../../../test/membershipCommand.test.ts) покрывает алиасы, отказ неадминистратору, запрет ЛС, валидацию периода и формат ответа; Prisma и сервис подменены.


## command-mode

### /mode

**Тип:** команда. **Алиасы:** `/mode`, `/режим`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор; требует `active`, `normal` или `quiet`, сохраняет режим для текущего `peerId` и пишет журнал. В отличие от подсказки в справке, пустой аргумент возвращает просьбу указать режим.


## command-model

### /model

**Тип:** команда. **Алиасы:** `/model`, `/модель`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только администратор. Без аргумента показывает текущую глобальную модель и список; `deepseek` или `argon` переключает модель и пишет `ai_model` в `AppSetting`, а также административный журнал. Неверное имя возвращает подсказку.


## command-personality

### /personality

## Персонажи

Обработчики `setPersonality`, `setChatPersonality`, `managePersonality` находятся в [commandService.ts](../../../../../src/services/command/commandService.ts); хранение и проверку доступности реализует [characterService.ts](../../../../../src/services/settings/characterService.ts). Каноническая команда `/personality`, алиас `/персонаж`.

- Без аргументов или с `list` показывается текущий персонаж и доступный список; в личной беседе администратор при `list` получает расширенный список. `info` показывает описание и пример.
- В ЛС `<id>` выбирает личного персонажа, `default` выбирает глобального персонажа по умолчанию; история сохраняется. `settings` показывает параметры, `settings humor=70 sarcasm=30` изменяет их, `reset` сбрасывает индивидуальные настройки. Значения передаются как пары `имя=число`; некорректный синтаксис вызывает сообщение об ошибке.
- В группе выбор действует на беседу. `allow`/`deny` меняют право участников выбирать персонажа и доступны администраторам беседы, бота или создателю. Выбор `<id>`/`default` доступен им либо всем участникам, если это разрешено в настройках. Общие `settings` требуют права управления беседой; `reset` для индивидуальных настроек в группе не поддерживается.
- `default <id>` назначает глобальный выбор по умолчанию и доступен администратору бота. Административные `add`, `edit`, `prompt`, `disable`, `enable`, `rollback`, `availability`, `exclusive`, `access`, `defaults`, `stats` также требуют администратора бота. Форматы: `add id|имя|описание|пример|инструкция`, `edit id|name|значение`, `prompt id|инструкция`, `rollback id|номер`, `availability id|direct|on`, `exclusive id|chat|PEER_ID`, `access id|direct|add|VK_ID`, `defaults id|humor=70`. Проверка конкретного профиля и допустимых значений дополнительно выполняется сервисом.

Пример: `/персонаж info` показывает описание; `/персонаж allow` от обычного участника без прав управления беседой возвращает отказ.

Кнопки выбора используют callback `personality_select`; серверная повторная проверка типа диалога, прав, режима обслуживания и лимита описана в [разделе callback-действий](#personality-select).


[Каталог команд](commands.md).

## command-prediction

### /prediction

**Алиас:** `/предсказание`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

Создаёт шуточное предсказание по аргументам либо стандартной теме. Числовой ID адресата требует группу, присутствие участника и его разрешение на персональные шутки; иначе возвращается отказ.

## command-profile-delete-confirm

### Подтверждение удаления анкеты

**Команда:** `/подтвердить удаление профиля`; внутри обработчика нормализуется в `profile-delete-confirm`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), `confirmProfileDeletion`; [memberService.ts](../../../../../src/services/member/memberService.ts).

Доступно только в групповой беседе. Удаляет собственную анкету при наличии действующего пятиминутного запроса; при его отсутствии или истечении предлагает начать заново. Инструмент модели не может выполнить подтверждение за пользователя. Начало операции — [profile-delete](commands.md#command-profile-delete).

## command-profile-delete

### Удаление собственной анкеты

**Команда:** `/удалить профиль`; внутри обработчика нормализуется в `profile-delete`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), `requestProfileDeletion`; [memberService.ts](../../../../../src/services/member/memberService.ts).

Доступно только в групповой беседе и только для собственной заполненной анкеты. Создаёт запрос на удаление в текущей беседе со сроком пять минут; завершение выполняется отдельной [командой подтверждения](commands.md#command-profile-delete-confirm). При отсутствии анкеты операция не создаётся.

## command-profile

### /profile

**Алиас:** `/профиль`; `/анкета` без аргумента преобразуется в `profile edit`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), `profileCommand`; [memberService.ts](../../../../../src/services/member/memberService.ts).

Доступно только в групповой беседе. Без аргумента или с `show` показывает собственную анкету; `create`/`edit` открывает шаблон, `cancel` отменяет заполнение. `edit <номер> <ответ>` меняет собственный ответ, `clear <номер>` удаляет его. `/профиль @участник` и `get <ссылка>` запрашивают чужую анкету; некоторые упоминания преобразует обработчик VK. При отсутствии анкеты выводится сообщение.

`delete <VK ID>` и `edit <VK ID> <номер> <ответ>` для чужой анкеты ограничены администраторами бота и журналируются. В групповом VK-обработчике результат административного изменения отправляется администратору в ЛС, а в беседу — уведомление; доставка ЛС может завершиться ошибкой. Удаление собственной анкеты описано в [profile-delete](commands.md#command-profile-delete).

## command-profiles

### /profiles

**Алиас:** `/анкеты`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), `listMemberProfiles`.

`/profiles [страница]` перечисляет заполненные анкеты только в групповой беседе. Страница по умолчанию 1; текст не из цифр, unsafe integer и значение меньше 1 отклоняются, превышение количества страниц возвращает отдельную ошибку. Каждая страница показывает до 10 имён, полученных из ответа анкеты или VK display name; просмотр конкретного профиля — [profile](commands.md#command-profile). Прямого теста нет.

## command-questionnaire

### /questionnaire

**Тип:** команда. **Алиасы:** `/questionnaire`, `/опрос`, `/настройкаанкеты`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Только группа; общий guard требует администратора беседы или администратора бота. Без аргумента показывает `questionnaireEnabled`; принимает только `on|off`, меняет автоматическое приглашение при вступлении и пишет AdminLog. Уже открытые анкеты при выключении не отменяются. В ЛС возвращает текст о доступности только в групповой беседе. Прямого теста нет.


## command-randomjoke

### /randomjoke

**Алиас:** `/случайнаяшутка`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

`/randomjoke [тема]` передаёт `randomjoke` в [`FunService`](../fun/funService.md); пустая тема заменяется на «Случайная тема». Сервис применяет общий prompt, персональные настройки и модель, сохраняет `FunOutput`, а VK отправляет результат и клавиатуру feedback; ошибка генерации возвращается через общий обработчик команды. Публичный аргумент не ограничивается отдельной длиной в `CommandService`; прямого теста команды нет.

## command-rating

### /rating

**Алиас:** `/рейтинг`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

Генерирует шуточный рейтинг по аргументам либо стандартной просьбе о выдуманном дружеском рейтинге.

## command-react

### /react

**Алиас:** `/реакция`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

Создаёт реакцию на текст сообщения, на которое дан ответ, либо на аргумент. При наличии аргумента он также передаётся как стиль. При отсутствии обоих источников сервис просит ответить на сообщение или указать текст. Переданный текст считается недоверенным.

## command-reaction

### /reaction

**Алиас:** нет в `commandAliases`; `/реакция` является алиасом `/react`, а `/reaction` распознаётся как самостоятельное английское имя. **Источник:** ветвь `case 'reaction'` в [CommandService.executeCommand](../../../../../src/services/command/commandService.ts) и парсер [DetectorService.parseCommand](../../../../../src/services/detector/detectorService.ts).

Использует текст сообщения, на которое дан ответ, либо аргумент команды; аргумент также передаётся как стиль реакции. Без текста и ответа возвращает подсказку использовать `/reaction <сообщение>`. В отличие от `/react`, сообщение об отсутствии аргумента ссылается на `/reaction`. Переданный текст считается недоверенным. Команда проходит общий маршрут прямых команд VK; правила адресации описаны в [архитектуре](../../architecture.md).

## command-reset

### /reset

**Тип:** команда. **Алиасы:** `/reset`, `/сброс`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

`clearUserHistory(senderId, peerId)` очищает историю пользователя в текущем разговоре и возвращает число удалённых сообщений.


## command-roast

### /roast

**Алиас:** `/подкол`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

Проверяет, разрешил ли автор персональные шутки в текущем контексте. Если нет, показывает инструкцию `/funsettings jokes on`; иначе генерирует дружеский подкол по аргументам или стандартной просьбе.

## command-settings

### /settings

**Алиас:** `/настройки`. **Источник:** [CommandService.getSettings](../../../../../src/services/command/commandService.ts).

Показывает текущий личный характер, наличие личной инструкции, режим беседы, состояние личного голоса, город и часовой пояс. В группе сводка местоположения берётся из настроек беседы, в ЛС — пользователя. Метод получает настройки пользователя и чата и может создавать их через соответствующие сервисы; не меняет сами параметры по аргументам этой команды.

## command-stats

### /stats

**Алиас:** `/статистика`. **Источник:** [CommandService.getUserStats](../../../../../src/services/command/commandService.ts).

Для автора показывает число сохранённых пользовательских сообщений, число обращений к внешним сервисам по `ApiUsage` и сумму игровых очков. Если пользователь отсутствует в базе, сообщает об отсутствии статистики. Это не административная статистика всех пользователей.

## command-story

### /story

**Алиас:** `/история`. **Источник:** [CommandService.executeCommand](../../../../../src/services/command/commandService.ts).

Генерирует историю по аргументам либо стандартной теме. `continue` или `продолжи` продолжает последний результат автора в беседе, только если его тип `story`; иначе предлагает сначала создать историю.

## command-summary

### /summary

**Алиас:** `/пересказ`. **Источники:** [CommandService.summarizeConversation](../../../../../src/services/command/commandService.ts), [summaryUtils.ts](../../../../../src/services/command/summaryUtils.ts), [VkService](../../../../../src/services/vk/vkService.ts).

Текстовый аргумент распознаёт период 2 или 6 часов; при отсутствии распознанного периода обработчик использует 2 часа. Из локальной истории выбираются сообщения за этот период, текст обрезается до последних 30 000 символов и передаётся текстовому провайдеру. Ответ ограничивается десятью предложениями; пустая история даёт отдельное сообщение. Текст истории считается недоверенным.

Callback для периода содержит `command=summary` и числовое `hours`, равное 2 или 6; иной payload отклоняется парсером. Это отдельный путь от фоновой задачи [run_subagent](../ai/tools.md#run_subagent).

Обработчик callback повторно проверяет режим беседы, техническое обслуживание и rate limit, затем редактирует исходное сообщение. Полный контракт — в [разделе callback-действий](#summary-period).

## command-system

### /system

**Тип:** команда. **Алиасы:** `/system`, `/инструкция`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

В ЛС управляет личной инструкцией, в группе — инструкцией беседы. Групповой просмотр и изменение требуют администратора беседы, бота или создателя. Без аргумента показывает значение; `clear` удаляет; текст длиннее 2000 символов отклоняется; старый префикс `global` не поддерживается.


## command-timezone

### /timezone

**Алиасы:** `/часовойпояс`, `/часовой_пояс`, `/tz`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), `manageTimeZone`; [locationService.ts](../../../../../src/services/settings/locationService.ts).

Без аргумента, `show`, `status` или `показать` показывает сводку. `set <IANA>` или просто `<IANA>` устанавливает зону после проверки сервисом; `reset`, `clear`, `delete`, `сброс`, `удалить` сбрасывают её. В группе используется область беседы и изменение требует прав администратора беседы, бота или создателя; в ЛС используется область автора. Неверная зона или ошибка возвращаются пользователю. Связанный город — в [city](commands.md#command-city).

## command-translate

### /translate

**Алиас:** `/перевод`. **Источник:** [parseTranslationRequest и CommandService.translate](../../../../../src/services/command/commandService.ts).

`/translate <текст>` переводит на русский; `/translate <язык>: <текст>` задаёт целевой язык. Если аргументов нет, но команда отвечает на текст сообщения, сервис запрашивает перевод нерусских фрагментов на русский с сохранением русского текста. Без текста и ответа возвращается подсказка. Перевод выполняет текстовый провайдер; инструкция запрещает исполнять команды внутри переводимого текста.

## command-users

### /users

**Алиас:** `/пользователи`. **Источник:** [CommandService.getAdminStats](../../../../../src/services/command/commandService.ts).

Требует администратора бота. Показывает количество пользователей, бесед, активных бесед за последние 24 часа, сообщений и записей использования API, а также сумму оценочной стоимости, если она есть. Запрос без прав отклоняется общей проверкой административных команд.

## command-voice

### /voice

**Тип:** команда. **Алиасы:** `/voice`, `/голос`, `/voise`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Управляет личными настройками; проверяет `VOICE_ENABLED` и `OPENAI_API_KEY`. Без аргумента показывает состояние, `on`/`off` переключает, имя из `availableVoices` выбирает голос. Неверный аргумент показывает список; значение по умолчанию для отображения — `coral`.


## command-welcome

### /welcome

**Тип:** команда. **Алиасы:** `/welcome`, `/приветствие`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts), [commandAliases.ts](../../../../../src/services/command/commandAliases.ts).

Администратор беседы или бота; только группа. Без аргумента показывает состояние и текст, `on`/`off` переключает, `set <текст>` сохраняет до 1000 символов с поддержкой `{name}`; изменения журналируются. В ЛС сообщает, что нужна группа.


## command-adventure

### /adventure

**Алиас:** `/приключение`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

`start [detective|survival|fantasy|horror|scifi|pirates|time|comedy|random]` запускает приключение; при `start` без жанра используется `fantasy`. `help`, `rules`, `my`, `list`, `join`, `leave`, `continue`, `status`, `pause`, `resume`, `restart`, `end`, `abort`, `settings`, `character`, `inventory`, `journal`, `map`, `hint`, `save`, `vote` направляются игровому сервису. Отдельные короткие команды `look`, `inspect`, `talk`, `use`, `status`, `vote`, `journal`, `map`, `hint`, `inventory` также сопоставляются маршрутом VK.

Права, состояние и допустимые значения настроек описаны в [adventureService](../games/adventureService.md); например, настройки и завершение меняет ведущий, а `join` доступен в активной групповой игре до восьми участников. [Короткие команды](commands.md) вынесены отдельно. Их конкуренция с другими обработчиками ещё требует полной проверки.

## command-hint

### /hint

**Алиас:** `/подсказка`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Требует участия и включённых подсказок; запрашивает одну подсказку у текстового ИИ и учитывает использование.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `hint <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-inspect

### /inspect

**Алиас:** `/изучить`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Требует название объекта в аргументе и участие в приключении; пустая цель возвращает подсказку.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `inspect <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-inventory

### /inventory

**Алиас:** `/инвентарь`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Показывает инвентарь игрока. Требуется участие в текущем приключении; без него возвращается отказ.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `inventory <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-journal

### /journal

**Алиас:** `/журналприключения`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Показывает до 20 последних записей журнала. При отсутствии активного приключения участник может получить журнал последней завершённой сессии.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `journal <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-look

### /look

**Алиас:** `/осмотреть`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Передаёт действие осмотра текущей локации. Требуется участие в приключении.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `look <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-map

### /map

**Алиас:** `/карта`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Показывает посещённые места или текущую локацию; требуется участие в приключении.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `map <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-memeday

### /memeday

**Алиас:** `/мемдня`. **Источники:** [VkService.handleMemeDayCommand](../../../../../src/services/vk/vkService.ts), [memeDayService](../fun/memeDayService.md).

`on|off` и `settings` разрешены только в группе администратору беседы или бота. Параметры `settings`: `time ЧЧ:ММ`, `timezone <IANA>`, `weekly on|off`, `style auto|comic|realistic|cartoon|absurd|classic`, `participants on|off`, `participant-frequency 0–100`, `intensity 0–100`, `quotes on|off`, `manual on|off`, `voting on|off`, `night on|off`, `active-hours 1–168`, `exclude add|remove <участник>`. Ночное время с 22:00 до 08:00 запрещено, если `night` выключен. Список исключённых содержит не более 100 числовых ID.

`history`, `top`, `random`, `week` и пустая команда показывают опубликованные результаты текущего диалога. `history` по умолчанию возвращает до пяти последних, `top` — до пяти по рейтингу. `now`, `all`, `user [участник]` запускают ручную генерацию; `all` и `user` требуют группу, `manualEnabled` должен быть включён. Для неадминистратора бота обработчик проверяет `imageAccess=all`; текст отказа упоминает администраторов беседы, но показанная проверка использует `isAdmin`. Лимит — менее трёх ручных записей `generating`/`published` за час в беседе. `user` дополнительно требует разрешённые персональные мемы и подходящего участника. Ошибочная ручная генерация удаляет запись `generating`; если идея не найдена, запись помечается `skipped`.

Настройки по умолчанию, обработка расписания и голосования — в [memeDayService](../fun/memeDayService.md).

Кнопки публикации используют callback `meme_vote`; проверка текущей беседы и опубликованного статуса, повторное голосование и оценка описаны в [разделе callback-действий](#meme-vote).

## command-status

### /status

**Алиас:** `/статус`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Показывает название, ход, локацию, участников и здоровье; для survival также голод, жажду и энергию. Требуется участие.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `status <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-talk

### /talk

**Алиас:** `/поговорить`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Требует имя персонажа или цель в аргументе и участие; пустая цель возвращает подсказку.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `talk <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-use

### /use

**Алиас:** `/использовать`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Требует название предмета и участие; перед ходом сервис проверяет наличие предмета в инвентаре и сообщает, если его нет.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `use <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-vote

### /vote

**Алиас:** `/голосовать`. **Источники:** [VkService](../../../../../src/services/vk/vkService.ts), [AdventureService.handleCommand](../../../../../src/services/games/adventureService.ts).

Передаёт голос или действие согласования в зависимости от режима. Аргумент end запрашивает досрочное завершение голосования; точные проверки и подсчёт реализованы игровым сервисом.

Маршрутизатор проверяет точное имя из `adventureCommands`, превращает его в `vote <args>` и направляет в `AdventureService` после специальных media/fun routes, до generic `CommandService`. Ошибка сервиса логируется и отвечает общим сообщением о команде приключения. Остальные фазы, права и ошибки действия — в [AdventureService](../games/adventureService.md). Прямого теста маршрута нет.

## command-image

### /image

**Алиас:** `/изображение`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts), [imageGenerationService](../image/imageGenerationService.md).

`/image <описание>` создаёт изображение. Команда распознаётся отдельным парсером до обычного маршрута. Пустое описание возвращает подсказку; неадминистратор бота допускается при `chatSettings.imageAccess=all`. Перед запросом подсчитываются операции `image_generate` и `image_edit` пользователя с начала суток UTC и проверяется `IMAGE_MAX_PER_USER_PER_DAY`. Успешный результат отправляется фото в текущий диалог и учитывается в `ApiUsage`. Ошибки модерации, доступа VK и генерации сообщаются отдельно.

## command-edit

### /edit

**Алиас:** `/преобразить`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts), [imageGenerationService](../image/imageGenerationService.md).

`/edit <описание>` редактирует фотографию, приложенную к текущему сообщению или доступную из ответа. Проверки описания, доступа и дневного лимита совпадают с [image](#command-image). Без фотографии возвращается просьба её приложить; успешная отправка учитывается как `image_edit`.

## command-analyze

### /analyze

**Алиас:** `/анализ`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts).

`/analyze <вопрос>` анализирует фотографию либо, если фото нет, документ текущего сообщения или ответа. Неадминистратору бота требуется `imageAccess=all`. Фото направляется в [imageAnalysisService](../image/imageAnalysisService.md), документ — в [documentAnalysisService](../document/documentAnalysisService.md); успешный вызов учитывается и ответ отправляется в диалог. При отсутствии вложения или ошибке обработки возвращается сообщение пользователю.

## command-ocr

### /ocr

**Алиас:** `/распознатьтекст`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts).

Распознаёт текст только на фотографии и вызывает `imageAnalysisService.analyze` с OCR-режимом. Права проверяются так же, как у [analyze](#command-analyze). Если фото нет, предлагает использовать `/document` для документа; ошибка обработки возвращает общее сообщение о вложении.

## command-document

### /document

**Алиас:** `/документ`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts).

`/document <вопрос>` направляет документ в [documentAnalysisService](../document/documentAnalysisService.md), соблюдая проверку доступа как у [analyze](#command-analyze). При наличии фото ветвь предлагает использовать `/analyze` или `/ocr`; при отсутствии вложения просит приложить документ. Ограничения типов и размера определяет сервис.

## command-meme

### /meme

**Алиас:** `/мем`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts), [memeService.ts](../../../../../src/services/fun/memeService.ts).

Генерирует мем по аргументам, при наличии фото предварительно скачивает его и запрашивает нейтральное описание. Неадминистратору бота требуется `imageAccess=all`. Успешная генерация отправляет фото с клавиатурой обратной связи; ошибка возвращает сообщение о недоступности генерации. Это отдельная команда от [memeday](#command-memeday).

## command-say

### /say

**Алиас:** `/озвучить`. **Источник:** [VkService.runBotCommand](../../../../../src/services/vk/vkService.ts), [voiceService](../voice/voiceService.md).

`/say <текст>` синтезирует речь; в беседе без аргумента может использовать текст сообщения, на которое дан ответ. Нужны `VOICE_ENABLED=true` и `OPENAI_API_KEY`, максимальная длина — 4096 единиц длины JavaScript. В группе дополнительно проверяется ограничение частоты. Сервис берёт выбранный пользователем голос или `coral`, отправляет текст с аудиовложением и учитывает `voice_say`. При ошибке синтеза или загрузки отправляет текст с уведомлением об ошибке; без текста возвращает подсказку.

## Интерактивные callback-действия

Это payload inline-кнопок VK, а не текстовые команды. Действия принимаются `message_event`-обработчиком в [VkService](../vk/vkService.md) ([реализация](../../../../../src/services/vk/vkService.ts)); клавиатуры создаёт [SenderService](../sender/senderService.md) ([реализация](../../../../../src/services/sender/senderService.ts)). `parseEventPayload` принимает объект либо JSON-строку, но игнорирует массивы и некорректный JSON. В `src/` обнаружены шесть значений поля `command`.

Исключение по маршруту — `summary`: кроме `message_event`, это действие распознаётся из `message_new.context.messagePayload` и переводится в обычное выполнение команды `/summary`.

### menu-page

**Payload:** `{ command: 'menu_page', menu: 'help' | 'admin', page: number, hasContinuations?: boolean }`. Кнопки создаются для соседней страницы меню; `/help` доступна всем, `/admin` только администраторам бота. Обработчик проверяет значение `menu`, безопасное целое `page >= 1` и право администратора для `admin`, затем повторно вызывает соответствующую команду. Верхняя граница страницы проверяется уже `helpText`/`adminCommand`; неверная страница показывается как snackbar, исходное сообщение не редактируется. Успешный переход редактирует сообщение с клавиатурой; в личном диалоге продолжение или длинный текст может отправиться отдельным сообщением. Ошибки перехода логируются и возвращают snackbar. В этой ветви отдельно не выполняются проверки `quiet`, `maintenance` и rate limit.

### personality-select

**Payload:** `{ command: 'personality_select', scope: 'direct' | 'chat', id: string }`. В клавиатуру помещаются первые 20 профилей; кнопка показывает выбранный профиль цветом, длинное имя сокращается. Обработчик сверяет `scope` с типом peer. Для группы повторно проверяет maintenance, права администратора беседы/бота, настройку разрешения всем участникам и `quiet`; для неадминистратора также применяется rate limit. Затем `characterService.select` проверяет профиль и сохраняет выбор. В группе бот отправляет сообщение о новом персонаже; в обоих контекстах отвечает snackbar. Ошибка БД не раскрывается в snackbar, остальные сообщения об ошибке ограничиваются 100 символами. Права выбора в ЛС отдельно не ограничиваются ролью администратора.

Источники проверок выбора: [`handlePersonalitySelection`](../../../../../src/services/vk/vkService.ts) и [`CharacterService.select`](../../../../../src/services/settings/characterService.ts).

### summary-period

**Payload:** `{ command: 'summary', hours: 2 | 6, hasContinuations: boolean }`. [`getSummaryHoursFromPayload`](../../../../../src/services/command/summaryUtils.ts) принимает только `hours`, строго равный числу `2` или `6`; некорректный payload не попадает в summary-ветку и беззвучно передаётся дальше через `next()`. Для корректного payload обработчик проверяет `quiet` и maintenance (доступ администраторам бота), применяет пользовательский rate limit, обновляет недостающие имена авторов, заново строит пересказ и редактирует сообщение callback-события. Ошибка отвечает snackbar и записывается в журнал. При редактировании в личном диалоге длинный ответ или ответ с продолжениями может быть вынесен отдельной отправкой; состояние кнопок периода и возможность продолжения формируются заново.

В `message_new` такой же payload из `context.messagePayload` выбирает команду `summary` и передаёт `hours` как аргумент `runBotCommand`; далее используются общие для прямой команды проверки режима/maintenance и доставка с клавиатурой. В этом маршруте нет callback-snackbar и редактирования исходного сообщения.

### meme-vote

**Payload:** `{ command: 'meme_vote', publicationId: string, value: 'laugh' | 'fire' | 'neutral' | 'dislike' }`. Обработчик проверяет тип ID и допустимое значение, затем проверяет настройку `votingEnabled`. `memeDayService.vote` принимает только опубликованную запись с этим ID в текущем `peerId`; upsert заменяет прежний голос того же пользователя. Рейтинг: `fire` +2, `laugh` +1, `neutral` 0, `dislike` −1. Snackbar сообщает, что голос учтён, голосование выключено, публикация не найдена либо произошла ошибка. В этой callback-ветви явно не проверяются maintenance, режим `quiet` и rate limit.

Реализация записи и пересчёта: [`MemeDayService.vote`](../../../../../src/services/fun/memeDayService.ts).

### fun-feedback-and-fun-again

Обе кнопки содержат `{ command, outputId }`; оценка дополнительно содержит `value: 'laugh' | 'neutral' | 'fire'`. Они добавляются к успешно отправленным результатам `randomjoke`, `joke`, `prediction`, `react`, `reaction`, `roast`, `rating`, `story` и `meme`.

- `fun_feedback` проверяет строковый `outputId` и перечисление `value`, затем сохраняет/заменяет оценку пользователя. `FunService.saveFeedback` подтверждает, что результат существует в текущем диалоге, но не проверяет, что результат принадлежит голосующему; ключ голосования — пара `outputId` и `vkUserId`. Успех подтверждается snackbar.
- `fun_again` получает последний результат именно этого пользователя в текущем диалоге и продолжает только при совпадении его ID с payload. Для мемов повторно вызывает генератор мемов с просьбой о новой идее; для остальных типов вызывает `FunService.generate` с просьбой отличаться от предыдущего результата. Новый результат отправляется отдельным сообщением с новой клавиатурой. Устаревшая кнопка получает snackbar об отказе; ошибки логируются и возвращают общий snackbar.

Оба действия реализованы в [`message_event`](../../../../../src/services/vk/vkService.ts); сохранение оценки и поиск последнего результата — в [`FunService`](../../../../../src/services/fun/funService.ts), повторная генерация мема — в [`MemeService`](../../../../../src/services/fun/memeService.ts).

Эти ветви `message_event` не содержат явных проверок `quiet`, maintenance или rate limit. Проверки привязки к беседе выполняются сервисами; запуск `fun_again` дополнительно привязан к последнему результату пользователя.
