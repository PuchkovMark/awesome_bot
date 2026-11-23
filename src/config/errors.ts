import { configParameters } from './types.js';
import type { ConfigParameter } from './types.js';

export const configErrorCodes = [
  'missing',
  'invalid',
  'env_file_missing',
  'env_file_unreadable',
] as const;
export type ConfigErrorCode = (typeof configErrorCodes)[number];

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly parameters: readonly ConfigParameter[];

  constructor(code: ConfigErrorCode, parameters: readonly ConfigParameter[] = []) {
    const safeCode = configErrorCodes.includes(code) ? code : 'invalid';
    const safeParameters = configParameters.filter((parameter) => parameters.includes(parameter));
    super(
      `Configuration error: ${safeCode}${safeParameters.length ? ` (${safeParameters.join(', ')})` : ''}`,
    );
    this.name = 'ConfigError';
    this.code = safeCode;
    this.parameters = Object.freeze(safeParameters);
  }
}
