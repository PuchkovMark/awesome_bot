import type { ContentVersion } from '../contracts/versioning';
import type { ConnectionScope } from '../contracts/lifecycle';
import type { StoredMessage, HistoryQuery } from './types';
/** Единственный reader, выдаваемый сборщику контекста и контекстному поиску. */
export interface ContextMessageReader {
  get(scope: ConnectionScope, id: number): Promise<ContextMessage | null>;
  page(scope: ConnectionScope, query: ContextPageQuery): Promise<readonly ContextRecord[]>;
  reply(
    scope: ConnectionScope,
    messageId: string,
    cutoffId: number,
    textLimit: number,
  ): Promise<ContextRecord | null>;
  list(scope: ConnectionScope, query: HistoryQuery): Promise<readonly StoredMessage[]>;
}
export interface ContextMessage extends StoredMessage {
  readonly authorNumber?: number;
}
export interface ContextRecord extends ContextMessage {
  readonly truncated: boolean;
}
export interface ContextPageQuery {
  readonly cutoffId: number;
  readonly beforeId?: number;
  readonly limit: number;
  readonly textLimit: number;
}
export interface ContextStateReader {
  settings(scope: ConnectionScope): Promise<{
    readonly enabled: boolean;
    readonly responseMode: 'silent' | 'normal' | 'active';
    readonly timezone: string;
  } | null>;
  systemPrompt(scope: ConnectionScope): Promise<ContentVersion | null>;
}
export type { StoredMessage } from './types';
