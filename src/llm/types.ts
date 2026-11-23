import type { ObjectParameterSchema } from '../contracts/json';

/** Только транспортные данные. Разрешения и execute остаются в харнесе. */
export interface LlmToolDescription {
  readonly name: string;
  readonly description: string;
  readonly parameters: ObjectParameterSchema;
}
export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  /** Непрозрачная строка: клиент не разбирает JSON аргументов. */
  readonly arguments: string;
}
export type LlmMessage =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; readonly text?: string; readonly toolCalls?: readonly LlmToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly text: string };
export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmToolDescription[];
  readonly maxOutputTokens: number;
  /** Вычислен доверенным компонентом; не часть текста модели. */
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}
export interface LlmUsage { readonly input: number | null; readonly output: number | null }
export type LlmResponse = (
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'incomplete'; readonly text: string }
  | { readonly kind: 'refused' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'tool_calls'; readonly calls: readonly LlmToolCall[]; readonly text: string | null }
) & { readonly usage: LlmUsage };
export type LlmErrorCode =
  | 'invalid_request' | 'authentication' | 'forbidden' | 'rate_limit' | 'server'
  | 'network' | 'timeout' | 'cancelled' | 'invalid_response' | 'unsupported_response'
  | 'response_too_large' | 'http';
export interface LlmFailure {
  readonly kind: 'error';
  readonly code: LlmErrorCode;
  readonly message: string;
}
export type LlmResult = LlmResponse | LlmFailure;
export interface LlmClient { complete(request: LlmRequest): Promise<LlmResult> }
/** Совместим с AppConfig.llm; создание не читает окружение. */
export interface LlmConfig {
  readonly provider: 'opencode';
  readonly apiKey: string;
  readonly model: string;
}
export type LlmFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface LlmClientOptions {
  readonly fetch?: LlmFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
