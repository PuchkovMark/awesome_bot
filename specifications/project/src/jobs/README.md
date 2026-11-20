# Фоновые задания

Снимок: 2026-11-16, `2dbb190` и текущее незакоммиченное дерево. Содержание получено статическим чтением исходников и сервисов; бот и база не запускались.

## Состав каталога

Инкремент R08, 20.11.2026: [gameTimeoutJob](gameTimeoutJob.md#доставка-и-ошибки) независимо получает/публикует результаты двух семейств, [adventureVoteJob](adventureVoteJob.md#публикация-и-сбои) изолирует ошибки publish без image-fallback в callback VkService. Автоматического retry нет; сохранённые результаты доступны через read-команды. Перечень и расписания jobs не изменились; сверка статическая, исторический полный снимок выше сохранён.

| Сущность | Тип и точка входа | Спецификация |
| --- | --- | --- |
| `cleanupJob` | Job, `startCleanupJob` | [cleanupJob.md](cleanupJob.md) |
| `gameTimeoutJob` | Job, `startGameTimeoutJob` | [gameTimeoutJob.md](gameTimeoutJob.md) |
| `adventureVoteJob` | Job, `startAdventureVoteJob` | [adventureVoteJob.md](adventureVoteJob.md) |
| `memeDayJob` | Job/schedule helper, `startMemeDayJob`, `getMemeDaySchedule` | [memeDayJob.md](memeDayJob.md) |
| `reminderJob` | Job, `startReminderJob` | [reminderJob.md](reminderJob.md) |
| `longTermMemoryJob` | Job, `startLongTermMemoryJob` | [longTermMemoryJob.md](longTermMemoryJob.md) |
| `subagentDeliveryJob` | Job, `startSubagentDeliveryJob` | [subagentDeliveryJob.md](subagentDeliveryJob.md) |
| `scheduler` | Реестр, shutdown helpers | [scheduler.md](scheduler.md) |

## Регистрация и расписания

| Задание | Расписание и место регистрации |
| --- | --- |
| [Очистка](cleanupJob.md) | `*/60 * * * *`, `bootstrap.ts` после запуска VK |
| [Игровые таймеры](gameTimeoutJob.md) | `*/10 * * * * *`, `bootstrap.ts` после запуска VK |
| [Голосования приключения](adventureVoteJob.md) | `* * * * *`, `VkService.start()` |
| [Мем дня](memeDayJob.md) | `* * * * *`, `VkService.start()` |
| [Напоминания](reminderJob.md) | `* * * * *`, `VkService.start()` |
| [Долговременная память](longTermMemoryJob.md) | `15 3 * * *`, `VkService.start()` |
| [Доставка субагентов](subagentDeliveryJob.md) | Начальный проход и `* * * * *`, `VkService.start()` |

Зона cron нигде явно не передаётся, следовательно расписания используют зону процесса. `memeDayJob` отдельно вычисляет локальное время каждой беседы. Локальные флаги `running` у отдельных jobs предотвращают пересечение только в одном процессе; где доступно, service-level условные updates/уникальные ключи дополнительно защищают сохранённые записи.

Порядок регистрации, завершения и ограничения остановки описаны в [scheduler.md](scheduler.md). Отбор данных и реакции на ошибки указаны в спецификации каждого job и связанного сервиса. В `test/` найдены тесты сервисов субагентов, но отдельные cron-wrapper тесты отсутствуют; карта тестовых утверждений находится в [test evidence](../../test/README.md).
