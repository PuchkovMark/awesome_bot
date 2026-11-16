# FunService

**Тип:** генератор юмористических текстов и управление пользовательскими предпочтениями. **Символы:** `FunService.generate`, `getSettings`, `updateSettings`, `updateChatSettings`, `allowsPersonalJokes`, `latestOutput`, `saveFeedback`; singleton `funService`. **Источник:** [funService.ts](../../../../../src/services/fun/funService.ts).

## Настройки и область действия

Личные предпочтения хранятся в `FunPreference` по уникальной паре `(vkUserId, conversationId)` как JSON partial. Defaults: `intensity=50`, `sarcasm=25`, `absurdity=40`, `emojis=true`, `personalJokes=true`, `personalMemes=true`. JSON parser требует объект; числовые поля должны быть конечными числами и ограничиваются диапазоном 0–100; переключатели должны быть boolean. Повреждённые настройки приводят к ошибке, а не к автоматическому reset.

`getSettings` создаёт отсутствующую личную строку через upsert. `updateSettings` объединяет новые значения с сохранёнными личными значениями, перезаписывает JSON и возвращает объединение с defaults. `updateChatSettings` читает существующие `ChatSettings.funSettings`, объединяет partial и сохраняет его отдельно. `allowsPersonalJokes` читает только личное поле; он не учитывает чатовые предпочтения.

При генерации в группе приоритеты настроек: defaults → `ChatSettings.funSettings` → личные `FunPreference`; в ЛС — defaults → личные. Вызов `generate` сам не запрещает personal jokes/memes: разрешение должен проверить вызывающий маршрут. `personalMemes` используется `MemeService`/VK-публикацией, `personalJokes` — командами и автоматической реакцией.

## Контракт `generate`

Поддерживаемые `FunKind`: `joke`, `prediction`, `reaction`, `roast`, `rating`, `story`, `randomjoke`. Для каждого вида задаётся отдельная системная задача с ограничениями безопасности. Дополнительно в системный prompt входят:

- текущий персонаж и стиль из `CharacterService`;
- `CHAT_REPLY_INSTRUCTION` для групповой беседы;
- intensity/sarcasm/absurdity и настройка эмодзи;
- до восьми последних `FunOutput` этого вида в текущем peer, чьи первые 300 символов запрещено повторять;
- агрегированная по этим output обратная связь `FunFeedback` без группировки по авторам;
- до восьми последних общих chat messages, максимум 500 символов на сообщение, только для группы;
- пользовательский запрос, обрезанный до 2000 символов.

История и запрос трактуются prompt как недоверенные данные; в группах инструкции ограничивают использование только сообщений самой беседы и запрещают личные истории. Выполняется `provider.send` без tools. Ответ trim-ится и форматируется через `senderService.formatMessage`; пустая строка вызывает ошибку. Успешный текст записывается в `FunOutput` с видом и автором. `ApiUsage` записывается как `fun_<kind>`; ошибка статистики только журналируется. Затем удаляются результаты старше последних 30 для той же беседы и вида. Если cleanup после сохранения падает, генератор выбрасывает ошибку, хотя output уже записан.

## История и feedback

`latestOutput(conversationId, vkUserId)` возвращает самый новый output автора в беседе, независимо от вида. VK проверяет, что он создан после начала текущей команды, прежде чем прикрепить feedback keyboard.

`saveFeedback(outputId, conversationId, vkUserId, value)` принимает `laugh`, `neutral`, `fire`; сначала проверяет, что output существует в заданной беседе, затем upsert-ит оценку по `(outputId, vkUserId)`. Владение output не проверяется: любой пользователь той же беседы может оценить существующий результат. Callback `fun_again`, напротив, требует, чтобы ID был последним output именно нажавшего автора; после генерации отправляет новый текст/мем и клавиатуру.

## Вызовы и проверки

Команды и callback маршруты описаны в [каталоге команд](../command/commands.md): `randomjoke`, `joke`, `prediction`, `react`/raw `reaction`, `roast`, `rating`, `story`, `/meme` и `fun_again`. Автоматическая реакция в группе запускается отдельно в `VkService`: при включённом `funAutoReactions`, случайном пороге `funAutoProbability`, личном разрешении пользователя и прошедшем `funAutoIntervalSeconds` условное обновление `ChatSettings.funAutoReactionAt` резервирует запуск; задача добавляется в `RequestQueue`, использует первые 1000 символов сообщения и логирует сбой без пользовательского ответа.

Сервис не доставляет результат обычной команды и сам не проверяет роли/режим VK; эти действия принадлежат `VkService` и `CommandService`. Тестов `FunService` в `test/` нет; feedback callback, персональные настройки и автоматическая реакция не имеют прямых тестов.
