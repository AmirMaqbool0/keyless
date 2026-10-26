/** Error body returned by every API endpoint on failure. */
export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

export const CSRF_COOKIE = 'keyless_csrf';
export const CSRF_HEADER = 'x-csrf-token';
