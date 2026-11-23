import type {
  AuthorizationAction,
  AuthorizationContext,
  AuthorizationDecision,
  BotRole,
  GrantBasis,
  UserId,
} from '../../contracts/index';
import { platformOf, validId } from './validation';

const minimum: Record<AuthorizationAction, BotRole> = {
  'chat.configure': 'admin',
  'chat.history.clear': 'admin',
  'chat.passport.edit': 'admin',
  'chat.persona.select': 'admin',
  'chat.onboarding.configure': 'admin',
  'chat.pause': 'member',
  'chat.pause.extend': 'admin',
  'admin.grant': 'admin',
  'admin.remove': 'admin',
  'admin.revoke': 'owner',
  'admin.restore': 'owner',
  'admin.recover': 'owner',
  'admin.audit.read': 'owner',
  'diagnostics.read': 'admin',
  'usage.read': 'owner',
  'consent.edit': 'owner',
  'profile.admin.add': 'admin',
  'profile.self.manage': 'member',
  'persona.self.select': 'member',
  'onboarding.self.manage': 'member',
};
const ownActions = new Set<AuthorizationAction>([
  'profile.self.manage',
  'persona.self.select',
  'onboarding.self.manage',
]);
const ownerScope = new Set<AuthorizationAction>([
  'admin.revoke',
  'admin.restore',
  'admin.recover',
  'admin.audit.read',
  'usage.read',
]);
export function botRole(
  userId: UserId,
  ownerId: UserId,
  bases: readonly GrantBasis[],
  revoked: boolean,
): BotRole {
  return userId === ownerId ? 'owner' : revoked ? 'member' : bases.length ? 'admin' : 'member';
}
export interface PolicyInput {
  readonly context: AuthorizationContext;
  readonly ownerId: UserId;
  readonly bases: readonly GrantBasis[];
  readonly revoked: boolean;
  readonly enabled: boolean;
  readonly action: unknown;
  readonly subjectId?: UserId;
}
/** Чистая политика; происхождение контекста проверяется сервисом, не этим снимком. */
export function evaluatePolicy(input: PolicyInput): AuthorizationDecision {
  const { context, ownerId, action, subjectId } = input;
  if (
    !context ||
    !validId(context.chatId) ||
    !validId(context.userId) ||
    !validId(ownerId) ||
    context.platform !== platformOf(context.chatId) ||
    !['chat', 'owner'].includes(context.kind) ||
    (context.kind === 'chat' && platformOf(context.userId) !== context.platform) ||
    (subjectId !== undefined && (!validId(subjectId) || platformOf(subjectId) !== context.platform))
  ) {
    return { allowed: false, code: 'wrong_scope' };
  }
  if (typeof action !== 'string' || !Object.hasOwn(minimum, action))
    return { allowed: false, code: 'unknown_action' };
  const selected = action as AuthorizationAction;
  const role = botRole(context.userId, ownerId, input.bases, input.revoked);
  if (context.kind === 'owner' && role !== 'owner') return { allowed: false, code: 'forbidden' };
  if (!input.enabled && role !== 'owner') return { allowed: false, code: 'disabled' };
  if (ownerScope.has(selected) && context.kind !== 'owner')
    return { allowed: false, code: 'wrong_scope' };
  if (ownActions.has(selected) && subjectId !== context.userId)
    return { allowed: false, code: 'wrong_scope' };
  const rank = { member: 0, admin: 1, owner: 2 };
  return rank[role] >= rank[minimum[selected]]
    ? { allowed: true }
    : { allowed: false, code: 'forbidden' };
}
