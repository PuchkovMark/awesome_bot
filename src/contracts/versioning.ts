import type { ChatId } from './identifiers';
export type ContentKind = 'system_prompt' | 'persona' | 'greeting_template';
export type LocalContentKind = Exclude<ContentKind, 'system_prompt'>;
export interface GlobalVersionRef {
  readonly area: 'global';
  readonly kind: ContentKind;
  readonly key: string;
  readonly version: number;
}
export interface LocalVersionRef {
  readonly area: 'local';
  readonly kind: LocalContentKind;
  readonly key: string;
  readonly version: number;
  readonly chatId: ChatId;
  readonly generation: number;
}
export type VersionRef = GlobalVersionRef | LocalVersionRef;
export interface ContentVersion {
  readonly ref: VersionRef;
  readonly text: string;
  readonly createdAt: number;
}
export interface VersionLimits {
  readonly textMaxLength: number;
  readonly maxPerEntity: number;
}
export interface VersionInput<K extends ContentKind = ContentKind> {
  readonly kind: K;
  readonly key: string;
  readonly text: string;
  readonly createdAt: number;
  readonly expectedHead: number | null;
}
export type AppendVersionResult =
  { readonly status: 'created'; readonly value: ContentVersion } | { readonly status: 'conflict' };
export type SelectionResult =
  | { readonly status: 'selected' }
  | { readonly status: 'conflict' }
  | { readonly status: 'not_found' };
