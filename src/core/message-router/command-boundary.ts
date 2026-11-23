import type { AuthorizationContext, IncomingMessage, ConnectionScope } from '../../contracts/index';
import type { createAuthorizationService } from '../authorization/service';
import type { ServiceCommand, RoutingInput } from './types';
export type RouterAuthorization = Pick<
  Awaited<ReturnType<typeof createAuthorizationService>>,
  'role' | 'check'
>;
export async function commandAccess(
  auth: RouterAuthorization | undefined,
  context: AuthorizationContext | undefined,
  scope: ConnectionScope,
  message: IncomingMessage,
  command: ServiceCommand,
): Promise<NonNullable<RoutingInput['service']>> {
  const denied = { command, role: 'member', allowed: false } as const;
  const participantCommand =
    command.minimumRole === 'member' &&
    ['chat.pause', 'profile.self.manage', 'profile.self.address', 'reminder.manage'].includes(
      command.action,
    );
  if (
    !auth ||
    !context ||
    context.scope !== scope ||
    context.userId !== message.userId ||
    context.chatId !== message.chatId ||
    (!participantCommand && !['admin', 'owner'].includes(command.minimumRole))
  )
    return denied;
  const role = await auth.role(context);
  if (!role.allowed) return denied;
  const decision = ['profile.self.manage', 'profile.self.address'].includes(command.action)
    ? await auth.check(context, command.action, message.userId)
    : await auth.check(context, command.action);
  return { command, role: role.value, allowed: decision.allowed };
}
