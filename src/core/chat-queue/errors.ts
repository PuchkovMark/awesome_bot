export type QueueErrorCode =
  'invalid_input' | 'owned' | 'lost_ownership' | 'storage_failed' | 'stopped';
export class QueueError extends Error {
  readonly code: QueueErrorCode;
  constructor(code: QueueErrorCode) {
    super(`Queue: ${code}`);
    this.name = 'QueueError';
    this.code = code;
  }
}
