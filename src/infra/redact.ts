/**
 * Keeps secrets out of files the runtime writes (session snapshots, compaction
 * archives). Redaction happens at write time on the serialized JSON: the
 * in-memory conversation and what is sent to the model are left alone, since an
 * agent sometimes legitimately needs a value (for example to write a .env).
 *
 * Two sources of secrets:
 *  - exact values we know about: configured API keys and secret-looking
 *    environment variables;
 *  - a small set of formats that are unmistakable on sight (provider key
 *    prefixes, AWS access key ids, PEM private keys).
 */

export const REDACTED = '[REDACTED]';

/** An explicitly configured secret may be short; anything shorter is not worth matching. */
const MIN_KNOWN_LENGTH = 8;
/** Environment values are only trusted as secrets when they look like one, so words are not erased. */
const MIN_ENV_LENGTH = 16;
const SECRET_ENV_NAME = /(API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i;

const FORMAT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Letters and digits together: the shape of a generated key, not of a word or a hyphenated phrase. */
function looksGenerated(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && !/\s/.test(value);
}

export class SecretRedactor {
  readonly #secrets = new Set<string>();

  get size(): number {
    return this.#secrets.size;
  }

  /** Register explicitly known secrets (configured API keys). */
  add(...values: Array<string | undefined>): void {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length >= MIN_KNOWN_LENGTH && !/\s/.test(value.trim())) {
        this.#secrets.add(value.trim());
      }
    }
  }

  /** Register environment values whose names say "secret" and whose shape agrees. */
  addEnv(env: NodeJS.ProcessEnv = process.env): void {
    for (const [name, value] of Object.entries(env)) {
      if (value && SECRET_ENV_NAME.test(name) && value.length >= MIN_ENV_LENGTH && looksGenerated(value)) this.add(value);
    }
  }

  /** Redact serialized JSON text. Both the raw and the JSON-escaped form of each known secret are replaced. */
  redactJson(text: string): string {
    let out = text;
    // Longest first, so a key that contains another registered key is replaced whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      for (const form of new Set([secret, jsonEscaped(secret)])) out = out.split(form).join(REDACTED);
    }
    for (const pattern of FORMAT_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  }
}

/** Every API key present in a loaded config (top-level, providers, and legacy per-model keys). */
export function collectConfigSecrets(config: {
  apiKey?: string;
  providers?: Record<string, { apiKey?: string }>;
  models?: Record<string, { apiKey?: string }>;
}): string[] {
  const keys = [config.apiKey, ...Object.values(config.providers ?? {}).map((provider) => provider.apiKey), ...Object.values(config.models ?? {}).map((model) => model.apiKey)];
  return keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
}
