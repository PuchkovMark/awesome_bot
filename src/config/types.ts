export const configParameters = ['VK_TOKEN', 'OPENCODE_API_KEY', 'LLM_MODEL', 'LOG_LEVEL'] as const;
export type ConfigParameter = typeof configParameters[number];
export const logLevels = ['debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = typeof logLevels[number];

export interface AppConfig {
  readonly vk: { readonly token: string };
  readonly llm: { readonly provider: 'opencode'; readonly apiKey: string; readonly model: string };
  readonly log: { readonly level: LogLevel };
}

export type Redact = (text: string) => string;
export interface LoadedConfig {
  readonly config: AppConfig;
  readonly redact: Redact;
}
