# LocationService

**Тип:** сервис разрешения и настройки города/часового пояса. **Источник:** [locationService.ts](../../../../../src/services/settings/locationService.ts), именованные функции `getLocationSummary`, `setCity`, `setTimeZone`, `clearLocation` и типы результата; экспортируется также default-объект `locationService`.

### Scope, чтение и сводка

Все функции принимают scope `user` или `chat` и идентификатор владельца. Для `user` публичная функция получает VK ID (`vkId`), который `SettingsService.getUserSettings` разрешает во внутренний `User.id`; для `chat` используется строковый conversation ID. Сервис сам не устанавливает соответствие или права вызова: вызывающая сторона выбирает scope и ID.

`getLocationSummary(scope, id)` загружает настройки через `SettingsService`: [UserSettings](../../../prisma/models.md#usersettings) либо [ChatSettings](../../../prisma/models.md#chatsettings). Методы чтения `SettingsService` используют upsert, поэтому просмотр может создать отсутствующие сущности и настройки. Сводка содержит исходный settings snapshot и вычисленные значения: `cityConfigured` истинен при непустом `locationName` либо непустых координатах; `timeZoneConfigured` истинен при `timeZone` или `locationTimeZone`. Отображаемый город: сохранённое имя → «Место из настроек» при наличии одних координат → [`DEFAULT_CITY.name`](locationDefaults.md). Зона: явный `timeZone` → часовой пояс места → `DEFAULT_TIME_ZONE`.

### Изменение города

`setCity(scope, id, query)` принимает `WeatherLocationQuery` (`name`, необязательные регион/страна/country code) и использует [WeatherService.resolveLocation](../weather/weatherService.md). Ровно неуточнённое имя Москвы после trim и case-folding для `ru-RU` разрешается локально через встроенные координаты; другие варианты отправляются внешним геокодерам. `not_found` и `ambiguous` возвращаются как отдельные результаты без записи. При успехе сохраняются имя, широта/долгота, страна (предпочтительно `country`, иначе код страны), регион и timezone найденного места; `SettingsService` обновляет соответствующие `location*` поля. Отдельное поле `timeZone` не изменяется и продолжает иметь приоритет.

Геокодер недоступен (`GeocodingUnavailableError`), сбой сохранения или повторного чтения преобразуется в `error`; внешняя ошибка журналируется только с scope и именем ошибки. Для недоступного геокодера текст статуса сообщает о проблеме сервисов поиска; прочие ошибки предлагают уточнить название. Исключения не пробрасываются из `setCity`.

### Часовой пояс и очистка

`setTimeZone` принимает IANA zone, проверяет её через общий [`isValidTimeZone`](../../../../../src/services/reminders/reminderDateTime.ts), затем сохраняет как явный `timeZone` в `UserSettings` или `ChatSettings`. Неверная зона возвращается как `invalid` без записи. Ошибка записи или reload возвращается как `error` и логируется по scope/имени ошибки; успешный результат содержит новую сводку.

`clearLocation` принимает `city`, `timezone` или `all`. Очистка города сбрасывает название, координаты, страну, регион и `locationTimeZone`, но сохраняет явный `timeZone`. Очистка timezone сбрасывает оба поля `timeZone` и `locationTimeZone`, сохраняя информацию о городе. `all` очищает обе группы. База операций делегирована `SettingsService`; частичные изменения при ошибке нескольких последовательных запросов не обёрнуты в транзакцию. Ошибка логируется и возвращается как `error`.

### Потребители и проверки

Права проверяют вызывающие стороны: единый каталог команд — [`/city`](../command/commands.md#command-city) и [`/timezone`](../command/commands.md#command-timezone), AI tool — [`manage_location`](../ai/tools.md#manage_location). Сервис также является источником местоположения для [get_weather](../ai/tools.md#get_weather) и [get_current_datetime](../ai/tools.md#get_current_datetime); актуальные settings при этом выбираются по scope текущего события, автоматического fallback между настройками беседы и пользователя нет. Отдельных тестов `LocationService` нет; четыре теста tool используют заменённые операции и подтверждают только публичный слой инструмента.
