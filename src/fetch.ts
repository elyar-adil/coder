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
  ) {
    super(message);
    this.name = 'FetchError';
  }
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
        if (retriable && attempt < retries) {
          const delay = retryDelay * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw new FetchError(
          getErrorMessage(response.status, null),
          response.status,
          false,
        );
      }

      return response;
    } catch (err: unknown) {
      clearTimeout(timer);

      if (err instanceof FetchError) throw err;

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
