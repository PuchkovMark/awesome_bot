import type { AgentLoopErrorCode, AgentLoopOutcome } from './types.js';

const messages: Readonly<Record<AgentLoopErrorCode, string>> = Object.freeze({
  invalid_input: 'Некорректный ввод агентного цикла.',
  client_failure: 'Ошибка границы клиента модели.',
  invalid_request: 'Клиент отклонил запрос к модели.',
  authentication: 'Провайдер отклонил авторизацию.',
  forbidden: 'Провайдер запретил доступ.',
  server: 'Временная ошибка провайдера.',
  network: 'Ошибка соединения с провайдером.',
  timeout: 'Истекло время отдельного обращения к модели.',
  invalid_response: 'Некорректный ответ модели.',
  unsupported_response: 'Неподдерживаемый ответ модели.',
  response_too_large: 'Ответ модели превышает допустимый размер.',
  http: 'Неожиданный HTTP-статус провайдера.',
});
export function agentError(code: AgentLoopErrorCode): AgentLoopOutcome {
  return Object.freeze({ kind: 'error', code, message: messages[code] });
}
export function isAgentErrorCode(value: unknown): value is AgentLoopErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}
