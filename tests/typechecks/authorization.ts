import type {
  AuthorizationAction,
  AuthorizationContext,
  BotRole,
  GrantBasis,
} from '../../src/contracts/index';
const role: BotRole = 'owner';
const basis: GrantBasis = 'creator';
const action: AuthorizationAction = 'admin.revoke';
// @ts-expect-error Платформенная роль не является ролью бота.
const invalidRole: BotRole = 'platformAdmin';
// @ts-expect-error Контекст нельзя построить из параметров модели.
const forged: AuthorizationContext = {
  chatId: 'vk:1',
  userId: 'vk:2',
  platform: 'vk',
  kind: 'chat',
};
void [role, basis, action, invalidRole, forged];
