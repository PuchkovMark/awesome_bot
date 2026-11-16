# Модели Prisma

**Канонический каталог:** все модели схемы находятся в этом файле; отдельные файлы на модели не создаются. Снимок от 2026-11-16 (`2dbb190` плюс незакоммиченные изменения рабочего дерева) основан на текущем `prisma/schema.prisma`. Все прямые Prisma delegate calls в `src/` статически сопоставлены с моделями в [матрице операций](#доступ-приложения-и-хранение) и [карте областей запросов](#области-запросов-транзакции-и-тестовые-свидетельства); история SQL-миграций — в [migrations.md](migrations.md). Проверка описывает исходники и миграционные файлы; operational DB намеренно не читалась.

## Содержание

- [`User`](#user)
- [`Conversation`](#conversation)
- [`ConversationParticipant`](#conversationparticipant)
- [`Message`](#message)
- [`LongTermMemory`](#longtermmemory)
- [`MemoryActionDraft`](#memoryactiondraft)
- [`UserSettings`](#usersettings)
- [`ChatSettings`](#chatsettings)
- [`Reminder`](#reminder)
- [`ReminderDelivery`](#reminderdelivery)
- [`ReminderDraft`](#reminderdraft)
- [`ConversationMember`](#conversationmember)
- [`MembershipEvent`](#membershipevent)
- [`DigestJob`](#digestjob)
- [`FunPreference`](#funpreference)
- [`FunOutput`](#funoutput)
- [`FunFeedback`](#funfeedback)
- [`MemeDayPublication`](#memedaypublication)
- [`MemeDayVote`](#memedayvote)
- [`PersonalityProfile`](#personalityprofile)
- [`PersonalityProfileVersion`](#personalityprofileversion)
- [`CharacterUserSetting`](#characterusersetting)
- [`PersonalityChange`](#personalitychange)
- [`PersonalityUsage`](#personalityusage)
- [`Admin`](#admin)
- [`AppSetting`](#appsetting)
- [`GameSession`](#gamesession)
- [`GameScore`](#gamescore)
- [`GameEvent`](#gameevent)
- [`GamePlayerStats`](#gameplayerstats)
- [`Achievement`](#achievement)
- [`ApiUsage`](#apiusage)
- [`AdminLog`](#adminlog)

## Схема и ограничения интерпретации

Фрагмент полей для каждого раздела автоматически сверяется с моделью в [`schema.prisma`](../../../prisma/schema.prisma). Атрибуты `@id`, `@unique`, `@default`, `@updatedAt`, `@relation`, `@@unique` и `@@index` отражают ограничения Prisma/SQLite; строковые JSON-поля остаются строками на уровне БД. Скалярное поле с идентификатором само по себе не доказывает наличие внешнего ключа.

## User

**Тип:** модель Prisma. **Источник:** [`User` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

`vkId` уникален; связан с сообщениями, настройками, участиями, памятью и её черновиками.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `vkId` | `String` | `@unique` | — |
| `displayName` | `String?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `participants` | `ConversationParticipant[]` | `—` | — |
| `messages` | `Message[]` | `—` | — |
| `settings` | `UserSettings?` | `—` | — |
| `longTermMemories` | `LongTermMemory[]` | `—` | — |
| `memoryActionDrafts` | `MemoryActionDraft[]` | `—` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## Conversation

**Тип:** модель Prisma. **Источник:** [`Conversation` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Диалог с `isGroup=false` по умолчанию; связан с настройками, сообщениями, участниками, играми, напоминаниями, памятью и развлекательными данными.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `title` | `String?` | `—` | — |
| `isGroup` | `Boolean` | `@default(false)` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `participants` | `ConversationParticipant[]` | `—` | — |
| `messages` | `Message[]` | `—` | — |
| `settings` | `ChatSettings?` | `—` | — |
| `members` | `ConversationMember[]` | `—` | — |
| `gameSessions` | `GameSession[]` | `—` | — |
| `funOutputs` | `FunOutput[]` | `—` | — |
| `memeDays` | `MemeDayPublication[]` | `—` | — |
| `reminders` | `Reminder[]` | `—` | — |
| `longTermMemories` | `LongTermMemory[]` | `—` | — |
| `memoryActionDrafts` | `MemoryActionDraft[]` | `—` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## ConversationParticipant

**Тип:** модель Prisma. **Источник:** [`ConversationParticipant` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Связь пользователя и беседы; пара `conversationId,userId` уникальна, `role` необязательна.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id])` | — |
| `conversationId` | `String` | `—` | — |
| `user` | `User` | `@relation(fields: [userId], references: [id])` | — |
| `userId` | `String` | `—` | — |
| `role` | `String?` | `—` | — |

### Составные ключи и индексы

- `@@unique([conversationId, userId])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## Message

**Тип:** модель Prisma. **Источник:** [`Message` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Роль и содержимое, необязательный пользователь, провайдер и токены, VK ID, время, автор, метаданные ответа и вложения. Пара `conversationId,conversationMessageId` уникальна; индексы поддерживают выборки по беседе, времени, роли, ответам и пользователю. `metadata` и `attachments` — строки для JSON.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id])` | — |
| `conversationId` | `String` | `—` | — |
| `user` | `User?` | `@relation(fields: [userId], references: [id])` | — |
| `userId` | `String?` | `—` | — |
| `role` | `String` | `—` | e.g., "user", "assistant", "system" |
| `content` | `String` | `—` | — |
| `provider` | `String?` | `—` | which AI provider generated it (optional) |
| `tokens` | `Int?` | `—` | token count if available |
| `metadata` | `String?` | `—` | extensible metadata (JSON as string for SQLite compatibility) |
| `vkMessageId` | `Int?` | `—` | — |
| `conversationMessageId` | `Int?` | `—` | — |
| `sentAt` | `DateTime?` | `—` | — |
| `fromId` | `Int?` | `—` | — |
| `authorName` | `String?` | `—` | — |
| `replyToVkMessageId` | `Int?` | `—` | — |
| `replyToConversationMessageId` | `Int?` | `—` | — |
| `replyToFromId` | `Int?` | `—` | — |
| `replyToAuthorName` | `String?` | `—` | — |
| `replyToText` | `String?` | `—` | — |
| `attachments` | `String?` | `—` | JSON array of attachment types |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([conversationId, conversationMessageId])`
- `@@index([conversationId, createdAt])`
- `@@index([conversationId, sentAt])`
- `@@index([conversationId, conversationMessageId])`
- `@@index([conversationId, role, createdAt])`
- `@@index([conversationId, replyToConversationMessageId])`
- `@@index([userId, conversationId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## LongTermMemory

**Тип:** модель Prisma. **Источник:** [`LongTermMemory` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

`scope`, категория, содержимое, источник, важность, доверие, fingerprint, опциональные владелец/беседа, эмбеддинг и сроки. Два уникальных ограничения на fingerprint с `userId` и `conversationId`; связи удаляются каскадно. Само поле `scope` — строка, допустимость комбинации владельцев нужно проверять в сервисе.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `scope` | `String` | `—` | — |
| `userId` | `String?` | `—` | — |
| `user` | `User?` | `@relation(fields: [userId], references: [id], onDelete: Cascade)` | — |
| `conversationId` | `String?` | `—` | — |
| `conversation` | `Conversation?` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `createdByVkId` | `String` | `—` | — |
| `category` | `String` | `—` | — |
| `content` | `String` | `—` | — |
| `importance` | `Float` | `@default(0.5)` | — |
| `confidence` | `Float` | `@default(1)` | — |
| `source` | `String` | `@default("automatic")` | — |
| `fingerprint` | `String` | `—` | — |
| `embedding` | `String?` | `—` | — |
| `embeddingModel` | `String?` | `—` | — |
| `relatedMemoryIds` | `String` | `@default("[]")` | — |
| `expiresAt` | `DateTime?` | `—` | — |
| `archivedAt` | `DateTime?` | `—` | — |
| `lastAccessedAt` | `DateTime?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([userId, fingerprint])`
- `@@unique([conversationId, fingerprint])`
- `@@index([userId, archivedAt, updatedAt])`
- `@@index([conversationId, archivedAt, updatedAt])`
- `@@index([category])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## MemoryActionDraft

**Тип:** модель Prisma. **Источник:** [`MemoryActionDraft` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Кандидаты действия памяти и срок действия; уникальная пара `userId,conversationId`, каскадные связи с пользователем и беседой.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `userId` | `String` | `—` | — |
| `user` | `User` | `@relation(fields: [userId], references: [id], onDelete: Cascade)` | — |
| `conversationId` | `String` | `—` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `scope` | `String` | `—` | — |
| `candidateIds` | `String` | `—` | — |
| `expiresAt` | `DateTime` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([userId, conversationId])`
- `@@index([expiresAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## UserSettings

**Тип:** модель Prisma. **Источник:** [`UserSettings` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Уникальны по `userId`; внешний ключ ссылается на `User` с `onDelete: Cascade`. Персонаж `chipsik`, голос выключен, память и автоматическая память включены по умолчанию. Персональная инструкция, голос и все поля местоположения необязательны.

Поля местоположения: `locationName`, `locationLatitude`, `locationLongitude`, `locationCountry`, `locationRegion`, `locationTimeZone` и независимый override `timeZone`; все допускают `NULL`. `SettingsService.getUserSettings(vkId)` находит/создаёт User по VK ID и затем UserSettings по userId. `setUserLocation` записывает найденные имя/координаты/метаданные, `clearUserLocation` обнуляет группу `location*`; `setUserTimeZone` записывает override, `clearUserTimeZone` обнуляет и `timeZone`, и `locationTimeZone`. Эти операции используются [LocationService](../src/services/settings/locationService.md), который предоставляет scope пользователя для [manage_location](../src/services/ai/tools.md#manage_location); погода и текущее время читают выбранные настройки без fallback на другую область.

Единственная schema uniqueness constraint — `userId`; отдельного индекса по location-полям нет. Удаление User каскадно удаляет UserSettings. История изменений локации и отдельный retention для настроек не реализованы в найденных писателях. Остальные readers/writers и migration links перечислены в [матрице](#доступ-приложения-и-хранение) и [карте query scopes](#области-запросов-транзакции-и-тестовые-свидетельства).

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `userId` | `String` | `@unique` | — |
| `user` | `User` | `@relation(fields: [userId], references: [id], onDelete: Cascade)` | — |
| `personality` | `String` | `@default("chipsik")` | — |
| `systemPrompt` | `String?` | `—` | — |
| `voiceEnabled` | `Boolean` | `@default(false)` | — |
| `voice` | `String?` | `—` | — |
| `locationName` | `String?` | `—` | — |
| `locationLatitude` | `Float?` | `—` | — |
| `locationLongitude` | `Float?` | `—` | — |
| `locationCountry` | `String?` | `—` | — |
| `locationRegion` | `String?` | `—` | — |
| `locationTimeZone` | `String?` | `—` | — |
| `timeZone` | `String?` | `—` | — |
| `memoryEnabled` | `Boolean` | `@default(true)` | — |
| `autoMemoryEnabled` | `Boolean` | `@default(true)` | — |
| `characterSettings` | `CharacterUserSetting[]` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## ChatSettings

**Тип:** модель Prisma. **Источник:** [`ChatSettings` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Уникальны по `conversationId`; внешний ключ ссылается на `Conversation` с `onDelete: Cascade`. `mode=normal`, `imageAccess=admins_only`, приветствие и анкета выключены по умолчанию. `locationName`, координаты, страна, регион, `locationTimeZone` и отдельный `timeZone` nullable. `questionnaireQuestions`, `personalitySettings`, `funSettings`, `memeDaySettings` — строковые структурированные данные.

`SettingsService.getChatSettings(conversationId)` upsert-ит Conversation и ChatSettings; для новой Conversation вычисляет `isGroup` сравнением ID с 2 млрд. `setChatLocation` записывает имя/координаты/страну/регион/derived timezone; `clearChatLocation` очищает весь набор `location*`. `setChatTimeZone` меняет явный `timeZone`; `clearChatTimeZone` очищает явный и derived timezone, оставляя город. Их вызывает [LocationService](../src/services/settings/locationService.md) в scope беседы для [manage_location](../src/services/ai/tools.md#manage_location), `/city` и `/timezone`. Погода/время читают эти поля для текущего group scope; явный `timeZone` имеет приоритет над timezone сохранённого места.

Единственная schema uniqueness constraint — `conversationId`; отдельного индекса по location-полям нет. Удаление Conversation каскадно удаляет ChatSettings. Изменения location-полей не имеют отдельного журнала/retention в найденных писателях. Остальные readers/writers и migration links перечислены в [матрице](#доступ-приложения-и-хранение) и [карте query scopes](#области-запросов-транзакции-и-тестовые-свидетельства).

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `@unique` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `mode` | `String` | `@default("normal")` | — |
| `imageAccess` | `String` | `@default("admins_only")` | — |
| `welcomeEnabled` | `Boolean` | `@default(false)` | — |
| `welcomeText` | `String` | `@default("Добро пожаловать, {name}! Рады видеть тебя в беседе.")` | — |
| `questionnaireEnabled` | `Boolean` | `@default(false)` | — |
| `questionnaireQuestions` | `String` | `@default("[\"Сколько лет?\",\"Как к тебе обращаться? (Имя или позывной?)\",\"Работаешь или учишься?\",\"На кого/кем?\",\"Семейное положение: в поиске своего счастья или уже есть вторая половинка?\",\"Сколько в ВРН?\",\"Где любишь гулять?\",\"Кофе или чай?\",\"Какие хобби?\",\"Есть любимые фильмы?\",\"Скинь пару любимых песен.\",\"Ты за активный отдых или лучше фильмец дома глянуть?\",\"Как относишься к алкоголю?\",\"50/50 на первом свидании норм?\",\"Что ждёшь от этой конфы?\",\"Какой MBTI? Ссылка на тест: https:` | www.16personalities.com/ru\"]") |
| `personality` | `String` | `@default("chipsik")` | — |
| `systemPrompt` | `String?` | `—` | — |
| `personalitySettings` | `String` | `@default("{}")` | — |
| `allowPersonalityChange` | `Boolean` | `@default(false)` | — |
| `funAutoReactions` | `Boolean` | `@default(false)` | — |
| `funAutoReactionAt` | `DateTime?` | `—` | — |
| `funAutoIntervalSeconds` | `Int` | `@default(300)` | — |
| `funAutoProbability` | `Int` | `@default(10)` | — |
| `funSettings` | `String` | `@default("{}")` | — |
| `memeDaySettings` | `String` | `@default("{}")` | — |
| `memeDayWeeklyEnabled` | `Boolean` | `@default(false)` | — |
| `locationName` | `String?` | `—` | — |
| `locationLatitude` | `Float?` | `—` | — |
| `locationLongitude` | `Float?` | `—` | — |
| `locationCountry` | `String?` | `—` | — |
| `locationRegion` | `String?` | `—` | — |
| `locationTimeZone` | `String?` | `—` | — |
| `timeZone` | `String?` | `—` | — |
| `memoryEnabled` | `Boolean` | `@default(true)` | — |
| `autoMemoryEnabled` | `Boolean` | `@default(true)` | — |
| `membershipTrackingSince` | `DateTime` | `@default(now())` | — |
| `membershipLastSyncDay` | `String?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## Reminder

**Тип:** модель Prisma. **Источник:** [`Reminder` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Автор, источник и адресат, текст, зона, следующее время, повторение и состояние; по умолчанию `scope=personal`, `status=active`, `deliveryMode=private`. Индексы по состоянию и времени, автору и источнику.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `creatorVkId` | `String` | `—` | — |
| `recipientVkId` | `String?` | `—` | — |
| `sourcePeerId` | `String` | `—` | — |
| `deliveryPeerId` | `String` | `—` | — |
| `scope` | `String` | `@default("personal")` | — |
| `content` | `String` | `—` | — |
| `timeZone` | `String` | `—` | — |
| `nextRunAt` | `DateTime?` | `—` | — |
| `recurrenceRule` | `String?` | `—` | — |
| `recurrenceEndAt` | `DateTime?` | `—` | — |
| `status` | `String` | `@default("active")` | — |
| `deliveryMode` | `String` | `@default("private")` | — |
| `fallbackState` | `String` | `@default("none")` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `source` | `Conversation` | `@relation(fields: [sourcePeerId], references: [id], onDelete: Cascade)` | — |
| `deliveries` | `ReminderDelivery[]` | `—` | — |

### Составные ключи и индексы

- `@@index([status, nextRunAt])`
- `@@index([creatorVkId, scope, status])`
- `@@index([sourcePeerId, scope, status])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## ReminderDelivery

**Тип:** модель Prisma. **Источник:** [`ReminderDelivery` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Попытки отдельного наступления, блокировка, ошибка и `randomId`; уникальна пара `reminderId,occurrenceAt`, удаляется каскадно с напоминанием.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `reminderId` | `String` | `—` | — |
| `occurrenceAt` | `DateTime` | `—` | — |
| `status` | `String` | `@default("pending")` | — |
| `attempts` | `Int` | `@default(0)` | — |
| `nextAttemptAt` | `DateTime` | `@default(now())` | — |
| `lockUntil` | `DateTime?` | `—` | — |
| `randomId` | `Int` | `—` | — |
| `lastError` | `String?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `reminder` | `Reminder` | `@relation(fields: [reminderId], references: [id], onDelete: Cascade)` | — |

### Составные ключи и индексы

- `@@unique([reminderId, occurrenceAt])`
- `@@index([status, nextAttemptAt])`
- `@@index([reminderId, occurrenceAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## ReminderDraft

**Тип:** модель Prisma. **Источник:** [`ReminderDraft` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Состояние и сериализованный `payload` уточнения с `expiresAt`; уникален для пары автора и беседы.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `creatorVkId` | `String` | `—` | — |
| `conversationId` | `String` | `—` | — |
| `state` | `String` | `—` | — |
| `payload` | `String` | `—` | — |
| `expiresAt` | `DateTime` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([creatorVkId, conversationId])`
- `@@index([expiresAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## ConversationMember

**Тип:** модель Prisma. **Источник:** [`ConversationMember` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Участие и анкета конкретного VK-пользователя в беседе; уникальна пара `conversationId,vkUserId`, есть индексы присутствия и заполненности профиля. `profile`, вопросы и ответы — строковые данные.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `vkUserId` | `String` | `—` | — |
| `isPresent` | `Boolean` | `@default(false)` | — |
| `firstJoinedAt` | `DateTime` | `@default(now())` | — |
| `lastJoinedAt` | `DateTime?` | `—` | — |
| `leftAt` | `DateTime?` | `—` | — |
| `profile` | `String` | `@default("{}")` | — |
| `profileCompleted` | `Boolean` | `@default(false)` | — |
| `profileCreatedAt` | `DateTime?` | `—` | — |
| `profileUpdatedAt` | `DateTime?` | `—` | — |
| `questionnaireInviteSentAt` | `DateTime?` | `—` | — |
| `lastJoinIntroductionEventId` | `String?` | `—` | — |
| `profileDeleteRequestedAt` | `DateTime?` | `—` | — |
| `questionnaireQuestions` | `String?` | `—` | — |
| `questionnaireAnswers` | `String?` | `—` | — |
| `questionnaireIndex` | `Int?` | `—` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([conversationId, vkUserId])`
- `@@index([conversationId, isPresent])`
- `@@index([conversationId, profileCompleted, profileUpdatedAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## MembershipEvent

**Тип:** модель Prisma. **Источник:** [`MembershipEvent` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Тип и источник входа/выхода участника, актор и время; уникальная пара `conversationId,eventId`, индексы по периоду, участнику и типу.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `memberId` | `String` | `—` | — |
| `memberType` | `String` | `—` | user \| community (communities and bots) |
| `type` | `String` | `—` | join \| leave |
| `eventId` | `String` | `—` | — |
| `source` | `String` | `—` | chat_invite_user \| chat_invite_user_by_link \| chat_invite_user_by_message_request \| chat_kick_user |
| `actorId` | `String?` | `—` | — |
| `occurredAt` | `DateTime` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([conversationId, eventId])`
- `@@index([conversationId, occurredAt])`
- `@@index([conversationId, memberId, occurredAt])`
- `@@index([conversationId, type, occurredAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## DigestJob

**Тип:** модель Prisma. **Источник:** [`DigestJob` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Задача истории с `activeKey @unique`, состоянием, периодом или количеством, участниками, частями, результатом, ошибкой и отметкой доставки. Индексы по беседе, автору, состоянию и времени. Схема не задаёт внешние ключи для `conversationId` и `userId`.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `userId` | `String` | `—` | — |
| `activeKey` | `String?` | `@unique` | — |
| `kind` | `String` | `@default("digest")` | — |
| `status` | `String` | `@default("pending")` | — |
| `instruction` | `String?` | `—` | — |
| `format` | `String?` | `—` | — |
| `requestedCount` | `Int?` | `—` | — |
| `rangeFrom` | `DateTime?` | `—` | — |
| `rangeTo` | `DateTime?` | `—` | — |
| `maxDigestChars` | `Int` | `@default(15000)` | — |
| `maxOutputChars` | `Int` | `@default(3500)` | — |
| `parts` | `Int` | `@default(1)` | — |
| `partResults` | `String?` | `—` | — |
| `participants` | `String?` | `—` | — |
| `messageId` | `Int?` | `—` | — |
| `conversationMessageId` | `Int?` | `—` | — |
| `digests` | `String?` | `—` | — |
| `result` | `String?` | `—` | — |
| `error` | `String?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `completedAt` | `DateTime?` | `—` | — |
| `resultSentAt` | `DateTime?` | `—` | — |

### Составные ключи и индексы

- `@@index([conversationId, userId])`
- `@@index([conversationId, createdAt])`
- `@@index([status, updatedAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

### Известные операции `DigestJob`

[`SubagentService`](../src/services/ai/subagentService.md) создаёт строку как `kind=history_task`, `status=pending`, привязывает `conversationId`/`userId`, устанавливает уникальный `activeKey` равным ID беседы и записывает запрос, периоды/количество, части, участников и исходные message IDs. Уникальный nullable `activeKey` сериализует активную задачу на беседу; конфликт `P2002` преобразуется в `already_running`. В том же сервисе выполняются оценка, очередь, обработка частей и финализация. По таймауту задача помечается `failed`, `activeKey` очищается.

`getLatestStatus(conversationId)` выбирает последнюю запись беседы по `createdAt` без фильтра `kind` или `userId`; поэтому в группе это не обязательно задача текущего участника. Эту запись читает `get_subagent_status`. `SubagentResultDeliveryService` выбирает недоставленный результат и ставит `resultSentAt`; подробности — в [сервисе доставки](../src/services/ai/subagentResultDeliveryService.md) и [job](../src/jobs/subagentDeliveryJob.md).

`SubagentService.cleanupOldJobs` применяет `SUBAGENT_RESULT_RETENTION_DAYS` (7 дней по умолчанию) к `createdAt` и удаляет записи старше cutoff со статусом `done`, `failed` или `partial`; проверка `resultSentAt` перед удалением не выполняется. Prisma-схема не связывает `DigestJob` внешними ключами с `Conversation`/`User`, поэтому ссылочную целостность этих ID обеспечивают callers. Тестовые фабрики подменяют storage; отдельные тесты lifecycle с реальной SQLite/Prisma не обнаружены.

## FunPreference

**Тип:** модель Prisma. **Источник:** [`FunPreference` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Строка настроек; уникальна пара пользователя VK и беседы.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `vkUserId` | `String` | `—` | — |
| `conversationId` | `String` | `—` | — |
| `settings` | `String` | `@default("{}")` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([vkUserId, conversationId])`
- `@@index([conversationId, updatedAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## FunOutput

**Тип:** модель Prisma. **Источник:** [`FunOutput` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Развлекательный результат в беседе с типом, текстом и отзывами; связь с беседой каскадная.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `vkUserId` | `String` | `—` | — |
| `kind` | `String` | `—` | — |
| `content` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `feedback` | `FunFeedback[]` | `—` | — |

### Составные ключи и индексы

- `@@index([conversationId, kind, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## FunFeedback

**Тип:** модель Prisma. **Источник:** [`FunFeedback` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Отзыв пользователя на `FunOutput`; уникальная пара `outputId,vkUserId`, каскадное удаление.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `outputId` | `String` | `—` | — |
| `output` | `FunOutput` | `@relation(fields: [outputId], references: [id], onDelete: Cascade)` | — |
| `vkUserId` | `String` | `—` | — |
| `value` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([outputId, vkUserId])`
- `@@index([outputId, value])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## MemeDayPublication

**Тип:** модель Prisma. **Источник:** [`MemeDayPublication` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Публикация, тип, тема, подпись, вложение, статус, попытки и блокировка; `scheduleKey` уникален, связь с беседой каскадная.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `funOutputId` | `String?` | `—` | — |
| `kind` | `String` | `—` | — |
| `topic` | `String` | `—` | — |
| `caption` | `String` | `—` | — |
| `imageUrl` | `String?` | `—` | — |
| `attachment` | `String?` | `—` | — |
| `scheduleKey` | `String?` | `@unique` | — |
| `status` | `String` | `@default("pending")` | — |
| `attempts` | `Int` | `@default(0)` | — |
| `nextAttemptAt` | `DateTime?` | `—` | — |
| `lockUntil` | `DateTime?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `votes` | `MemeDayVote[]` | `—` | — |

### Составные ключи и индексы

- `@@index([conversationId, kind, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## MemeDayVote

**Тип:** модель Prisma. **Источник:** [`MemeDayVote` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Голос за публикацию; уникальная пара `publicationId,vkUserId`, связь каскадная.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `publicationId` | `String` | `—` | — |
| `publication` | `MemeDayPublication` | `@relation(fields: [publicationId], references: [id], onDelete: Cascade)` | — |
| `vkUserId` | `String` | `—` | — |
| `value` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([publicationId, vkUserId])`
- `@@index([publicationId, value])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## PersonalityProfile

**Тип:** модель Prisma. **Источник:** [`PersonalityProfile` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

ID, имя, описание, пример, системная инструкция, настройки, доступность для ЛС/бесед, списки допуска и версия; списки и настройки хранятся строками.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id` | — |
| `name` | `String` | `—` | — |
| `description` | `String` | `—` | — |
| `example` | `String` | `—` | — |
| `systemPrompt` | `String` | `—` | — |
| `settings` | `String` | `@default("{}")` | — |
| `enabled` | `Boolean` | `@default(true)` | — |
| `directEnabled` | `Boolean` | `@default(true)` | — |
| `chatEnabled` | `Boolean` | `@default(true)` | — |
| `allowedUsers` | `String` | `@default("[]")` | — |
| `allowedChats` | `String` | `@default("[]")` | — |
| `version` | `Int` | `@default(1)` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `versions` | `PersonalityProfileVersion[]` | `—` | — |
| `userSettings` | `CharacterUserSetting[]` | `—` | — |
| `usage` | `PersonalityUsage[]` | `—` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## PersonalityProfileVersion

**Тип:** модель Prisma. **Источник:** [`PersonalityProfileVersion` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Снимок версии персонажа и автор изменения; пара `personalityId,version` уникальна, связь каскадная.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `personalityId` | `String` | `—` | — |
| `personality` | `PersonalityProfile` | `@relation(fields: [personalityId], references: [id], onDelete: Cascade)` | — |
| `version` | `Int` | `—` | — |
| `name` | `String` | `—` | — |
| `description` | `String` | `—` | — |
| `example` | `String` | `—` | — |
| `systemPrompt` | `String` | `—` | — |
| `settings` | `String` | `—` | — |
| `enabled` | `Boolean` | `@default(true)` | — |
| `changedBy` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([personalityId, version])`
- `@@index([personalityId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## CharacterUserSetting

**Тип:** модель Prisma. **Источник:** [`CharacterUserSetting` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Настройки конкретного персонажа пользователя; пара `userSettingsId,personalityId` уникальна, связи каскадные.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `userSettingsId` | `String` | `—` | — |
| `userSettings` | `UserSettings` | `@relation(fields: [userSettingsId], references: [id], onDelete: Cascade)` | — |
| `personalityId` | `String` | `—` | — |
| `personality` | `PersonalityProfile` | `@relation(fields: [personalityId], references: [id], onDelete: Cascade)` | — |
| `settings` | `String` | `@default("{}")` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([userSettingsId, personalityId])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## PersonalityChange

**Тип:** модель Prisma. **Источник:** [`PersonalityChange` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Аудит смены персонажа: беседа, область, автор, прежний и новый ID, время; внешние ключи на эти идентификаторы схемой не заданы.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `scope` | `String` | `—` | — |
| `changedBy` | `String` | `—` | — |
| `fromId` | `String?` | `—` | — |
| `toId` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@index([conversationId, createdAt])`
- `@@index([changedBy, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## PersonalityUsage

**Тип:** модель Prisma. **Источник:** [`PersonalityUsage` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Использование персонажа пользователем в беседе; связь с персонажем каскадная, индексы по персонажу и беседе.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `personalityId` | `String` | `—` | — |
| `personality` | `PersonalityProfile` | `@relation(fields: [personalityId], references: [id], onDelete: Cascade)` | — |
| `conversationId` | `String` | `—` | — |
| `vkUserId` | `String` | `—` | — |
| `scope` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@index([personalityId, createdAt])`
- `@@index([conversationId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## Admin

**Тип:** модель Prisma. **Источник:** [`Admin` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Уникальный VK ID администратора.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `vkId` | `String` | `@unique` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## AppSetting

**Тип:** модель Prisma. **Источник:** [`AppSetting` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Глобальный параметр с `key` как первичным ключом и строковым значением.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `key` | `String` | `@id` | — |
| `value` | `String` | `—` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

Составные ограничения и дополнительные индексы в модели не объявлены.

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## GameSession

**Тип:** модель Prisma. **Источник:** [`GameSession` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Игра и состояние в беседе, сериализованные `data`, время начала/окончания; индекс по беседе и состоянию, связь с беседой каскадная.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `conversationId` | `String` | `—` | — |
| `conversation` | `Conversation` | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` | — |
| `game` | `String` | `—` | — |
| `state` | `String` | `@default("active")` | — |
| `data` | `String` | `@default("{}")` | — |
| `startedAt` | `DateTime` | `@default(now())` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |
| `endedAt` | `DateTime?` | `—` | — |
| `scores` | `GameScore[]` | `—` | — |
| `events` | `GameEvent[]` | `—` | — |

### Составные ключи и индексы

- `@@index([conversationId, state])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## GameScore

**Тип:** модель Prisma. **Источник:** [`GameScore` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Очки пользователя в сессии; уникальная пара `sessionId,vkUserId`, каскадное удаление.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `sessionId` | `String` | `—` | — |
| `session` | `GameSession` | `@relation(fields: [sessionId], references: [id], onDelete: Cascade)` | — |
| `vkUserId` | `String` | `—` | — |
| `points` | `Int` | `@default(0)` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([sessionId, vkUserId])`
- `@@index([vkUserId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## GameEvent

**Тип:** модель Prisma. **Источник:** [`GameEvent` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Событие пользователя в сессии; уникальная пара `sessionId,eventId`, каскадное удаление.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `sessionId` | `String` | `—` | — |
| `session` | `GameSession` | `@relation(fields: [sessionId], references: [id], onDelete: Cascade)` | — |
| `vkUserId` | `String` | `—` | — |
| `eventId` | `String` | `—` | — |
| `kind` | `String` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([sessionId, eventId])`
- `@@index([sessionId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## GamePlayerStats

**Тип:** модель Prisma. **Источник:** [`GamePlayerStats` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Счётчики и рекорды по `scope,scopeId,vkUserId`; эта тройка уникальна.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `scope` | `String` | `—` | — |
| `scopeId` | `String` | `—` | — |
| `vkUserId` | `String` | `—` | — |
| `gamesPlayed` | `Int` | `@default(0)` | — |
| `wins` | `Int` | `@default(0)` | — |
| `answers` | `Int` | `@default(0)` | — |
| `correctAnswers` | `Int` | `@default(0)` | — |
| `bestScore` | `Int` | `@default(0)` | — |
| `currentWinStreak` | `Int` | `@default(0)` | — |
| `bestWinStreak` | `Int` | `@default(0)` | — |
| `excludedFromGlobal` | `Boolean` | `@default(false)` | — |
| `updatedAt` | `DateTime` | `@updatedAt` | — |

### Составные ключи и индексы

- `@@unique([scope, scopeId, vkUserId])`
- `@@index([scope, scopeId, bestScore])`
- `@@index([vkUserId, scope])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## Achievement

**Тип:** модель Prisma. **Источник:** [`Achievement` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Код достижения и необязательные метаданные; уникальная пара `vkUserId,code`.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `vkUserId` | `String` | `—` | — |
| `code` | `String` | `—` | — |
| `metadata` | `String?` | `—` | — |
| `earnedAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@unique([vkUserId, code])`
- `@@index([vkUserId, earnedAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## ApiUsage

**Тип:** модель Prisma. **Источник:** [`ApiUsage` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Провайдер, функция, необязательные пользователь/беседа, токены и оценочная стоимость; индексы по времени и пользователю.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `vkUserId` | `String?` | `—` | — |
| `conversationId` | `String?` | `—` | — |
| `provider` | `String` | `—` | — |
| `feature` | `String` | `—` | — |
| `inputTokens` | `Int?` | `—` | — |
| `outputTokens` | `Int?` | `—` | — |
| `estimatedCost` | `Float?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@index([createdAt])`
- `@@index([vkUserId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## AdminLog

**Тип:** модель Prisma. **Источник:** [`AdminLog` в schema.prisma](../../../prisma/schema.prisma); [миграции](../../../prisma/migrations).

Действие администратора, необязательные детали и время; индексы по времени и администратору.

Прямые readers/writers и известные правила удаления/хранения перечислены в [матрице доступа и хранения](#доступ-приложения-и-хранение). Для query filters, прав и транзакций используйте спецификацию соответствующего сервиса.

### Поля и атрибуты схемы

| Поле | Тип | Атрибуты | Комментарий схемы |
| --- | --- | --- | --- |
| `id` | `String` | `@id @default(cuid())` | — |
| `adminVkId` | `String` | `—` | — |
| `action` | `String` | `—` | — |
| `details` | `String?` | `—` | — |
| `createdAt` | `DateTime` | `@default(now())` | — |

### Составные ключи и индексы

- `@@index([createdAt])`
- `@@index([adminVkId, createdAt])`

### Владение, использование и хранение

Внешние связи и допустимость `NULL` видны в таблице полей; scalar ID без `@relation` не является объявленным FK. Прямые readers/writers и найденные deletion/retention правила сведены в [матрице доступа и хранения](#доступ-приложения-и-хранение); связи и каскады показаны в полях выше. Авторизацию, область выборки и транзакционные границы проверяйте по связанным сервисам.

## Доступ приложения и хранение

Матрица получена статическим поиском всех прямых Prisma delegate вызовов в `src/`, включая `this.database`, `tx` и `transaction`. Она фиксирует владельцев доступа и названия операций, но не заменяет описание фильтров/авторизации в сервисе. `ConversationParticipant` — единственная модель без найденных прямых readers/writers. История миграций с указанием затронутых моделей находится в [migrations.md](migrations.md).

| Модель | Чтение/запись в коде | Прямое удаление и хранение |
| --- | --- | --- |
| `User` | `MemoryService` (upsert, findUnique/findMany), `LongTermMemoryService` (findUnique/upsert), `SettingsService` и `CharacterService` (upsert), `CommandService` (findUnique/count). | Удаления User в `src/` не найдено. FK некоторых дочерних записей каскадны, у `ConversationParticipant` — `RESTRICT`; фактический путь удаления пользователя отсутствует. |
| `Conversation` | `MemoryService` (findUnique/create), `SettingsService`, `CharacterService`, `GameService`, `MafiaService`, `LongTermMemoryService` (upsert), `CommandService` (count). | Прямое удаление не найдено. Удаление родителя каскадно затронуло бы связанные сущности с `onDelete: Cascade`; runtime caller удаления не найден. |
| `ConversationParticipant` | В `src/` не обнаружены Prisma-вызовы для этой модели; есть только schema/migration relation. | Runtime retention/writer отсутствует; оба FK в начальной миграции `RESTRICT`. Проверить существующие строки без чтения БД нельзя. |
| `Message` | `MemoryService` (create/findFirst/findMany/groupBy/deleteMany), `ChatDigestService` (count/findMany), `CommandService` (count), `MemeService` (findMany), `MemeDayJob` (count), `VkService` (findMany). | `MemoryService.cleanupOldContext` удаляет сообщения старше TTL (24 часа по умолчанию), если беседа не сохраняет недельный контекст; все сообщения старше семи дней удаляются. `clearUserHistory` удаляет выбранную историю пользователя. |
| `LongTermMemory` | `LongTermMemoryService` (create/findFirst/findMany/update/updateMany/delete/deleteMany). | Истёкшие записи архивируются через `archivedAt`, а не удаляются автоматически; явная очистка области или подтверждённое удаление удаляют строки. FK пользователя/беседы каскадны. |
| `MemoryActionDraft` | `LongTermMemoryService` (upsert/findUnique/delete/deleteMany). | Черновики имеют срок 10 минут и удаляются при истечении, отмене или завершении выбора; FK пользователя/беседы каскадны. |
| `UserSettings` | `SettingsService`, `CharacterService`, `LongTermMemoryService` (find/upsert/update); `CommandService` читает/обновляет voice setting. | Явного удаления нет; relation с User задаёт каскад. |
| `ChatSettings` | `SettingsService`, `CharacterService`, `MembershipService`, `CommandService`, `FunService`, `MemeDayService`, `LongTermMemoryService`, `VkService` (find/upsert/update/updateMany). | Явного удаления нет; relation с Conversation задаёт каскад. `IMAGE_ADMIN_ONLY` задаёт default только при создании, см. [конфигурацию](../src/config/index.md). |
| `Reminder` | `ReminderService` (create/findMany/findUnique/update/updateMany), в том числе транзакции claims и переходов. | Отмена/пауза/ошибки меняют status; прямого удаления напоминания не найдено. Временная очистка не удаляет историю напоминаний. FK `sourcePeerId` каскадный. |
| `ReminderDelivery` | `ReminderService` (create/findFirst/findMany/update/updateMany), в том числе транзакции резервирования и результата доставки. | Статус и попытки сохраняются; прямого удаления delivery или отдельной retention очистки не найдено. FK Reminder каскадный. |
| `ReminderDraft` | `ReminderService` (findFirst/findMany/upsert/delete/deleteMany). | Временные черновики удаляются при отмене/завершении/истечении; для создания действует срок 30 минут, для согласия на fallback-доставку — 24 часа. |
| `ConversationMember` | `MemberService` (count/findMany/findUnique/update/updateMany/upsert), `MembershipService` (count/findMany/updateMany/upsert), `CommandService` (findMany/findUnique). | Выход отмечается как отсутствие/изменение полей, direct delete не найден; сведения о бывших участниках сохраняются. FK беседы каскадный. |
| `MembershipEvent` | `MembershipService` (create/count/groupBy). | Прямое удаление и retention job не найдены; история событий накапливается. В схеме нет FK к Conversation или ConversationMember. |
| `DigestJob` | `SubagentService` (count/create/deleteMany/findFirst/findUnique/update/updateMany), `SubagentResultDeliveryService` (findMany/findUnique/update). | Прерванные/устаревшие активные задания и завершённые `done/failed/partial` старше `SUBAGENT_RESULT_RETENTION_DAYS` удаляются. Модель не имеет FK к User/Conversation. Подробности — [контракт модели выше](#digestjob). |
| `FunPreference` | `FunService` (upsert), `MemeService` и `VkService` (findMany). | Прямое удаление и retention не найдены; настройки сохраняются по паре автора и беседы. |
| `FunOutput` | `FunService` (create/findFirst/findFirstOrThrow/findMany/deleteMany), `MemeService` (create/findMany/deleteMany), `VkService` (deleteMany). | После генерации сохраняются максимум 30 результатов на пару беседа/тип; неудачная отправка может удалить новый output. `FunFeedback` удаляется каскадно при удалении output. |
| `FunFeedback` | `FunService` (upsert/groupBy). | Перезаписывается оценка пользователя; отдельное удаление/retention не найдено, FK output каскадный. |
| `MemeDayPublication` | `MemeDayService` (count/create/deleteMany/findFirst/findMany/findUnique/findUniqueOrThrow/update/updateMany), `MemeService` (findMany). | Неудачная ручная запись `generating` удаляется; расписанные записи переводятся между статусами, общего срока удаления опубликованных публикаций не найдено. Голоса удаляются по FK cascade. |
| `MemeDayVote` | `MemeDayService` (upsert/findMany). | Голос текущего пользователя заменяется upsert; отдельной retention очистки нет, FK публикации каскадный. |
| `PersonalityProfile` | `CharacterService` (create/findMany/findUnique/update/upsert). | Сервис меняет доступность и содержимое профиля; direct delete не найден. Связанные версии и usage имеют каскад на профиль. |
| `PersonalityProfileVersion` | `CharacterService` (create/findUnique/upsert). | Direct delete/retention не найдены; FK профиля каскадный. |
| `CharacterUserSetting` | `CharacterService` (findUnique/upsert/deleteMany). | Удаляется при сбросе пользовательских параметров персонажа; FK `UserSettings` и `PersonalityProfile` каскадные. |
| `PersonalityChange` | `CharacterService` (create). | Только запись в найденном коде; прямого удаления и retention не найдено. Внешние идентификаторы не являются FK. |
| `PersonalityUsage` | `CharacterService` (create/groupBy). | Только запись и агрегация в найденном коде; прямого удаления/retention не найдено, FK профиля каскадный. |
| `Admin` | `SettingsService` (findUnique/upsert/deleteMany). | Роль удаляется при снятии администратора; creator и ID из `VK_ADMIN_IDS` защищены от удаления этим путём. |
| `AppSetting` | `SettingsService` и `CharacterService` (findUnique/upsert). | Изменение перезаписывает значение ключа; direct delete и retention не найдены. |
| `GameSession` | `GameService`, `MafiaService`, `AdventureService` (create/findFirst/findMany/findUnique/update/updateMany/delete), `GameInteractionService` (findMany), `CommandService` (create/findFirst/update). | Обычные игры сохраняют состояние/завершение в строке. `AdventureService` удаляет запись при `abort`; каскадно удаляются её `GameEvent` и связанные сессией `GameScore` по схеме. Общей очистки завершённых сессий не найдено. |
| `GameScore` | `GameService` и `MafiaService` (upsert), `CommandService` (upsert/findMany/aggregate). | Сводные очки хранятся без найденной retention очистки; FK к `GameSession` каскадный, но агрегатная статистика отдельно живёт в `GamePlayerStats`. |
| `GameEvent` | `GameService`, `MafiaService`, `GameInteractionService` (create/findUnique). | Используется для дедупликации игровых событий; прямого удаления нет, FK сессии каскадный. |
| `GamePlayerStats` | `GameService`, `MafiaService` (findUnique/upsert), `GameService` также findMany. | Агрегаты обновляются upsert; retention/удаление не найдены, FK к сессии нет. |
| `Achievement` | `GameService` (findMany/upsert). | Выдача уникальна по пользовательскому/игровому ключу; direct delete/retention не найдены. |
| `ApiUsage` | Запись: `CommandService`, `FunService`, `MemeService`, `AdventureService`, `SubagentResultDeliveryService`, `VkService`; чтение: `CommandService` (count/aggregate). | Записи учитывают статистику/стоимость, direct delete и retention job не найдены; возможен неограниченный рост таблицы. |
| `AdminLog` | `SettingsService` (create), `CommandService` (findMany). | Журнал доступен в `/logs`; direct delete/retention не найдены. |

## Области запросов, транзакции и тестовые свидетельства

Ниже зафиксирована область `where` и связанные правила доступа, чтобы отличать идентификатор модели от реального tenant scope. Точные ветви и вызывающие handlers остаются в канонических сервисных спецификациях, указанных в последней колонке.

| Модель | Фактическая область чтения/изменения | Канонический контракт |
| --- | --- | --- |
| `User` | Идентификация по уникальному `vkId`; memory/settings операции далее используют внутренний `id`. Профили участников не обязаны иметь строку `User`. | [MemoryService](../src/services/memory/memoryService.md), [настройки](../src/services/settings/settingsService.md), [команды статистики](../src/services/command/commands.md#command-stats) |
| `Conversation` | ID равен VK peer ID строкой; сервисы адресуют конкретную беседу. Длительность хранения определяется дочерними моделями, автоматического удаления Conversation в `src/` нет. | [архитектура](../src/architecture.md), [настройки](../src/services/settings/settingsService.md) |
| `ConversationParticipant` | Прямого запроса приложения нет; отношение присутствует только в schema/migrations. | Состояние отсутствия использования зафиксировано в [матрице операций](#доступ-приложения-и-хранение) |
| `Message` | History/context используют `conversationId`, а user context также `userId`; недавний общий контекст ограничен `role in (user, assistant)` и TTL. History tools дополнительно ограничивают авторов/период/ID. Reset/forget удаляют по `userId` с optional `conversationId`. | [MemoryService](../src/services/memory/memoryService.md), [history tools](../src/services/ai/tools.md#get_local_chat_history), [chat digest](../src/services/ai/chatDigestService.md) |
| `LongTermMemory` | Личная область — `userId`; общая — `conversationId`; выдача дополнительно `scope`, `archivedAt=null`, неистёкший `expiresAt`. Общую память могут очищать администраторы; изменение/удаление чужого факта проверяет автора/admin. | [LongTermMemoryService](../src/services/memory/longTermMemoryService.md) |
| `MemoryActionDraft` | Уникальная пара `(userId, conversationId)` привязывает выбор к запросившему автору и peer; список кандидатов сохраняет scope. Срок выбора 10 минут. | [LongTermMemoryService](../src/services/memory/longTermMemoryService.md) |
| `UserSettings` | Уникальный `userId`, создаётся по текущему VK ID. Права на собственные параметры идут от sender; привилегированные глобальные actions используют отдельные command guards. | [настройки](../src/services/settings/settingsService.md), [персонажи](../src/services/settings/characterService.md), [голос](../src/services/command/commands.md#command-voice), [память](../src/services/memory/longTermMemoryService.md) |
| `ChatSettings` | Уникальный `conversationId` — peer scope. Административные изменения перед записью проверяются в command/VK layer; сервисы настроек сами принимают peer ID. | [настройки](../src/services/settings/settingsService.md), [VK guards](../src/services/vk/vkService.md), [команды](../src/services/command/commands.md) |
| `Reminder` | `ReminderService` ограничивает управление автором, scope, текущей беседой/peer, статусом и идентификатором цели; due selection только `status=active, nextRunAt<=now`. | [ReminderService](../src/services/reminders/reminderService.md) |
| `ReminderDelivery` | Связь с reminder; создание уникально для occurrence. Claim ограничен delivery ID/status/сроком попытки, повторный sender вызов использует сохранённый `randomId`. | [ReminderService](../src/services/reminders/reminderService.md) |
| `ReminderDraft` | Ключ `(creatorVkId, conversationId)` привязывает один pending flow к автору и peer; каждый обработчик повторно проверяет статус/срок и ожидаемый тип draft. | [ReminderService](../src/services/reminders/reminderService.md) |
| `ConversationMember` | Ключ `(conversationId,vkUserId)`; профили и присутствие всегда беседо-специфичны. Admin profile operations получают target ID только после command-level authorization. Синхронизация ограничена peer и `isPresent`. | [MemberService](../src/services/member/memberService.md), [MembershipService](../src/services/membership/membershipService.md), [команды профиля](../src/services/command/commands.md#command-profile) |
| `MembershipEvent` | Уникальность `conversationId,eventId`; статистика фильтрует `conversationId`, период `occurredAt`, тип `join/leave`; агрегация группирует по `memberId`. | [MembershipService](../src/services/membership/membershipService.md), [VK events](../src/services/membership/vkEvents.md) |
| `DigestJob` | Создание привязано к requester/conversation; active `activeKey` сериализует одну выполняемую задачу на peer. Статусный lookup намеренно выбирает последнюю запись беседы без `kind/userId` фильтра. | [SubagentService](../src/services/ai/subagentService.md), [status tool](../src/services/ai/tools.md#get_subagent_status) |
| `FunPreference` | Уникальная пара VK user ID и conversation ID; персональные настройки юмора не смешиваются между участниками и беседами. | [FunService](../src/services/fun/funService.md) |
| `FunOutput` | Чтение/лимиты ограничены беседой, типом результата, автором или временным окном в зависимости от operation. Последний output для повтора проверяется по беседе/автору. | [FunService](../src/services/fun/funService.md), [MemeService](../src/services/fun/memeService.md) |
| `FunFeedback` | Upsert по output/user; перед записью output должен принадлежать текущей беседе, но отдельная проверка владельца output отсутствует. | [FunService](../src/services/fun/funService.md) |
| `MemeDayPublication` | Действия по ID дополнительно связываются с conversation ID, schedule key и допустимыми статусами; публикации выбираются по беседе/дате/типу. | [MemeDayService](../src/services/fun/memeDayService.md), [MemeService](../src/services/fun/memeService.md) |
| `MemeDayVote` | Upsert ограничен парой publication/user; доступ к публикации и active voting проверяются перед записью. | [MemeDayService](../src/services/fun/memeDayService.md) |
| `PersonalityProfile` | Профиль ищется по ID, а доступность/видимость и выбор ограничены scope, peer, user settings и permissions вызывающего маршрута. | [CharacterService](../src/services/settings/characterService.md), [personality command](../src/services/command/commands.md#command-personality) |
| `PersonalityProfileVersion` | Snapshot записывается в контексте profile ID/version; rollback читает точную пару `(personalityId,version)`. | [CharacterService](../src/services/settings/characterService.md) |
| `CharacterUserSetting` | Привязка к `UserSettings` и profile ID; чтение/сброс ограничены текущим пользователем и персонажем. | [CharacterService](../src/services/settings/characterService.md) |
| `PersonalityChange` | В найденном коде только запись: `conversationId`, `scope`, `changedBy`, `fromId`, `toId`; reader или отдельный интерфейс истории не найден. Выбор профиля и audit row выполняются транзакционно. | [CharacterService](../src/services/settings/characterService.md) |
| `PersonalityUsage` | Запись профиля/пользователя/peer/context; админские агрегаты группируют usage по профилю/периоду. | [CharacterService](../src/services/settings/characterService.md) |
| `Admin` | Поиск по VK ID; добавление/удаление защищается creator/admin rules, а постоянный `VK_ADMIN_IDS` не удаляется через database operation. | [SettingsService](../src/services/settings/settingsService.md), [admin command](../src/services/command/commands.md#command-admin) |
| `AppSetting` | Читается по `key`; изменения глобальны, защищаются bot-admin command guard и отдельными проверками для character defaults. | [SettingsService](../src/services/settings/settingsService.md), [model/effort commands](../src/services/command/commands.md#command-model) |
| `GameSession` | Поиск по peer, mode, status, phase, deadline или session ID; команды повторно проверяют host/member/admin в состоянии сессии. | [GameService](../src/services/games/gameService.md), [MafiaService](../src/services/games/mafiaService.md), [AdventureService](../src/services/games/adventureService.md) |
| `GameScore` | Сессия/участник либо агрегат по VK user ID; leaderboard ограничивает scope беседой/глобальным режимом и приватностью. | [GameService](../src/services/games/gameService.md), [команды](../src/services/command/commands.md#command-games) |
| `GameEvent` | Дедупликация по уникальному `(sessionId,eventId)` внутри конкретной игровой сессии; события создаются вместе с state commit в соответствующих сервисах. | [GameService](../src/services/games/gameService.md), [MafiaService](../src/services/games/mafiaService.md) |
| `GamePlayerStats` | Upsert и aggregation по `(scope,scopeId,vkUserId)`; текущая беседа и глобальный scope разделены. | [GameService](../src/services/games/gameService.md) |
| `Achievement` | Lookup/upsert по user/code; не имеет relation к User, поэтому пользовательская область основана на VK ID в строке. | [GameService](../src/services/games/gameService.md) |
| `ApiUsage` | Пользовательские отчёты фильтруют `vkUserId`; admin aggregates считают глобальный объём либо feature/day selectors. Retention не найден. | [команды статистики](../src/services/command/commands.md#command-stats), [VkService](../src/services/vk/vkService.md) |
| `AdminLog` | Запись по actor VK ID; `/logs` читает последние 10 записей глобально без фильтра по peer или вызывающему админу. | [SettingsService](../src/services/settings/settingsService.md), [logs command](../src/services/command/commands.md#command-logs) |

### Транзакционные границы

Статический поиск `prisma.$transaction` обнаружил 17 call sites в четырёх сервисах. `MembershipService` группирует до 100 upsert-ов `ConversationMember` в транзакцию на batch, но mark-absent выполняет отдельными `updateMany`. `CharacterService` атомарно сохраняет текущее изменение выбора/профиля вместе с audit/version row для операций выбора, создания, edit, enable и rollback; предварительное чтение не входит в транзакцию. `GameService` и `MafiaService` связывают `GameEvent`, состояние сессии, очки и/или агрегаты статистики внутри callback-транзакций. `ReminderService` связывает claim напоминания с созданием delivery, отправленную delivery с продвижением occurrence, постоянную ошибку с переходом reminder, а также несколько операций управления/cancel. Все остальные прямые Prisma операции из матрицы не входят в явную `$transaction`; отдельные conditional `updateMany`/unique constraints всё равно обеспечивают локальные атомарные guards. Внешние VK/API вызовы не являются частью Prisma-транзакций.

### Тестовые свидетельства и границы

Текущие 21 `test/*.test.ts` перечислены в [test README](../test/README.md). Тесты в основном проверяют pure formatting/validation и моки сервисов/tools; прямого теста Prisma schema, миграций или реальной SQLite транзакции нет. Из относящихся к моделям сценариев: `membershipService.test.ts` проверяет только formatter; `membershipCommand.test.ts` проверяет guards/аргументы команды с mock service; `personalityService.test.ts` проверяет IDs/aliases, не историю версий; `vkMessageDeliveryIntegration.test.ts` подменяет memory stores; domain Prisma state paths игр, напоминаний, member profiles и memory extraction напрямую не проверяются. Это описывает имеющиеся доказательства; отсутствие теста не является неописанным runtime behavior.

Физическая operational DB намеренно не читалась. Schema и все 22 migration SQL описаны статически; это не подтверждает, что конкретный файл БД уже применил последнюю миграцию или не содержит legacy rows.


