# Веб-поиск

| Сущность | Назначение | Исходник |
| --- | --- | --- |
| [SearchService](searchService.md) | Поиск и резервный провайдер | `src/services/search/searchService.ts` |
| [findWebSearchQuery](searchIntentService.md) | Определение поискового намерения моделью | `src/services/search/searchIntentService.ts` |

Оба вызываются из `VKService`; это автоматический этап формирования ответа, не самостоятельный инструмент модели.
