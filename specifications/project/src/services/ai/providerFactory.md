# getAIProvider

**Тип:** фабрика провайдера. **Источник:** [providerFactory.ts](../../../../../src/services/ai/providerFactory.ts), `getAIProvider` и default export.

Каждый вызов создаёт новый `OpenCodeProvider`; фабрика не выбирает провайдера по конфигурации и не кэширует экземпляр. Выбор модели/effort и сетевое поведение находятся в [OpenCodeProvider](opencodeProvider.md). Отдельных тестов фабрики не обнаружено.
