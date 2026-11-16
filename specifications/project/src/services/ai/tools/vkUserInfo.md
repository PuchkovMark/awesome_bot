# vkUserInfo

**Тип сущности:** общий helper-модуль запросов и безопасной проекции сведений VK о пользователе. **Runtime identity:** `parseUserInfoOptions`, `getVkUserInfo`, `USER_INFO_SECTIONS`, `POST_FILTERS`, `PROFILE_FIELDS`, `UserInfoOptions`, `MAX_USER_INFO_PAGE_SIZE`, `MAX_USER_INFO_OFFSET`. **Источник:** [`src/services/ai/tools/vkUserInfo.ts`](../../../../../../src/services/ai/tools/vkUserInfo.ts).

## Владельцы и вызовы

Модуль вызывается активным `createChatInfoTool` из [`chatInfoTool.ts`](../../../../../../src/services/ai/tools/chatInfoTool.ts) для сведений об участнике. [`vkInfoTool.ts`](../../../../../../src/services/ai/tools/vkInfoTool.ts) также вызывает его, но фабрика `get_vk_info` в текущем дереве не подключена к provider tool array. Внешний tool задаёт авторизацию, адресата и реакцию на итоговый статус; helper повторяет переданный `requireAccess` перед обработкой каждой секции. Helper не выбирает произвольный peer, не отправляет сообщения и не пишет в БД.

## Опции выборки и валидация

`parseUserInfoOptions(input)` возвращает нормализованные `UserInfoOptions` либо `undefined`. Дополнительные свойства здесь самостоятельно не запрещаются: внешние tool executors ограничивают схему аргументов.

| Поле | Допустимые значения и default |
| --- | --- |
| `sections` | Уникальный непустой массив: `profile`, `posts`, `friends`, `groups`, `albums`, `photos`. Default: `['profile']`. |
| `profile_fields` | Уникальный непустой массив полей профиля; разрешён только при включённой секции `profile`. Default: `screen_name`, `domain`, `sex`, `bdate`, `city`, `country`, `home_town`, `occupation`, `status`, `about`, `activities`, `interests`, `music`, `movies`, `books`, `online`, `last_seen`, `verified`. |
| `offset` | Safe integer `0..2_147_483_627`, только для запроса хотя бы одной коллекции; default `0`. |
| `count` | Safe integer `1..20`, только для запроса хотя бы одной коллекции; default `10`. |
| `album_id` | Только при `photos`: `profile`, `wall` или числовая форма `-?[1-9]\d{0,14}`; default `profile`. |
| `post_filter` | Только при `posts`: `all`, `owner`, `others`; default `all`. |

Полный список допустимых `profile_fields` задан экспортом `PROFILE_FIELDS`: `activities`, `about`, `blacklisted`, `blacklisted_by_me`, `books`, `bdate`, `can_be_invited_group`, `can_post`, `can_see_all_posts`, `can_see_audio`, `can_send_friend_request`, `can_write_private_message`, `career`, `city`, `common_count`, `connections`, `contacts`, `country`, `counters`, `crop_photo`, `domain`, `education`, `exports`, `followers_count`, `friend_status`, `games`, `has_mobile`, `has_photo`, `home_town`, `interests`, `is_favorite`, `is_friend`, `is_hidden_from_feed`, `is_verified`, `last_seen`, `maiden_name`, `military`, `movies`, `music`, `nickname`, `occupation`, `online`, `personal`, `photo_50`, `photo_100`, `photo_200`, `photo_200_orig`, `photo_400_orig`, `photo_id`, `photo_max`, `photo_max_orig`, `quotes`, `relation`, `relatives`, `schools`, `screen_name`, `sex`, `site`, `status`, `timezone`, `tv`, `universities`, `verified`.

Проверки отклоняют пустые/повторные enum-массивы, неизвестные значения, `profile_fields` без `profile`, `offset`/`count` при одной только секции профиля, неверный `album_id` и `post_filter` без `posts`. `MAX_USER_INFO_PAGE_SIZE` равен 20, а `MAX_USER_INFO_OFFSET` — `2_147_483_627`.

## Получение профиля и коллекций

