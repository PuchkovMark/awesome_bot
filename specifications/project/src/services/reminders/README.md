# Напоминания

Основано на статическом чтении [reminderService.ts](../../../../../src/services/reminders/reminderService.ts), [reminderParser.ts](../../../../../src/services/reminders/reminderParser.ts), [reminderDateTime.ts](../../../../../src/services/reminders/reminderDateTime.ts) и [reminderJob.ts](../../../../../src/jobs/reminderJob.ts). Документы покрывают все exports парсера и календарных helpers, варианты даты/времени/повторов, диалог, права управления, состояния и попытки доставки. В `test/` нет прямых тестов этих контрактов; это отражено как ограничение свидетельств.


## Описание по модулям

- [reminderService](reminderService.md)
- [reminderDateTime](reminderDateTime.md)
- [reminderParser](reminderParser.md) — даты, время, повторения и намерение.
