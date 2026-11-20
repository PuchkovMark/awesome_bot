/** Имена платформы и локальная часть проверяются входной границей, не этим типом. */
export type PlatformId = string;
export type ChatId = `${string}:${string}`;
export type UserId = `${string}:${string}`;
/** Идентификатор сообщения имеет смысл только вместе с ChatId. */
export type PlatformMessageId = string;
/** UTC unix milliseconds; корректность числа проверяет будущий адаптер. */
export type Timestamp = number;
