# Общие модули AI tools

В каталоге `src/services/ai/tools/` инструменты модели документируются совместно в [каноническом каталоге](../tools.md). Отдельные файлы ниже описывают общие helper-модули, используемые несколькими инструментами; это не дополнительные публичные инструменты модели.

| Документ | Источник и символы | Назначение |
| --- | --- | --- |
| [dateTime](dateTime.md) | [`dateTime.ts`](../../../../../../src/services/ai/tools/dateTime.ts): `parseIsoDateTime`, `isRecord` | Общая проверка ISO date-time и type guard для JSON-объектов. |
| [vkUserInfo](vkUserInfo.md) | [`vkUserInfo.ts`](../../../../../../src/services/ai/tools/vkUserInfo.ts): `parseUserInfoOptions`, `getVkUserInfo` | Валидация выборки пользовательских данных VK, запросы профиля/коллекций и безопасная проекция ответа. |

Реализации этих helper вызываются из [`chatInfoTool.ts`](../../../../../../src/services/ai/tools/chatInfoTool.ts), [`vkInfoTool.ts`](../../../../../../src/services/ai/tools/vkInfoTool.ts) и других файлов, указанных в соответствующих спецификациях. Они не регистрируют самостоятельные `AITool.name`.
