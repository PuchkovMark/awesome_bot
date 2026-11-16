# Memory embedding provider

**Тип:** провайдер эмбеддингов и математические функции. **Источник:** [memoryEmbeddings.ts](../../../../../src/services/memory/memoryEmbeddings.ts): `MemoryEmbeddingProvider`, `OpenAIMemoryEmbeddingProvider`, `createMemoryEmbeddingProvider`, `cosineSimilarity`.

Создаётся только при наличии `MEMORY_EMBEDDING_API_KEY`; иначе возвращается `undefined`. Модель берётся из `MEMORY_EMBEDDING_MODEL`; OpenAI SDK использует timeout 8 секунд и `maxRetries: 0`. Векторы сортируются по индексу ответа. `cosineSimilarity` возвращает 0 для пустых/разных по размерности векторов и нулевой нормы. Тексты отправляются внешнему API; модуль не проверяет права и не хранит векторы.
