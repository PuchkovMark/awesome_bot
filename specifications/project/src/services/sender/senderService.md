# SenderService

**Тип:** сервис внешней доставки. **Источник:** [senderService.ts](../../../../../src/services/sender/senderService.ts), `SenderService` и singleton. Создаёт VK-клиент с `VK_TOKEN`; `canSendPrivateMessage` проверяет разрешение VK для пары group/user и валидирует положительные ID.

`send(peerId, text, options)` форматирует текст: в беседе (peer ID выше 2 млрд) обрезает до 4000 символов с уведомлением, в личном диалоге разбивает на части. Вложение, клавиатура и reply добавляются к первой части; каждому сообщению назначается `random_id`. Ошибка VK логируется и пробрасывается. `nextRandomId` выдаёт монотонные значения в диапазоне счётчика.

Сервис строит inline-клавиатуры, их payload обрабатывает `VKService`:

| Builder | Payload `command` | Для чего используется |
| --- | --- | --- |
| `createMenuPaginationKeyboard` | `menu_page` | Переход между страницами `/help` и `/admin`. |
| `sendPersonalityMenu` | `personality_select` | Выбор одного из первых 20 показанных профилей. |
| `createSummaryKeyboard` | `summary` | Перестроение `/summary` за 2 или 6 часов. |
| `createFunFeedbackKeyboard` | `fun_feedback`, `fun_again` | Оценка либо повторная генерация результата юмора/мема. |
| `createMemeDayVotingKeyboard` | `meme_vote` | Голос за опубликованный мем дня. |

Payload и серверные проверки описаны в [каталоге команд](../command/commands.md#интерактивные-callback-действия). `sendPhoto` преобразует изображение в JPEG и при сетевых/ответных ошибках повторяет загрузку уменьшенного варианта; затем сохраняет фото через VK и отправляет caption с attachment. `uploadVoice` повторяет временные ошибки, а после двух неудач использует альтернативную загрузку через Axios; `sendVoice` требует непустой текст. Парсеры ответов загрузки возвращают `null` при некорректной структуре.

ID исходящих сообщений хранятся только в памяти (до 1000 на peer) для `isBotMessage`, используемого защитой от повторной обработки ответов бота. Сервис не авторизует команды и не сохраняет содержимое; отправка передаёт данные VK. Зависит от VK SDK, Axios, Sharp и [SplitterService](../splitter/splitterService.md). Тесты доставки покрыты частично в `test/messageDelivery.test.ts` и `test/vkMessageDeliveryIntegration.test.ts`; фотозагрузка и все callback-клавиатуры не подтверждены этими названиями.
