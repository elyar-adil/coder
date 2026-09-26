/**
 * fetch.ts — Resilient HTTP client with retry, timeout, and reconnection.
 *
 * Wraps the native `fetch` with:
 *  • Configurable retry count and backoff
 *  • Request timeout
 *  • Connection-refused detection for local LLM servers
 */

export interface FetchOptions extends RequestInit {
  /** Max retry attempts (default: 3) */
  retries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  retryDelay?: number;
  /** Request timeout in ms (default: 120_000) */
  timeout?: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retriable: boolean,
    /** Server-advertised wait (Retry-After) in ms, when the failing response carried one. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Retry-After can legitimately ask for minutes; retrying must stay responsive,
 * so the advertised wait is capped and a still-failing provider eventually
 * surfaces as an error instead of hanging the turn. */
const RETRY_AFTER_CAP_MS = 60_000;

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
  return null;
}

function isRetriable(status: number | null, error: unknown): boolean {
  if (status === null) return true; // network error
  if (status === 429) return true;  // rate limited
  if (status >= 500) return true;   // server error
  return false;
}

function getErrorMessage(status: number | null, cause: unknown): string {
  if (cause instanceof Error && 'code' in cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') {
      return 'Connection refused — is the configured LLM server running? (LLM_BASE_URL / OLLAMA_BASE_URL)';
    }
    if (code === 'ENOTFOUND') {
      return 'DNS lookup failed — check LLM_BASE_URL';
    }
    if (code === 'ECONNRESET') {
      return 'Connection reset by server';
    }
  }
  if (status !== null) return `HTTP ${status}`;
  return String(cause);
}

const MAX_ERROR_BODY_LENGTH = 512;

async function errorResponseBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    return text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}…` : text;
  } catch {
    return '';
  }
}

/**
 * Resilient fetch with retry, timeout, and backoff.
 */
export async function resilientFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const {
    retries = 3,
    retryDelay = 1000,
    timeout = 120_000,
    ...fetchOpts
  } = opts;

  let lastError: FetchError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // Merge user-provided signal with our timeout signal
    if (fetchOpts.signal) {
      fetchOpts.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const response = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const retriable = isRetriable(response.status, null);
        // A server that sends Retry-After knows its backoff better than our
        // exponential guess; honor it verbatim (capped) for the wait.
        const advertised = retriable ? parseRetryAfter(response) : null;
        if (retriable && attempt < retries) {
          await sleep(advertised ?? retryDelay * Math.pow(2, attempt));
          continue;
        }
        const body = await errorResponseBody(response);
        throw new FetchError(
          getErrorMessage(response.status, null) + (body ? `: ${body}` : ''),
          response.status,
          false,
          advertised ?? undefined,
        );
      }

      return response;
    } catch (err: unknown) {
      clearTimeout(timer);

      if (err instanceof FetchError) throw err;

      // Caller cancellation is intentional, not a transient network failure.
      // Never retry an aborted model request.
      if (fetchOpts.signal?.aborted) {
        throw new FetchError('Request aborted', null, false);
      }

      const retriable = isRetriable(null, err);
      lastError = new FetchError(
        getErrorMessage(null, err),
        null,
        retriable,
      );

      if (!retriable || attempt >= retries) {
        throw lastError;
      }

      const delay = retryDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError ?? new FetchError('Unknown fetch error', null, false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
