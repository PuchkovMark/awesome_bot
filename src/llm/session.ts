import { createHmac } from 'node:crypto';
import type { ConnectionScope } from '../contracts/lifecycle';

/** Вычисление не подтверждает актуальность области и не хранит соответствия. */
export function createLlmSessionId(secret: string): (scope: ConnectionScope) => string {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new TypeError('Некорректный секрет сессии LLM.');
  }
  return (scope) => {
    if (
      !scope ||
      typeof scope.chatId !== 'string' ||
      !/^[a-z][a-z0-9_-]*:[^\s]+$/.test(scope.chatId) ||
      !Number.isSafeInteger(scope.generation) ||
      scope.generation <= 0
    ) {
      throw new TypeError('Некорректная область сессии LLM.');
    }
    return createHmac('sha256', secret)
      .update(JSON.stringify(['awesome_bot:llm-session:v1', scope.chatId, scope.generation]))
      .digest('hex');
  };
}
