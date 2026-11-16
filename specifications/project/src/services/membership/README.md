# Участники беседы и статистика

Каталог сервисов участников: [анкеты](../member/README.md), [MembershipService](membershipService.md), [обработка событий VK](vkEvents.md).

Проверенные точки входа: [membershipService.ts](../../../../../src/services/membership/membershipService.ts), [memberService.ts](../../../../../src/services/member/memberService.ts) и обработчик событий в [vkService.ts](../../../../../src/services/vk/vkService.ts). Профили и команды анкет также описаны в [каталоге команд](../command/README.md). Source-level flow анкет, ошибок ввода/хранения и VK caller описаны в спецификации [`MemberService`](../member/memberService.md); direct tests этого сервиса и event handler отсутствуют. Тесты не запускались.


## Описание по модулям

- [vkEvents](vkEvents.md)
- [membershipService](membershipService.md)
- [memberService](../member/memberService.md)
