# Подробный план реализации R07

**Основание:** [task.md](task.md), [plan.md](plan.md).  
**Дата:** 20.11.2026.  
**Статус:** готов к реализации по согласованному простому варианту.

## Проверенный контекст

`ConversationMember` используется не только membership-статистикой, но также `MemberService` и командами модерации. Поэтому модель, event-driven upsert/update и её данные сохраняются. Удаляется только полный daily snapshot writer и его использование как fallback. В рабочем дереве много посторонних незакоммиченных изменений; их не откатывать и не приписывать R07.

## Шаги

### I1. Упростить контракт статистики

В [`membershipService.ts`](../../../../src/services/membership/membershipService.ts):

- разрешить `MembershipStats.current` быть `null`;
- добавить источник `unavailable` (legacy `db` оставить допустимым для совместимости formatter/старых callers, но сервис его больше не производит);
- в `getStats` при отсутствии API, исключении или невалидном count вернуть `current=null`, `currentSource=unavailable`;
- удалить `countPresentMembers`, `syncIfStale`, `fetchMemberIds`, `updatePresentMembers`, page/batch constants, `chunk` и `syncLocks`;
- formatter вместо `Сейчас: null` выводит `Сейчас: недоступно`; для `unavailable` поясняет ошибку VK без утверждения о локальном снимке.

Агрегаты событий, timezone, partial и логирование ошибки VK сохраняются.

### I2. Удалить запуск snapshot sync

В [`vkService.ts`](../../../../src/services/vk/vkService.ts) удалить только вызов `membershipService.syncIfStale` после обработки membership event. Запись `MembershipEvent`, onboarding, приветствия и игровые leave hooks не менять.

### I3. Отразить недоступность в tool

В [`chatInfoTool.ts`](../../../../src/services/ai/tools/chatInfoTool.ts) сохранить поле `current`, допускающее JSON `null`, и вернуть `current_source=unavailable`. Остальные поля и проверки bot-admin/group не менять.

### I4. Проверить и передать в ревью

- найти оставшиеся ссылки на удалённые symbols;
- выполнить `git diff --check`;
- в Node.js 22 контейнере выполнить сфокусированные membership tests и затем подходящую общую проверку;
- не обращаться к VK и рабочей БД;
- провести запрошенное ревью текущего diff и записать `review.md`.

## AC → реализация

| AC | Шаги | Наблюдаемое подтверждение |
| --- | --- | --- |
| AC-1 | I1, I3 | успешный count остаётся числом с `vk` |
| AC-2 | I1, I3 | ошибка/нет API дают `null/unavailable`, Prisma member count не вызывается |
| AC-3 | I1, I2 | нет daily-sync метода и вызывающих мест |
| AC-4 | I1–I3 | event aggregates, guards и соседние `ConversationMember` writers не изменены |

Новые решения при реализации не принимать молча. Планы после начала реализации не редактировать без отдельного поручения пользователя.
