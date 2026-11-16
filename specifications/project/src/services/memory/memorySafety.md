# Фильтры безопасности долговременной памяти

**Тип:** функции отбора и нормализации. **Источник:** [memorySafety.ts](../../../../../src/services/memory/memorySafety.ts): `containsSensitiveMemoryData`, `isFirstPersonStatement`, `hasCollectiveMemoryCue`, `shouldConsiderAutomaticMemory`, `normalizeMemoryContent`, `memoryFingerprint`, `memoryTerms`, `keywordRelevance`, `containsInstructionLikeMemory`.

Эвристики распознают шаблоны секретов и чувствительных данных, маркеры первого лица и коллективных решений, а также кандидатов на извлечение (trim-длина от 8, исходная длина до 2000 и совпадение candidate regex). Fingerprint — SHA-256 от нормализованного текста. Термины — уникальные слова длиной от 3 символов за вычетом stop words; релевантность равна доле терминов запроса, найденных в содержимом. Отдельный шаблон выявляет формулировки prompt injection.

Это не гарантия обнаружения всех чувствительных данных и не механизм авторизации. Окончательные решения об извлечении принимает [longTermMemoryService](longTermMemoryService.md). Модуль не выполняет I/O.
