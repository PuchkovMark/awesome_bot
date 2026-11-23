import type { AuthorizationContext, ToolContext } from '../contracts/index';
import type { AuthorizationResult } from '../core/authorization/service';

/** Проверяет согласованность области. Происхождение и актуальные права проверяет операция сервиса. */
export function toolAuthorization(context: ToolContext): AuthorizationResult<AuthorizationContext> {
  const authorization = context.authorization;
  if (!authorization) return { allowed: false, code: 'invalid_context' };
  if (
    authorization.kind !== 'chat' ||
    authorization.chatId !== context.chatId ||
    authorization.userId !== context.userId ||
    authorization.platform !== context.platform ||
    context.adapter.platform !== context.platform
  )
    return { allowed: false, code: 'wrong_scope' };
  return { allowed: true, value: authorization };
}
