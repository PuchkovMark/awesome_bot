# Участники беседы и статистика

Каталог сервисов участников: [анкеты](../member/README.md), [MembershipService](membershipService.md), [обработка событий VK](vkEvents.md).

Проверенные точки входа: [membershipService.ts](../../../../../src/services/membership/membershipService.ts), [memberService.ts](../../../../../src/services/member/memberService.ts) и обработчик событий в [vkService.ts](../../../../../src/services/vk/vkService.ts). Профили и команды анкет также описаны в [каталоге команд](../command/README.md). Source-level flow анкет, ошибок ввода/хранения и VK caller описаны в спецификации [`MemberService`](../member/memberService.md); direct tests этого сервиса и event handler отсутствуют.

Инкрементальная сверка R07 от 20.11.2026: полная ежедневная синхронизация удалена. Текущее количество в статистике берётся только у VK; при ошибке доступно лишь явное `null/unavailable`, без локального fallback. `ConversationMember` сохраняется для анкет, представлений и event-driven данных, `MembershipEvent` — для агрегатов входов/выходов. Предыдущие 17 успешных тестов и ограничения приведены в [ревью R07](../../../../tasks/completed/2026-11-19-audit-r07-membership-sync-recovery/review.md); при обновлении документации тесты не запускались.


## Описание по модулям

- [vkEvents](vkEvents.md)
- [membershipService](membershipService.md)
- [memberService](../member/memberService.md)
