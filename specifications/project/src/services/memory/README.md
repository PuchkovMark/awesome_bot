# История сообщений и долговременная память

- [memoryEmbeddings](memoryEmbeddings.md) — внешний провайдер векторов.
- [memorySafety](memorySafety.md) — эвристики кандидатов и фильтрации.

Очистка текста новых записей описана в [historyText](historyText.md). Здесь описаны проверенные методы [memoryService.ts](../../../../../src/services/memory/memoryService.ts) и [longTermMemoryService.ts](../../../../../src/services/memory/longTermMemoryService.ts). Это отдельные механизмы: очистка истории командой `/reset` или `/forget` сама по себе не является удалением записей `LongTermMemory`.


## Описание по модулям

- [memoryService](memoryService.md)
- [longTermMemoryService](longTermMemoryService.md)
