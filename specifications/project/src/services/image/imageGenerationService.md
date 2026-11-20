# imageGenerationService

[imageGenerationService.ts](../../../../../src/services/image/imageGenerationService.ts) создаёт клиент OpenAI только при наличии `OPENAI_API_KEY`, с таймаутом 120 секунд и `AI_MAX_RETRIES`. Генерация использует `OPENAI_IMAGE_MODEL`, `quality=high`, `size=1024x1024`, одно изображение; ответ `b64_json` декодируется в PNG и не должен быть пустым.

Редактирование получает фото из VK, проверяет HTTPS и allowlist hostname (`vk.com`, поддомены `vk.com`, `userapi.com`, `userapi.ru`, `vkuserphoto.ru`, `vkuserphoto.com`, `vkuserphoto.net`), скачивает без редиректов с таймаутом 20 секунд и пределом 20 МиБ; допускаются MIME `image/jpeg`, `image/png`, `image/webp`. Проверка URL не отклоняет отдельно `username/password` или нестандартный HTTPS-порт. Sharp поворачивает исходник согласно метаданным, уменьшает максимум до 2048×2048 без увеличения и преобразует в JPEG с качеством 90; полученный файл передаётся Images API. Сервис также предоставляет `editBuffer`, поэтому проверка источника фото выполняется на пути `downloadPhoto`, а не обязательно при любом вызове `editBuffer`.

Клиент OpenAI создаётся при загрузке модуля, если задан ключ; иначе `getOpenAIClient`
выбрасывает [ImageNotExecutedError](imageError.md). Этот же класс оборачивает ошибки
downloadPhoto, Sharp и toFile до API, сохраняя cause. Сам API-вызов и разбор ответа
не оборачиваются: timeout, moderation, HTTP-ошибка и пустой результат не доказывают
отсутствие исполнения. Квотой управляют callers через [ImageQuotaService](imageQuotaService.md),
сам общий генератор не списывает места для мемов/приключений.

`generate` отправляет prompt напрямую без локальной нормализации; `edit` скачивает
фото VK, `editBuffer` принимает Buffer и перекодирует его через Sharp. Оба проверяют
непустоту результата, MIME помечается как `image/png`. Права проверяются выше по цепочке.
[imageGenerationService.test.ts](../../../../../test/imageGenerationService.test.ts)
проверяет подготовку, ошибки/пустой ответ после API и успешные буферы с подменённым
клиентом; живые API этим не проверяются.
