# Стиль TypeScript

После `npm ci` запустите `npm run format`, чтобы применить формат, или `npm run format:check`, чтобы проверить его. Обе команды используют одну закреплённую версию Prettier и охватывают код в `src`, `tests`, `scripts` и корневые конфигурации ESLint и Vitest. Нумерованные миграции исключены. Prettier использует отступ в два пробела, одинарные кавычки и ориентир в 100 знаков на строку.

Для отдельного модуля и его теста укажите пути явно.

```bash
npm exec -- prettier --no-editorconfig --write src/config tests/config.test.ts
npm exec -- prettier --no-editorconfig --check src/config tests/config.test.ts
```

- Давайте локальным переменным имена по смыслу. `currentJournalId` указывает на запись журнала, `replyPlatformMessageId` — на ID сообщения платформы. Сохраняйте имена полей существующих контрактов при передаче значений.
- Добавляйте единицы к числовым величинам, например `preparationTimeoutMs`, `replyTextCodePoints` и `inputBudgetTokens`.
- После асинхронного чтения сразу проверяйте актуальность работы, если результат зависит от поколения подключения, дедлайна или отмены. Затем проверяйте сам результат и переходите к следующему действию.
- В комментариях фиксируйте причины и ограничения, которые трудно восстановить из кода. Например, резерв окружения сохраняется даже при коротком окружении, чтобы рост метаданных не вытеснил уже выбранную историю.
- Относительные импорты локальных модулей TypeScript записывайте без расширения, например `import type { Storage } from '../storage/index';`. В исполняемых напрямую файлах MJS и путях к собранным файлам сохраняйте расширения, которые ожидает Node.js.

До правки сборщика контекста чтение цитаты и проверка отмены стояли в одной строке. В вызове рядом передавались идентификаторы из разных источников.

```ts
const source = await options.messages.reply(w.scope, current.replyToMessageId, current.id, c.replyTextCodePoints);if (!valid()) return { kind: 'cancelled' };
```

Имена аргументов и отдельная проверка показывают, что цитату ищут по платформенному ID, ограничивают текущей записью журнала и используют только при актуальной работе.

```ts
const replyPlatformMessageId = current.replyToMessageId;
const currentJournalId = current.id;
const quotedMessage = await options.messages.reply(
  work.scope,
  replyPlatformMessageId,
  currentJournalId,
  config.replyTextCodePoints,
);
if (!isWorkCurrent()) return { kind: 'cancelled' };
```
