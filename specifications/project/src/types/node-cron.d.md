# Декларация `node-cron`

**Тип сущности:** ambient TypeScript declaration. **Runtime identity:** `declare module 'node-cron'`; экспорты `ScheduleOptions`, `ScheduledTask`, `schedule`, `getTasks` и default `cron`. **Источник:** [`src/types/node-cron.d.ts`](../../../../src/types/node-cron.d.ts).

## Объявленный контракт

- `ScheduleOptions` объявляет необязательные `scheduled`, `timezone`, `name`, `runOnInit`.
- `ScheduledTask` объявляет синхронные методы `start()`, `stop()` и `destroy()`.
- `schedule(expression, task, options?)` принимает строковое cron-выражение, callback `() => void | Promise<void>` и необязательные options; возвращаемый тип — `ScheduledTask`.
- `getTasks()` возвращает `Map<string, ScheduledTask>`.
- Default export `cron` содержит те же `schedule` и `getTasks`.

Это compile-time описание API, используемое типизатором проекта. Декларация не загружает библиотеку, не проверяет cron-выражение и не определяет фактическое поведение часового пояса, повторов или остановки задачи. Runtime-сценарии описаны в [спецификациях jobs](../jobs/README.md) и [scheduler](../jobs/scheduler.md). Отдельных тестов на ambient declaration нет.

