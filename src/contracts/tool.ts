import type { ChannelAdapter } from './adapter.js';
import type { CapabilityName } from './capabilities.js';
import type { KnownBoolean } from './events.js';
import type { ChatId, PlatformId, UserId } from './identifiers.js';
import type { ObjectParameterSchema } from './json.js';

/** Факты текущего запроса от харнеса, отдельно от параметров модели. */
export interface ToolContext {
  readonly chatId: ChatId;
  readonly platform: PlatformId;
  readonly userId: UserId;
  readonly isAdmin: KnownBoolean;
  readonly adapter: ChannelAdapter;
}

export type ToolAccess = 'read' | 'write';
/** Отсутствие объявления означает all; пустой список — ни одной платформы. */
export type PlatformAvailability = 'all' | readonly PlatformId[];

export interface ToolDefinition<Parameters, Result> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ObjectParameterSchema;
  readonly access: ToolAccess;
  readonly platforms?: PlatformAvailability;
  readonly requiredCapabilities?: readonly CapabilityName[];
  readonly execute: (parameters: Parameters, context: ToolContext) => Promise<Result>;
}
