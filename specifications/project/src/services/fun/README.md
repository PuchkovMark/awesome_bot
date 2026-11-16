# Развлечения и «Мем дня»

- [FunService](funService.md) — юмористические ответы, настройки и обратная связь.
- [MemeService](memeService.md) — генерация мемов и отбор контекста.
- [MemeDayService](memeDayService.md) — настройки, scheduled/manual публикации, состояния и голосование.

Документы описывают команды и маршруты, настройки, промпты, фильтрацию и подготовку контекста, генерацию/рендер, плановые и ручные публикации, сохранение состояний, повторные попытки и голосование по исходникам [commandService.ts](../../../../../src/services/command/commandService.ts), [vkService.ts](../../../../../src/services/vk/vkService.ts), [memeDayService.ts](../../../../../src/services/fun/memeDayService.ts), [memeService.ts](../../../../../src/services/fun/memeService.ts), [funService.ts](../../../../../src/services/fun/funService.ts) и [memeDayJob.ts](../../../../../src/jobs/memeDayJob.ts). Тесты для этих сервисов отсутствуют; это ограничение реализации и свидетельств, а не незакрытая инвентаризация документации.


## Описание по модулям

- [Юмористические команды](../command/commands.md)
- [battle](../command/commands.md#command-battle)
- [memeDayService](memeDayService.md)
