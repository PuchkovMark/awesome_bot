import type { IncomingMessage, AuthorizationAction, BotRole } from '../../contracts/index.js';
import type { ChatSettings } from '../../storage/types.js';
import type { RouteMetadata } from '../../storage/queue-types.js';
export interface ServiceCommand { readonly action: AuthorizationAction; readonly minimumRole: BotRole; readonly replayRequest?: boolean }
export interface RoutingInput {
 readonly message: IncomingMessage; readonly settings: Pick<ChatSettings,'enabled'|'responseMode'>;
 readonly service?: { readonly command: ServiceCommand; readonly role: BotRole; readonly allowed: boolean };
}
export type RoutingDecision =
 | { readonly kind:'ordinary'; readonly reason: RouteMetadata['kind']; readonly route:RouteMetadata }
 | { readonly kind:'service'; readonly reason:'service' }
 | { readonly kind:'silence'; readonly reason:'disabled'|'silent'|'sender_bot'|'sender_unknown'|'invalid_input'|'not_addressed'|'forbidden' };
export type PublicationDecision = {readonly kind:'answer';readonly text:string}|{readonly kind:'notice';readonly template?:import('../../storage/notice-types.js').NoticeKind}|{readonly kind:'silence'};
