import type { LlmErrorCode, LlmFailure } from './types';

const messages: Readonly<Record<LlmErrorCode, string>> = Object.freeze({
  invalid_request: 'Некорректный запрос к модели.',
  authentication: 'Провайдер отклонил авторизацию.',
  forbidden: 'Провайдер запретил доступ.',
  rate_limit: 'Достигнут лимит провайдера.',
  server: 'Временная ошибка провайдера.',
  network: 'Ошибка соединения с провайдером.',
  timeout: 'Истекло время обращения к модели.',
  cancelled: 'Обращение к модели отменено.',
  invalid_response: 'Некорректный ответ модели.',
  unsupported_response: 'Неподдерживаемый ответ модели.',
  response_too_large: 'Ответ модели превышает допустимый размер.',
  http: 'Провайдер вернул неожиданный HTTP-статус.',
});
/** Исходная ошибка и её диагностические поля сюда никогда не передаются. */
export function llmFailure(code: LlmErrorCode): LlmFailure {
  return Object.freeze({ kind: 'error', code, message: messages[code] });
}
