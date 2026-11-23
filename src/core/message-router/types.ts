import type { IncomingMessage, AuthorizationAction, BotRole } from '../../contracts/index';
import type { ChatSettings } from '../../storage/types';
import type { RouteMetadata } from '../../storage/queue-types';
import type { InitiativeCause } from './autonomous-rules';
export interface ServiceCommand {
  readonly action: AuthorizationAction;
  readonly minimumRole: BotRole;
  readonly replayRequest?: boolean;
}
export interface RoutingInput {
  readonly considerInitiative?: boolean;
  readonly message: IncomingMessage;
  readonly settings: Pick<ChatSettings, 'enabled' | 'responseMode'>;
  readonly service?: {
    readonly command: ServiceCommand;
    readonly role: BotRole;
    readonly allowed: boolean;
  };
}
export type RoutingDecision =
  | {
      readonly kind: 'ordinary';
      readonly reason: RouteMetadata['kind'];
      readonly route: RouteMetadata;
    }
  | { readonly kind: 'service'; readonly reason: 'service' }
  | {
      readonly kind: 'silence';
      readonly initiative?: InitiativeCause;
      readonly reason:
        | 'disabled'
        | 'silent'
        | 'sender_bot'
        | 'sender_unknown'
        | 'invalid_input'
        | 'not_addressed'
        | 'forbidden'
        | 'reply_unknown'
        | 'reply_other'
        | 'mention_flood';
    };
export type PublicationDecision =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'notice'; readonly template?: import('../../storage/notice-types').NoticeKind }
  | { readonly kind: 'silence' };
