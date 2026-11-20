# План R01: Повторно проверять доступ при нажатии «новый вариант»

**Основание:** [task.md](task.md), [находка R01](../../../project-issues/specification-audit.md#r01-p1--кнопка-нового-варианта-обходит-актуальные-запреты-на-генерацию), [реестр задач](../../../project-issues/specification-audit-tasks.md).
**Статус:** предложение плана; исполнение не начато.
Зависимые шаги условны до явного ответа на решения D*. План нельзя передавать исполнителю как согласованный.
**Проверка основания:** статическое чтение соответствующих источников текущего рабочего дерева; бот, тесты, VK, провайдеры и рабочая БД не запускались.

## Текущий контракт и затронутые области

В message_event ветвь fun_again проверяет последний output пользователя, затем напрямую вызывает MemeService или FunService без актуальных mode/maintenance/imageAccess/rate-limit. Сами генераторы не являются слоем авторизации.

| Материал | Владелец / назначение |
| --- | --- |
| [vkService.ts](../../../src/services/vk/vkService.ts) | message_event fun_again / checkRateLimit |
| [funService.ts](../../../src/services/fun/funService.ts) | latestOutput / allowsPersonalJokes / generate |
| [memeService.ts](../../../src/services/fun/memeService.ts) | MemeService.create |

Канонические описания: [commands.md#fun-feedback-and-fun-again](../../project/src/services/command/commands.md#fun-feedback-and-fun-again), [commands.md#command-meme](../../project/src/services/command/commands.md#command-meme), [funService.md#настройки-и-область-действия](../../project/src/services/fun/funService.md#настройки-и-область-действия).

## Принятые ограничения

Связь output с пользователем и peer, отказ для старой кнопки, существующая клавиатура; запись fun_feedback не становится платной генерацией и не получает её запреты автоматически.
Запрос пользователя относится к задачам и предложениям планов. Рекомендованный ниже вариант не считается согласованным. Не менять соседние функции, бюджеты, публичные schemas и сохранённые данные без отдельного решения.

## Открытые решения

| Решение | Что выбрать | Предложение и альтернатива | Зависимые шаги |
| --- | --- | --- | --- |
| R01-D1 | Проверка персональных разрешений по типам output. | Рекомендую применять personalJokes к персональным roast/joke/prediction, не блокируя нейтральный randomjoke/story; происхождение целевого участника в FunOutput сейчас не хранится. Если оно не восстанавливается надёжно, рекомендую отказ от персонального повтора до явного нового запроса; альтернатива — сохранять минимальный target metadata с согласованием схемы. | S1–S2 |

Для каждого решения сейчас статус «ожидает ответа». Обсуждать по одному; выбранная в интерфейсе рекомендация, молчание или общий запрос на план не являются согласием.

## Предложенная последовательность

**S0.** Сначала получить необходимые решения из [A02](../2026-11-19-audit-a02-image-action-guard/plan.md) и решений D* этой задачи. Статическое уточнение источников и подготовка сценариев могут выполняться независимо.

**S1.** До генерации перечитать роль, текущие настройки и maintenance; применить существующий лимитер к платному callback и imageAccess для meme.
Владелец: [message_event fun_again / checkRateLimit](../../../src/services/vk/vkService.ts). Критерии: AC-1.

**S2.** После D1 проверить разрешения персонального вида и привязку последнего output; не угадывать адресата из сгенерированного текста.
Владелец: [latestOutput / allowsPersonalJokes / generate](../../../src/services/fun/funService.ts). Критерии: AC-2, AC-3.

**S3.** Развести отказ генерации и сохранение оценки, сохранить snackbar и обработку ошибки отправки.
Владелец: [message_event fun_again / checkRateLimit](../../../src/services/vk/vkService.ts). Критерии: AC-3, AC-4.

**S4.** Проверить все AC по таблице, сохранить фактические ограничения проверки и только после реализации обновить перечисленные канонические документы в разрешённой области. Общую спецификацию сейчас не менять.

## Соответствие критериям

| Критерий | Текущий контракт и источник | Изменение | Как проверить |
| --- | --- | --- | --- |
| AC-1 | [commands.md#fun-feedback-and-fun-again](../../project/src/services/command/commands.md#fun-feedback-and-fun-again); [message_event fun_again / checkRateLimit](../../../src/services/vk/vkService.ts) | S1 | Старая кнопка после каждого изменения прав/режима, отказ до внешнего вызова. |
| AC-2 | [commands.md#fun-feedback-and-fun-again](../../project/src/services/command/commands.md#fun-feedback-and-fun-again); [latestOutput / allowsPersonalJokes / generate](../../../src/services/fun/funService.ts) | S2 | Отзыв consent, отсутствующее target metadata, допустимый новый вариант и устаревшая кнопка. |
| AC-3 | [commands.md#fun-feedback-and-fun-again](../../project/src/services/command/commands.md#fun-feedback-and-fun-again); [latestOutput / allowsPersonalJokes / generate](../../../src/services/fun/funService.ts), [message_event fun_again / checkRateLimit](../../../src/services/vk/vkService.ts) | S2, S3 | Отзыв consent, отсутствующее target metadata, допустимый новый вариант и устаревшая кнопка. Запрещённый повтор не пишет output; оценка в том же peer работает по прежнему контракту. |
| AC-4 | [commands.md#fun-feedback-and-fun-again](../../project/src/services/command/commands.md#fun-feedback-and-fun-again); [message_event fun_again / checkRateLimit](../../../src/services/vk/vkService.ts) | S3 | Запрещённый повтор не пишет output; оценка в том же peer работает по прежнему контракту. |

## Проверки и имеющиеся свидетельства

Отдельных callback-тестов в репозитории нет; существующий integration test не покрывает fun_again.
Существующие относящиеся файлы: [vkMessageDeliveryIntegration.test.ts](../../../test/vkMessageDeliveryIntegration.test.ts).
При исполнении использовать существующие проверки `npm run check` и при необходимости `npm run build` внутри изолированного Node.js 22 согласно [operations](../../project/operations.md). Проверки специфичных сценариев из таблицы выполнить с подменёнными внешними вызовами/синтетическими данными; БД-гонки проверять на отдельной временной SQLite, а не на рабочем файле.
Новые и изменённые репозиторные тесты не требуются без явного запроса пользователя: недостающие сценарии допускается проверить временно вне `test/`. Наличие старого теста не подтверждает непроверенную ветвь. Во время текущего планирования runtime-проверки не выполнялись.

## Данные, совместимость и применение

Базовая проверка режима/доступа не требует миграции. Достоверное target metadata персонального output может потребовать расширения хранения только после D1; не извлекать права из свободного текста.
Развёртывание, обращения к живым VK/AI и применение миграций к operational DB не являются плановой проверкой и не авторизованы запросом на подготовку задач.

## Документация и передача

После разрешённой реализации сверить [commands.md#fun-feedback-and-fun-again](../../project/src/services/command/commands.md#fun-feedback-and-fun-again), [commands.md#command-meme](../../project/src/services/command/commands.md#command-meme), [funService.md#настройки-и-область-действия](../../project/src/services/fun/funService.md#настройки-и-область-действия); учитывать зависимых callers и входящие ссылки. Не создавать отдельные канонические файлы команд, tools или Prisma-моделей.
Исполняющий агент следует согласованным решениям. Если новые данные требуют иного алгоритма, схемы, интерфейса или поведения, он сообщает проблему в чате и задаёт один вопрос до зависимых изменений, продолжая независимую работу. Во время реализации любые планы доступны только для чтения без специального поручения изменить их, включая статусы и результаты проверок. Согласие с решением или поручение реализации само по себе не разрешает редактировать планы.
