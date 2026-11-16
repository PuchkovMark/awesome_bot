# CommandService

**Тип:** сервис команд и настроек. **Символы:** `CommandService.handleCommand`, `executeCommand`; singleton `commandService`. **Источник:** [commandService.ts](../../../../../src/services/command/commandService.ts).

## Вход и выход

`handleCommand(command, commandArgs, peerId, senderId, isAdmin, canManageChat, isCreator, isChat, repliedMessageText, jokeTargetName, eventId, resolveUserDisplayName)` возвращает `Promise<string | null>`. Она вызывает `executeCommand`, а непустой результат прогоняет через `localizeCommandReferences`; `null` сохраняется как отсутствие текста. VK обычно сначала обрабатывает выделенные изображения, голос, вложения, мемы и приключения и направляет оставшиеся direct commands сюда. Полный порядок маршрутизации — в [architecture.md](../../architecture.md), канонические имена и команды — в [commands.md](commands.md).

## Нормализация и полномочия

Внутри `executeCommand` имя нормализуется через NFKC и русскую локаль. Специальные преобразования: `анкета` → `profile` (без аргумента означает `edit`), `удалить` + аргумент `профиль` → `profile-delete`, `подтвердить` + `удаление профиля` → `profile-delete-confirm`; остальные алиасы проходят через `normalizeCommandName`. Эти две многословные фразы — отдельные route forms, а не пары `commandAliases`.

До `switch` выполняются проверки категорий:

| Категория | Команды | Требование |
| --- | --- | --- |
| Администратор бота | `model`, `effort`, `mode`, `maintenance`, `imageaccess`, `users`, `logs`, `admin`, `broadcast` | `isAdmin` |
| Администратор бота | `membership` | `isAdmin` |
| Администратор беседы или бот | `welcome`, `questionnaire` | `canManageChat` |

Другие ограничения проверяются ветвью команды, VK-роутером или доменным сервисом; переданные `isCreator`, `isChat` и `canManageChat` влияют на отдельные действия. В групповой беседе в обязанности VK также входят проверка адресации для `!`, определение администратора чата и преобразование VK mention в ID.

## Обработка ошибок и тесты

Исключения команд логируются с `command`, peer, sender и ролью. В большинстве случаев возвращается общий ответ `Не удалось выполнить команду. Проверьте параметры и повторите попытку.`; для `personality`, `welcome`, `questionnaire`, `profile` не-Prisma ошибки могут отображаться по исходному сообщению. Длина system instruction свыше лимита преобразуется в пользовательскую подсказку. Неизвестная ветвь возвращает `Неизвестная команда: <command>`.

У `CommandService` нет общего прямого тестового файла. `membershipCommand.test.ts` содержит пять сценариев команды `membership`; отдельные соответствия отражены в [карте тестов](../../../test/README.md). Полные ветви и примеры каждого имени находятся в [каталоге команд](commands.md); [commandHelp.ts](../../../../../src/services/command/commandHelp.ts) служит пользовательской справкой и сам по себе не подтверждает исполнимость.

## Персонажи

Контракт команды — в [personality](commands.md#command-personality).

## Местоположение и анкеты

Контракты перенесены в каталог: [city](commands.md#command-city), [timezone](commands.md#command-timezone), [profile](commands.md#command-profile), [profiles](commands.md#command-profiles), [profile-delete](commands.md#command-profile-delete) и [profile-delete-confirm](commands.md#command-profile-delete-confirm).
