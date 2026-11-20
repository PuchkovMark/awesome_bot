# Bootstrap

**Тип сущности:** entry point и lifecycle coordinator приложения. **Runtime identity:** side-effect module `src/bootstrap.ts`; верхнеуровневая `main()` не экспортируется. **Источник:** [bootstrap.ts](../../../src/bootstrap.ts). При импорте регистрируются одноразовые `SIGINT` и `SIGTERM` handlers и сразу запускается `main()` без ожидания из вызывающего кода.

## Последовательность запуска

1. Пишет `Starting bootstrap` и вызывает [`connectDb`](db/client.md). Ошибка подключения попадает в общий startup catch.
2. Вызывает `logScheduledTasksOnStartup()` до регистрации заданий. Непустой глобальный реестр `node-cron` только логируется как предупреждение; bootstrap не очищает его.
3. Вызывает `subagentService.dropInterruptedJobs()`, затем `countActiveJobs()`. Если активные jobs остаются, пишет warning; иначе пишет итог cleanup. Наличие активных jobs само по себе запуск не отменяет.
4. Вызывает `vkService.start()`. При наличии `VK_TOKEN` тот запускает VK Long Poll и регистрирует пять VK-bound jobs: meme day, adventure vote, reminders, long-term memory и subagent result delivery. Если `VK_TOKEN` отсутствует, `VkService.start()` предупреждает и возвращается; bootstrap всё равно продолжает следующий шаг.
5. Регистрирует `cleanupJob` с периодом 60 минут и `gameTimeoutJob`, пишет `Bot <BOT_NAME> is running`.

Итого две jobs регистрируются bootstrap, пять — `VkService.start()`. Подробные cron expression, guards, DB claims и ошибки принадлежат [каталогу jobs](jobs/README.md); запуск VK и фактические tool/message routes — [VkService](services/vk/vkService.md). Стартовые команды и миграции описаны в [operations](../operations.md).

Любая необработанная startup ошибка журналируется как `Bootstrap failed` и завершает процесс с кодом 1. Startup catch не выполняет общий shutdown и не вызывает `$disconnect`; завершение оставлено `process.exit(1)`. После `vkService.start()` вернувшегося без токена обе bootstrap jobs всё равно активируются.

## Сигналы и завершение

При загрузке модуля ставятся `process.once` listeners только на `SIGINT` и `SIGTERM`. `shutdown(signal)` защищён process-local latch, поэтому повторный сигнал после начала shutdown игнорируется. В штатной последовательности:

1. логирует запрос;
2. вызывает `stopAllScheduledTasks()` и получает число снятых записей cron;
3. вызывает `subagentService.stop()`, ожидает отмены и завершения прямых операций через `directSubagentService.stop()`, затем ожидает `vkService.stop()`;
4. вызывает `dropInterruptedJobs()` и пересчитывает активные jobs, записывая warning, если такие остались;
5. журналирует результат shutdown cleanup;
6. в `finally` пытается отключить Prisma и вызывает `process.exit(0)`.

Одна общая ошибка в stop/drop/count sequence логируется и пропускает оставшиеся действия внутри `try`; `finally` всё равно пытается отключить Prisma и завершает процесс с кодом 0. Ошибка `$disconnect` также только логируется. `stopAllScheduledTasks` останавливает новые cron ticks, но активные async callbacks явно не drain-ятся; процесс завершает их принудительно. Shutdown не имеет отдельного timeout или сигнального повторного ожидания.

## Зависимости, состояние и проверка

Bootstrap зависит от AppConfig, Prisma lifecycle, structured logger, VK service, subagent recovery и двух локально зарегистрированных jobs. Создаваемое состояние — глобальный cron registry, VK Long Poll handlers и persisted cleanup/status updates субагентов. Startup/shutdown защиты (`shuttingDown`) существуют только в текущем процессе.

Отдельного теста entrypoint, порядка сигналов, отказа startup или реального process shutdown в `test/` нет. `scheduler.ts` тестами также не покрыт; его границы отражены в [карте тестов](../test/README.md) и [спецификации scheduler](jobs/scheduler.md). Тесты и внешние сервисы не запускались.

## Карта изменений

| Изменение | Читать |
| --- | --- |
| Startup config/БД/отказ | этот файл, [конфигурация](config/index.md), [DB client](db/client.md), [operations](../operations.md) |
| Регистрация/остановка cron | этот файл, [scheduler](jobs/scheduler.md), [каталог jobs](jobs/README.md), `VkService.start()` |
| Shutdown subagent или VK | этот файл, [SubagentService](services/ai/subagentService.md), [VkService](services/vk/vkService.md) |