`getVkUserInfo(context)` принимает VK `api`, необязательный `publicApi`, `userId`, `peerId`, `senderId`, нормализованные `options` и `requireAccess`. Для каждой выбранной секции сначала вызывается `requireAccess`. Профиль запрашивается через `users.get` с выбранными `profile_fields`; ответ должен содержать ровно один объект с ID запрошенного пользователя. Возвращаются базовые поля и только запрошенные поля. Для `contacts`, `connections`, `education` запрашиваются соответствующие под-поля. В `sections.profile` записываются `requested_fields`, поля, не вернувшиеся от VK, и `truncated`, если сработал предел санитайзера.

Коллекции читаются через `publicApi`: `posts` — `wall.get`, `friends` — `friends.get`, `groups` — `groups.get`, `albums` — `photos.getAlbums`, `photos` — `photos.get`. При отсутствии `publicApi` соответствующая секция получает `status=error` с причиной о ненастроенном `VK_SERVICE_TOKEN`; обработка других секций продолжается. Списки используют запрошенные `offset`/`count`. Posts фильтруются через `all|owner|others`; фото используют `album_id` и `rev=1`.

Каждый ответ коллекции должен содержать корректный `count` и `items`, укладываться в страницу и согласовываться с общим количеством; пустая страница до конца коллекции считается неполной. Для `posts`, `albums` и `photos` проверяется `owner_id === userId`. Выходные поля берутся из whitelist секции; для поста/фото добавляется URL VK. Ответ содержит `total`, `offset`, `returned`, `has_more`, условный `next_offset`, `offset_limit_reached`, применённый `album_id`/`post_filter` и возможный `truncated`.

Whitelist полей коллекций: `posts` — `id`, `owner_id`, `from_id`, `date`, `text`, `post_type`, `marked_as_ads`, `attachments`, `copy_history`, `comments`, `likes`, `reposts`, `views`; `friends` — `id`, `first_name`, `last_name`, `domain`, `screen_name`, `is_closed`, `deactivated`; `groups` — `id`, `name`, `screen_name`, `type`, `is_closed`; `albums` — `id`, `owner_id`, `title`, `description`, `size`, `created`, `updated`; `photos` — `id`, `owner_id`, `album_id`, `date`, `text`, `width`, `height`. Профиль сохраняет базовые `id`, `first_name`, `last_name`, `is_closed`, `can_access_closed`, `deactivated` и запрошенные поля; алиасы `contacts`, `connections`, `education` раскрываются в под-поля, заданные `PROFILE_FIELD_ALIASES`.

Санитайзер оставляет `null`, boolean, конечные числа, ограниченные строки и вложенные JSON-совместимые массивы/объекты; удаляет `access_key`, `access_token`, `refresh_token` и ключи, не соответствующие `^[a-zA-Z0-9_]{1,60}$`. Пределы одной секции: 8 000 символов и 1 000 узлов; текст — 1 000 символов, массив — 20 элементов, объект — 40 полей, вложенность — 5 уровней. При исчерпании лимитов результат отмечается как усечённый. Секции выполняются последовательно. Ошибка отдельной секции логируется с `peerId`, `senderId`, именем ошибки и необязательным VK-кодом, после чего становится локальным `status=error`; другие секции продолжают выполняться.

Функция возвращает `{ status: 'result' | 'error', user?, sections }`: общий `result` устанавливается, если успешно получена хотя бы одна секция; иначе возвращается `error`. Профиль находится в поле `user`, коллекции — в соответствующих секциях. Сообщения VK считаются недоверенными данными вызывающим инструментом. В helper нет собственного timeout/retry; исключения отдельных API-вызовов превращаются в статус секции.

## Тесты и ограничения

Отдельных тестов `vkUserInfo.ts` нет. [`chatInfoTool.test.ts`](../../../../../../test/chatInfoTool.test.ts) проверяет некоторые внешние сценарии `get_chat_info`, но не покрывает коллекции профиля, всю схему опций, санитайзер и реальные VK API вызовы. Фабрика [`get_vk_info`](../tools.md#get_vk_info) не подключена; для неё нет прямого теста. Тесты не запускались в рамках проверки документации.
