# Игры и приключения

Снимок: 2026-11-16, `2dbb190` с незакоммиченными изменениями. Source-level описание охватывает запуск и переходы раундовых игр, действия участников, подсчёт/статистику, мафию, приключение, локальные locks и вызовы через модель. Состояние сессии хранится в `GameSession.data`, события и счёт — в связанных моделях [Prisma](../../../../../prisma/schema.prisma). Прямых игровых unit tests в `test/` нет; код и runtime не запускались при составлении документации.


## Описание по модулям

- [mafiaEngine](mafiaEngine.md) — правила ролей, голосования и ночных действий.

- [gameSessionLock](gameSessionLock.md)
- [riddleGeneration](riddleGeneration.md)

- [gameEngine](gameEngine.md)
- [gameService](gameService.md) — сессии раундовых игр, дедупликация и счёт.
- [mafiaService](mafiaService.md)
- [adventureService](adventureService.md)
- [gameInteractionService](gameInteractionService.md)
