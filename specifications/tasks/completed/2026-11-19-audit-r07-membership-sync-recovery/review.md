# Ревью реализации R07

## 20.11.2026 — первичное ревью

### Основание сравнения

Проверено текущее рабочее дерево поверх `b59077ba50077c2243e6f87491dbf70b03bd18f6` по требованиям [task.md](task.md), [plan.md](plan.md) и [implenent.md](implenent.md).

В scope реализации R07 входят:

- удаление daily snapshot/fallback в `src/services/membership/membershipService.ts`;
- удаление одного caller `membershipService.syncIfStale` из membership-event ветки `src/services/vk/vkService.ts`;
- task-документы этой папки.

В `vkService.ts` и рабочем дереве присутствует много несвязанных незакоммиченных изменений других задач; они не приписывались R07 и не ревьюились как часть этой задачи.

### Оценка критериев

| Критерий | Результат |
| --- | --- |
| AC-1 | Выполнен: валидный safe integer `response.count >= 0` возвращается как `current` с `currentSource='vk'`. |
| AC-2 | Выполнен: отсутствие API, исключение и невалидный count дают `current=null`, `currentSource='unavailable'`; чтения `ConversationMember` в `getStats` нет. Formatter показывает «Сейчас: недоступно», tool возвращает JSON `null/unavailable`. |
| AC-3 | Выполнен: `syncIfStale`, pagination/batch writers и вызывающее место в VK membership route удалены; ссылок на symbol в `src/` и `test/` нет. |
| AC-4 | Выполнен в проверенном scope: запись/агрегация `MembershipEvent`, command/tool guards и event-driven `MemberService` join/leave не изменены. |

### Подтверждённые замечания

Замечаний к реализации R07 не найдено.

### Проверки

- `node --import tsx --test test/membershipService.test.ts test/membershipCommand.test.ts test/chatInfoTool.test.ts` в `node:22-bullseye-slim`: **17/17 passed**.
- `npm run typecheck` в `node:22-bullseye-slim` после `npx prisma generate` по текущей схеме: **passed**.
- `npx eslint src/services/membership/membershipService.ts src/services/vk/vkService.ts --max-warnings=0`: **passed**.
- `npx prettier --check src/services/membership/membershipService.ts src/services/vk/vkService.ts`: **passed**.
- `git diff --check` для scope R07: **passed**.

Первый ошибочно широкий прогон через `npm test -- --test-name-pattern=membership` и следующий прогон в `node:22-slim` не считаются успешными проверками: они завершились из-за несовместимого Prisma engine/OpenSSL контейнера. Причина подтверждена сообщениями Prisma; исправление исходников для неё не выполнялось. Финальный сфокусированный прогон использовал совместимый Bullseye/OpenSSL 1.1.

### Ограничения проверки

Живой VK, рабочая SQLite и реальный membership event не использовались. Новые тесты не добавлялись согласно правилам реализации; существующие тесты подменяют membership service/Prisma и не воспроизводят ошибку VK внутри `getStats`. Вывод AC-2 дополнительно основан на статической трассировке единственной ветки ошибки.

### Устаревшие канонические спецификации

Это не дефекты кода, но после изменения контракта требуют отдельной синхронизации:

- `specifications/project/src/services/membership/membershipService.md` всё ещё описывает `syncIfStale`, DB fallback и batch snapshot;
- `specifications/project/src/services/vk/vkService.md` всё ещё утверждает, что membership event запускает `syncIfStale`;
- `specifications/project/prisma/models.md` всё ещё перечисляет `MembershipService` как writer/reader `ConversationMember` для полной синхронизации;
- `specifications/project/src/services/ai/tools.md`, `specifications/project/src/services/command/commands.md` и `specifications/project/test/README.md` не отражают `null/unavailable` и выполненные проверки.

Поле `ChatSettings.membershipLastSyncDay` намеренно сохранено как legacy и остаётся корректно перечисленным в каталоге моделей.
