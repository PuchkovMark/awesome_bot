# План R07: удалить ненадёжный fallback текущего состава

**Основание:** [task.md](task.md).  
**Статус:** согласован пользователем 20.11.2026; готов к детализации и реализации.

## Решение и границы

Текущее количество берётся только из `messages.getConversationMembers(count: 1)`. Ошибка или невалидный `count` превращается в явное состояние `unavailable`, а не в чтение потенциально устаревшего `ConversationMember`. Полная ежедневная синхронизация удаляется из исполнения. `ConversationMember`, `MembershipEvent` и legacy-поле `membershipLastSyncDay` сохраняются для совместимости и соседних функций.

## Последовательность

**S1.** В [`membershipService.ts`](../../../../src/services/membership/membershipService.ts) удалить `syncIfStale`, pagination/batch writers и process-local lock. Расширить результат статистики явным состоянием недоступности и не обращаться к локальному составу при ошибке VK.

**S2.** В [`vkService.ts`](../../../../src/services/vk/vkService.ts) удалить fire-and-forget вызов полной синхронизации после membership event. Остальной event routing не менять.

**S3.** Обновить formatter и membership action [`chatInfoTool.ts`](../../../../src/services/ai/tools/chatInfoTool.ts), чтобы число могло отсутствовать, а источник был `unavailable`. Права bot-admin и схема остальных агрегатов сохраняются.

**S4.** Выполнить существующие проверки в Node.js 22 без живого VK и рабочей БД. Новые тесты не добавлять без отдельного запроса. После реализации синхронизировать канонические спецификации отдельным разрешённым этапом; запрошенное ревью записать в `review.md`.

## Соответствие критериям

| AC | Источник | Изменение | Проверка |
| --- | --- | --- | --- |
| AC-1 | `MembershipService.getStats` | успешный VK count, `currentSource=vk` | существующие typecheck/tests |
| AC-2 | `MembershipService.getStats`, formatter, chat info tool | `current=null`, `currentSource=unavailable`, без DB count | статическая трассировка и существующие проверки |
| AC-3 | membership event route в `VkService` | удалить `syncIfStale` и caller | поиск ссылок, typecheck |
| AC-4 | `MembershipEvent`, command/tool guards | не менять агрегаты и права | существующие membership tests |

## Данные и применение

Миграция не нужна. Существующие строки `ConversationMember` и `membershipLastSyncDay` не очищаются и продолжают обслуживать соседние функции. Живой бот и operational SQLite для проверки не запускаются.

Исполнитель следует [task.md](task.md), этому плану и `implenent.md`. Новый существенный выбор сначала согласуется с пользователем. После начала реализации планы остаются только для чтения без отдельного поручения.

