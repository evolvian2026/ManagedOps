import type { ProblemDetails } from '@managedops/shared';

/**
 * The one place the client talks to the API.
 *
 * Two rules it never breaks:
 *  1. The access token lives in memory only — never localStorage, where any
 *     injected script could read it. A page reload recovers the session from
 *     the httpOnly refresh cookie instead.
 *  2. A real error is never replaced with a generic one. Whatever the server
 *     said in `detail` is what the user sees, and the original is logged.
 */

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly status: number,
  ) {
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }

  /** Field errors keyed by form path, ready for react-hook-form's setError. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(
      (this.problem.errors ?? []).map((error) => [error.path, error.message]),
    );
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** Raised when the request never reached the server at all. */
export class NetworkError extends Error {
  constructor(override readonly cause: unknown) {
    super('We could not reach ManagedOps. Check your connection and try again.');
    this.name = 'NetworkError';
  }
}

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onSessionExpired(handler: () => void): void {
  onSessionLost = handler;
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Set on the refresh call itself, so a failure there does not loop. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

async function rawRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  // Double-submit CSRF: the server compares this against its own cookie.
  const csrf = readCookie('managedops_csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;

  try {
    return await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError(cause);
  }
}

async function toProblem(response: Response): Promise<ProblemDetails> {
  try {
    const body = (await response.json()) as Partial<ProblemDetails>;
    if (typeof body.detail === 'string') return body as ProblemDetails;
    return {
      type: 'about:blank',
      title: response.statusText || 'Request failed',
      status: response.status,
      detail: response.statusText || `The server returned ${response.status}.`,
    };
  } catch {
    // A non-JSON body means something upstream of the API answered — a proxy,
    // a gateway. Say so plainly rather than inventing a cause.
    return {
      type: 'about:blank',
      title: 'Unexpected response',
      status: response.status,
      detail: `The server returned ${response.status} without an explanation.`,
    };
  }
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: unknown;
}

/**
 * Rotating the refresh token is single-flight.
 *
 * Every caller that needs a session — the initial resume on page load, and any
 * request that hits a 401 — shares one in-flight rotation. Concurrency here is
 * not hypothetical: a dashboard firing six queries at once, or React's
 * double-invoked effects in development, would otherwise present the same
 * refresh token several times over. The server treats a token presented after
 * it was rotated as a leak and revokes the whole family, so the client must
 * never race itself into looking like an attacker.
 *
 * This call deliberately does not retry on 401 — it *is* the retry, and
 * recursing would both loop and rotate twice.
 */
let refreshInFlight: Promise<Session | null> | null = null;

export function resumeSession(): Promise<Session | null> {
  refreshInFlight ??= (async () => {
    try {
      const response = await rawRequest('/auth/refresh', { method: 'POST', skipRefresh: true });
      if (!response.ok) return null;
      const session = (await response.json()) as Session;
      accessToken = session.accessToken;
      return session;
    } catch {
      // A network failure here is indistinguishable from "no valid cookie" for
      // the caller's purposes: either way there is no session to resume.
      return null;
    } finally {
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();
  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawRequest(path, options);

  if (response.status === 401 && !options.skipRefresh) {
    if (await resumeSession()) {
      response = await rawRequest(path, options);
    } else {
      accessToken = null;
      onSessionLost?.();
    }
  }

  if (!response.ok) throw new ApiError(await toProblem(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * A binary response — a CSV export — through the same auth and refresh path.
 *
 * `request` parses JSON, which a CSV is not, so this stops one step earlier. It
 * still retries once after a refresh, because an export is exactly the kind of
 * long-idle click that finds an expired access token.
 */
export async function requestBlob(path: string): Promise<Blob> {
  let response = await rawRequest(path, {});

  if (response.status === 401) {
    if (await resumeSession()) {
      response = await rawRequest(path, {});
    } else {
      accessToken = null;
      onSessionLost?.();
    }
  }

  if (!response.ok) throw new ApiError(await toProblem(response), response.status);
  return response.blob();
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  blob: (path: string) => requestBlob(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Turns any thrown value into the sentence a user should read. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail;
  if (error instanceof NetworkError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}
