export type SafeImageErrorDetails = {
  name: string;
  message: string;
  status?: number;
  code?: string | number;
  param?: string;
};

/**
 * Оставляет в журнале только безопасные поля ошибки провайдера изображений.
 */
export function getSafeImageErrorDetails(error: unknown): SafeImageErrorDetails {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: String(error) };
  }
  const details: SafeImageErrorDetails = { name: error.name, message: error.message };
  if ('status' in error && typeof error.status === 'number') details.status = error.status;
  if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) {
    details.code = error.code;
  }
  if ('param' in error && typeof error.param === 'string') details.param = error.param;
  return details;
}
