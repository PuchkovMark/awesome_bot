export type StorageErrorCode = 'invalid_input' | 'unavailable' | 'schema_incompatible'
  | 'migration_failed' | 'operation_failed' | 'closed';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode) {
    super(`Storage: ${code}`);
    this.name = 'StorageError';
    this.code = code;
  }
}

export function safeError(error: unknown, fallback: StorageErrorCode): StorageError {
  return error instanceof StorageError ? error : new StorageError(fallback);
}
