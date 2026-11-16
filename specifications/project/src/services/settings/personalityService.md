# personalityService

**Тип сущности:** каталог встроенных личностей и чистые функции нормализации/валидации стиля.
**Экспортируемые identity:** `personalities`, `defaultPersonality`, `personalitySettingKeys`, `normalizePersonalityId`, `isRetiredPersonalityId`, `isPersonalityId`, `validatePersonalitySettings`, `parsePersonalitySettings`, `buildPersonalityInstructions`; типы `PersonalitySettingKey`, `PersonalitySettings`, `PersonalityDefinition`.
**Источник:** [`src/services/settings/personalityService.ts`](../../../../../src/services/settings/personalityService.ts).
**Связанные документы:** [CharacterService](characterService.md), [команды персонажей](../command/commands.md#command-personality), [AI capability](../ai/capabilityService.md), модели [`PersonalityProfile`](../../../prisma/models.md#personalityprofile) и [`PersonalityProfileVersion`](../../../prisma/models.md#personalityprofileversion).

## Каталог и типы

Встроенный каталог содержит шесть профилей: `alex` (Алекс), `max` (Макс), `socrates` (Сократ), `victor` (Виктор), `nikon` (Никон), `chipsik` (Чипсик). Каждый `PersonalityDefinition` задаёт стабильный `id`, отображаемые имя/описание/пример, системный prompt, полный набор настроек и коэффициентов влияния. Публичный объект `personalities` индексируется по `id`; `defaultPersonality` равен `chipsik`.

Набор числовых параметров фиксирован: `humor`, `sarcasm`, `emotion`, `length`, `formality`, `emoji`, `detail`. Поля `settings` задают базовые значения профиля, `influences` — насколько соответствующий параметр влияет на инструкцию (0–100). Это каталог исходных значений, а не хранилище пользовательского выбора: сохранение, выбор области direct/chat, доступность и версии принадлежат `CharacterService`.

## Нормализация и состояния ID

`normalizePersonalityId(id)` обрезает пробелы и приводит строку к нижнему регистру; `null`/`undefined` превращаются в пустую строку. Псевдонимы миграции: `friendly → alex`, `sarcastic → max`, `philosopher → socrates`, `consultant → victor`, `default → chipsik`. Идентификаторы `joker`, `funny`, `gamer` остаются без переназначения, но `isRetiredPersonalityId` распознаёт их как зарезервированные удалённые ID. Их нельзя трактовать как доступный профиль; создание дополнительно запрещает `CharacterService`.

`isPersonalityId` нормализует значение и проверяет наличие собственного ключа в `personalities`. Оно не проверяет доступность динамического профиля в БД, область применения, allowlist или enabled-флаг — для этого нужен `CharacterService`. `isRetiredPersonalityId` только trim/lowercase выполняет и проверяет отдельный набор удалённых идентификаторов.

## Валидация настроек

`validatePersonalitySettings(input)` возвращает частичный объект. Неизвестный ключ вызывает `Error`; значение должно быть числом, целым и в диапазоне 0–100 включительно, иначе выбрасывается `Error` с именем ключа. Пустой объект допустим. Функция не заполняет отсутствующие параметры значениями по умолчанию.

`parsePersonalitySettings(value)` возвращает `{}` для `null`, `undefined` и пустой строки. В остальных случаях разбирает JSON, требует объект (не `null` и не массив) и передаёт записи в `validatePersonalitySettings`. Некорректный JSON оборачивается сообщением «Сохранённые настройки персонажа имеют неверный формат.»; JSON другого верхнего типа приводит к сообщению «…должны быть объектом.». Некорректные ключи и значения сохраняют ошибки валидатора. Это строгий парсер: неизвестные поля не игнорируются.

## Построение инструкции стиля

`buildPersonalityInstructions(definition, overrides)` объединяет настройки профиля с переданными overrides (значения overrides имеют приоритет), затем для каждого ключа с `definition.influences[key] > 0` добавляет в текст русское название свойства и вычисляет эффективный процент: `round(value * influence / 100)`. Параметры с нулевым влиянием пропускаются. Итог — исходный `systemPrompt`, перевод строки и общая инструкция со шкалой 0–100 и рассчитанными значениями.

Функция предполагает корректность `definition` и `overrides`; повторно не валидирует их. Она не выбирает профиль, не читает БД, не определяет права и не гарантирует, что модель соблюдёт prompt. Содержание встроенных промптов является частью поведения и включает специальные ограничения для `nikon` и `chipsik`; при их изменении важно сохранять актуальные тексты в исходнике.

## Потребители, тесты и ограничения

`CharacterService` использует каталог при инициализации и формирует пользовательскую/беседовую инструкцию. Командный слой использует список `personalitySettingKeys` для разбора настроек; AI-контекст передаёт имя, варианты и результат выбора в prompt. Не дублируйте правила доступа в этом модуле: они реализованы в `CharacterService` и вызывающих обработчиках.

[`test/personalityService.test.ts`](../../../../../test/personalityService.test.ts) проверяет шесть встроенных профилей и наличие Никона вместо Joker, удалённые ID, legacy-алиасы и запрет создания зарезервированного профиля через `CharacterService`. Дополнительный интеграционный файл `test/vkMessageDeliveryIntegration.test.ts` импортирует каталог личностей; это само по себе не подтверждает отдельную проверку каждой ветви prompt. Тесты в этом проходе не запускались.
