# `GameInteractionService`

**Тип:** adapter для `play_game`, который резолвит выбранную сессию и делегирует действие игровому сервису. **Источник:** [gameInteractionService.ts](../../../../../src/services/games/gameInteractionService.ts); схема AI-инструмента — [interactionTools](../ai/tools.md#play_game). Экспорты: `gameFamilies`, `gameActions`, request/context/result типы, `GameInteractionService.handle`, singleton `gameInteractionService`.

## Публичный контракт и поиск

Families: `current`, `standard`, `mafia`, `adventure`, `battle`. Actions: `inspect`, `start`, `answer`, `join`, `leave`, `hint`, `repeat`, `pause`, `resume`, `stop`, `skip`, `next`, `score`, `pass`, `vote`, `difficulty`, `status`, `command`. Context берёт peer/user/chat/roles/display name/event ID и resolver имён из вызывающей стороны. Result: `info`, `result`, `not_executed`, `uncertain`, плюс исходный `AdventureResult`, если он есть.

Перед действием загружаются сессии текущего peer из контекста для всех ключей `gameModes` (включая mafia) и `ai_adventure`/`fun_battle` со статусами `waiting|active|paused|round_complete`, newest-first. Этот локальный список `sessions` отличается от поиска личного ночного действия мафии в исходных беседах пользователя. ID беседы внутри `value` фильтрует партии мафии, но не заменяет текущий peer, автора или `eventId`, полученные от приложения.

`inspect` возвращает `info` со списком локальных игр и в ЛС сообщает наличие доступного ночного действия по булевому результату `hasPendingPrivateAction`. Для этого признака нужны ночь и живой участник с ненулевой ролью кроме `villager`; он не выбирает партию, не сообщает роль и не проверяет конкретный текст хода или то, был ли ход уже отправлен.

Для `answer`, `vote`, `command` значение `value.trim()` проверяется на пустоту до личной маршрутизации; пустое значение отклоняется. `textResult(null)` возвращает `uncertain`: движок мог уже записать действие, повторять его автоматически нельзя.

## Запуск

`start/current` всегда просит уточнить игру. `start/standard` принимает первый token только если он разбирается как не-mafia `GameKind`, затем передаёт `start <value>` в `GameService`. `start/mafia` делегирует `mafia start <value>`; ограничения группы/ролей применяет MafiaService. `start/adventure` проверяет genre (`random` или один из `adventureGenres`, default random) и вызывает AdventureService. Оставшееся семейство запускается как `battle start <value>` через CommandService. Ветвь standard требует значение вида игры после `start`; default игры сама не подставляет.

## Разрешение текущей игры и дедупликация

Специальная личная ветвь выполняется только при `isChat=false`, `game=current|mafia`, `action=answer|vote|command` и положительном `MafiaService.shouldHandleMessage`. Эта проверка учитывает текст, указанный ID беседы, участие, живую роль и ночную фазу, но ещё не допустимость конкретной цели. Порядок выбора family и партии:

- `game=current` и хотя бы одна локальная сессия — `not_executed` с просьбой выбрать игру, до вызова приватного обработчика. Учитывается весь найденный локальный список, включая ожидающие и приостановленные игры. Префикс `беседа <ID>` или `чат <ID>` в тексте не отменяет этот конфликт family.
- Явное `game=mafia` — личная игра не мешает делегированию ночного хода. Внутри мафии остаётся отдельный выбор партии: несколько подходящих ночных сессий требуют ID исходной беседы в `value`, первая сессия не выбирается. Синтаксис, отбор и повторные проверки описаны в [контракте ночного действия](mafiaService.md#обсуждение-голосование-и-ночь).
- Явное `game=standard` пропускает специальную личную ветвь мафии и сохраняется при обычной фильтрации локальных сессий; оно не подменяется на `current` или `mafia`.

При делегировании в личной ветви все три действия (`answer`, `vote`, `command`) передают исходный `value` после `trim()` в `MafiaService.handleNaturalMessage`; дневное `голосую за ...` не добавляется. Любая возвращённая строка, в том числе уточнение о нескольких партиях или текст отказа, преобразуется в `status=result`: этот статус сам по себе не доказывает запись хода. `null`, например после повторного чтения или распознавания повторного события, преобразуется в `uncertain` без автоматического повтора, а не в гарантию отсутствия побочных эффектов.

Если `shouldHandleMessage=false` или условия специальной ветви не выполнены, по `request.game` фильтруются обычные локальные сессии: `current` принимает все; `standard`, `mafia`, `adventure`, `battle` сопоставляются по game family. Ноль или больше одной сессии приводит к `not_executed` и сообщению об отсутствии/неоднозначности; одна — к делегированию выбранному семейству. Поэтому нераспознанный ночной текст или чужой ID при `current` могут попасть в существующую личную игру по её правилам; это не безусловный отдельный отказ всего адаптера от мафии.

Перед передачей `adventure` и `battle` при наличии event ID создаётся `GameEvent(sessionId,eventId)` с kind `ai-<family>`. Unique conflict блокирует повтор. Эта запись выполняется до вызова сервиса и вне его сохранения состояния; если downstream ответит ошибкой или `null`, event остаётся и повторный запрос отклоняется.

## Матрица делегирования

| Семейство | Действие | Делегирование и оговорки |
| --- | --- | --- |
| `standard` | `answer`, `vote` | Текст напрямую передаётся `GameService.handleNaturalMessage` с `isReplyToBot=true`. |
| `standard` | `command` | Текст напрямую передаётся `GameService.handleCommand`. |
| `standard` | `join/hint/repeat/pause/resume/stop/skip/next/score/pass/status` | Преобразуются в естественные команды. `status` намеренно отображает score; difficulty требует `1–4` и преобразуется в естественный запрос на смену уровня. Остальные неподдерживаемые пары возвращают `not_executed`. |
| `mafia` | `answer`, `vote` | Вызывает `handleNaturalMessage`; в обычной ветви vote преобразуется в `голосую за <value>`, в личной ночной ветви оба действия передают `value` после `trim()` без добавления префикса. |
| `mafia` | `join/leave/pause/resume/stop/status/score/difficulty/command` | В обычной ветви формирует `mafia <command>`; score отображает статус, difficulty — аргумент. Личная ночная ветвь для `command` передаёт `value` после `trim()` напрямую в `handleNaturalMessage`. `hint/repeat/skip/next/pass` для mafia не поддержаны. |
| `adventure` | `answer` | Вызывает `submitAction`; `null` означает `not_executed`, иначе сохраняет текстовый и структурированный `AdventureResult`. |
| `adventure` | `join/leave/hint/pause/resume/stop/status/vote/difficulty/command` | Преобразуется в аргумент AdventureService (`stop` → `end`, difficulty → `settings сложность <value>`). Другие actions не поддерживаются. |
| `battle` | `answer/join/stop/score/status/command` | Преобразуется в `/battle submit|join|stop|score`; `status` совпадает со score. `vote`, difficulty и прочие actions не поддерживаются. |

Для вложенных `AdventureResult` возвращается `status=result` независимо от содержания ответа; structured result передаётся дальше для image delivery. Доступные права и event ID передаются в стандартные/mafia service options; AdventureService получает только peer/user/displayName/isChat и сам проверяет свои роли. Тестовые сценарии `play_game` перечислены в [каталоге инструментов](../ai/tools.md#play_game); прямого теста `GameInteractionService` нет.
