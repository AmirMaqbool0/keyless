import { CSRF_COOKIE, CSRF_HEADER, type ApiErrorBody } from '@keyless/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

let csrfToken: string | undefined;
let refreshing: Promise<boolean> | undefined;

/** One refresh at a time, shared by every request that hit an expired access token. */
function refreshSession(): Promise<boolean> {
  refreshing ??= send('POST', '/api/auth/refresh')
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const isForm = body instanceof FormData;
  // FormData sets its own multipart Content-Type with the boundary.
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const token = readCookie(CSRF_COOKIE) ?? csrfToken;
  if (token) headers[CSRF_HEADER] = token;

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  csrfToken = res.headers.get(CSRF_HEADER) ?? csrfToken;
  return res;
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  return new ApiError(
    res.status,
    body?.error.code ?? 'HTTP_ERROR',
    body?.error.message ?? `Request failed (${res.status})`,
    body?.error.details,
  );
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Make sure a CSRF cookie exists before the first state-changing call.
  if (method !== 'GET' && !readCookie(CSRF_COOKIE) && !csrfToken) await send('GET', '/api/auth/me');

  let res = await send(method, path, body);
  if (res.status === 401 && !path.startsWith('/api/auth/refresh')) {
    const err = await toError(res.clone());
    if (err.code === 'TOKEN_EXPIRED' && (await refreshSession())) {
      res = await send(method, path, body);
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Field-level messages from a VALIDATION_ERROR response, keyed by field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') return {};
  const details = err.details as { fieldErrors?: Record<string, string[]> } | undefined;
  return Object.fromEntries(
    Object.entries(details?.fieldErrors ?? {}).map(([k, v]) => [k, v[0] ?? 'Invalid value']),
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
