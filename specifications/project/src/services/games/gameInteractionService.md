# `GameInteractionService`

**Тип:** adapter для `play_game`, который резолвит выбранную сессию и делегирует действие игровому сервису. **Источник:** [gameInteractionService.ts](../../../../../src/services/games/gameInteractionService.ts); схема AI-инструмента — [interactionTools](../ai/tools.md#play_game). Экспорты: `gameFamilies`, `gameActions`, request/context/result типы, `GameInteractionService.handle`, singleton `gameInteractionService`.

## Публичный контракт и поиск

Families: `current`, `standard`, `mafia`, `adventure`, `battle`. Actions: `inspect`, `start`, `answer`, `join`, `leave`, `hint`, `repeat`, `pause`, `resume`, `stop`, `skip`, `next`, `score`, `pass`, `vote`, `difficulty`, `status`, `command`. Context берёт peer/user/chat/roles/display name/event ID и resolver имён из вызывающей стороны. Result: `info`, `result`, `not_executed`, `uncertain`, плюс исходный `AdventureResult`, если он есть.

Перед действием загружаются сессии текущей беседы для всех ключей `gameModes` (включая mafia) и `ai_adventure`/`fun_battle` со статусами `waiting|active|paused|round_complete`, newest-first. `inspect` возвращает найденные игры и в личном peer отдельно проверяет, есть ли у пользователя доступное ночное действие мафии. Для `answer`, `vote`, `command` пустой `value` отклоняется. `textResult(null)` возвращает `uncertain`: движок мог уже записать действие, повторять его автоматически нельзя.

## Запуск

`start/current` всегда просит уточнить игру. `start/standard` принимает первый token только если он разбирается как не-mafia `GameKind`, затем передаёт `start <value>` в `GameService`. `start/mafia` делегирует `mafia start <value>`; ограничения группы/ролей применяет MafiaService. `start/adventure` проверяет genre (`random` или один из `adventureGenres`, default random) и вызывает AdventureService. Оставшееся семейство запускается как `battle start <value>` через CommandService. Ветвь standard требует значение вида игры после `start`; default игры сама не подставляет.

## Разрешение текущей игры и дедупликация

Для personal-peer действий `current|mafia` типа `answer|vote|command` сервис сначала спрашивает MafiaService, является ли текст валидным ночным действием пользователя. Если такой ход найден, `current` при наличии хотя бы одной перечисленной личной сессии просит выбрать игру; иначе действие обрабатывается мафией. Затем по `request.game` фильтруются обычные сессии: `current` принимает все; `standard`, `mafia`, `adventure`, `battle` сопоставляются по game family. Ноль или больше одной сессии приводит к `not_executed` и сообщению об отсутствии/неоднозначности.

Перед передачей `adventure` и `battle` при наличии event ID создаётся `GameEvent(sessionId,eventId)` с kind `ai-<family>`. Unique conflict блокирует повтор. Эта запись выполняется до вызова сервиса и вне его сохранения состояния; если downstream ответит ошибкой или `null`, event остаётся и повторный запрос отклоняется.

## Матрица делегирования

| Семейство | Действие | Делегирование и оговорки |
| --- | --- | --- |
| `standard` | `answer`, `vote` | Текст напрямую передаётся `GameService.handleNaturalMessage` с `isReplyToBot=true`. |
| `standard` | `command` | Текст напрямую передаётся `GameService.handleCommand`. |
| `standard` | `join/hint/repeat/pause/resume/stop/skip/next/score/pass/status` | Преобразуются в естественные команды. `status` намеренно отображает score; difficulty требует `1–4` и преобразуется в естественный запрос на смену уровня. Остальные неподдерживаемые пары возвращают `not_executed`. |
| `mafia` | `answer`, `vote` | Вызывает `handleNaturalMessage`; vote преобразуется в `голосую за <value>`. |
| `mafia` | `join/leave/pause/resume/stop/status/score/difficulty/command` | Формирует `mafia <command>`; score отображает статус, difficulty — аргумент. `hint/repeat/skip/next/pass` для mafia не поддержаны. |
| `adventure` | `answer` | Вызывает `submitAction`; `null` означает `not_executed`, иначе сохраняет текстовый и структурированный `AdventureResult`. |
| `adventure` | `join/leave/hint/pause/resume/stop/status/vote/difficulty/command` | Преобразуется в аргумент AdventureService (`stop` → `end`, difficulty → `settings сложность <value>`). Другие actions не поддерживаются. |
| `battle` | `answer/join/stop/score/status/command` | Преобразуется в `/battle submit|join|stop|score`; `status` совпадает со score. `vote`, difficulty и прочие actions не поддерживаются. |

Для вложенных `AdventureResult` возвращается `status=result` независимо от содержания ответа; structured result передаётся дальше для image delivery. Доступные права и event ID передаются в стандартные/mafia service options; AdventureService получает только peer/user/displayName/isChat и сам проверяет свои роли. Тестовые сценарии `play_game` перечислены в [каталоге инструментов](../ai/tools.md#play_game); прямого теста `GameInteractionService` нет.
