/**
 * update-check.ts — Update notification and self-update via npm.
 *
 * On startup the CLI queries `https://registry.npmjs.org/<pkg>/latest`, compares
 * it against the running version, and (when newer) returns a notice that the
 * CLI prints to stderr after command output. Results are cached for a day in
 * the shared CODER_DATA_HOME cache dir so the registry is not hit on every run.
 *
 * In interactive sessions the CLI offers a y/N prompt; on confirmation it runs
 * `npm install -g <pkg>@latest` for you. The install prefers the China mirror
 * (registry.npmmirror.com) and falls back to the default registry when the
 * mirror is unreachable or the install fails. Development installs (`npm link`)
 * are never touched.
 *
 * Opt out of checks with MAW_NO_UPDATE_CHECK / CODER_NO_UPDATE_CHECK /
 * NO_UPDATE_NOTIFIER, or implicitly in CI and non-TTY sessions. Opt out of
 * self-updates with MAW_NO_SELF_UPDATE / CODER_NO_SELF_UPDATE.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { atomicReplaceFile } from './runtime/file-lock.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name?: string; version?: string };

const PKG_NAME = pkg.name ?? 'tokenmaw';
const REGISTRY_URL = 'https://registry.npmjs.org';
const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT_TIMEOUT_MS = 30_000;

export interface UpdateCheckResult {
  packageName: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface UpdateCheckOptions {
  /** Registry base URL (for tests). */
  registryUrl?: string;
  /** Skip the daily cache and always fetch (for tests). */
  force?: boolean;
  /** Cache file location override (for tests). */
  cacheFile?: string;
  /** Fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

interface UpdateCheckCache {
  checkedAt: number;
  latest: string;
}

function cacheFilePath(): string {
  const base = process.env.CODER_DATA_HOME?.trim() || resolve(homedir(), '.coder');
  return resolve(base, 'cache', 'update-check.json');
}

function updateCheckDisabled(): boolean {
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  return ['MAW_NO_UPDATE_CHECK', 'CODER_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER']
    .some((name) => {
      const value = process.env[name];
      return value !== undefined && value !== '0' && value.toLowerCase() !== 'false';
    });
}

export function parseSemver(version: string): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Semver ordering: negative when a < b, positive when a > b, 0 when equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (pa[part] !== pb[part]) return pa[part] > pb[part] ? 1 : -1;
  }
  const [preA, preB] = [pa.prerelease, pb.prerelease];
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1;
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function formatUpdateNotice(result: UpdateCheckResult): string {
  return [
    `Update available ${result.current} → ${result.latest}`,
    `Run \`npm install -g ${result.packageName}@latest\` to update.`,
    'Disable with MAW_NO_UPDATE_CHECK=1.',
  ].join('\n');
}

export interface SelfUpdateOptions {
  /** Registry base URL for availability probes (tests). */
  registryUrl?: string;
  /** China mirror tried first; set to null to install from the default registry. */
  mirrorUrl?: string | null;
  /** Package name to install (tests). */
  packageName?: string;
  /** Target version (tests); defaults to `latest`. */
  version?: string;
  /** npm executable to invoke (tests); defaults to `npm`. */
  npmCommand?: string;
  /** Spawn implementation (tests). */
  spawnImpl?: typeof spawn;
  /** Probe implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Per-attempt install timeout (tests). */
  timeoutMs?: number;
  /** Override the development-install detection (tests). */
  devInstall?: boolean;
}

export interface SelfUpdateResult {
  ok: boolean;
  from: string;
  to: string;
  /** Registry the successful install actually came from (empty on failure). */
  registry: string;
  /** What went wrong, in the order attempts were made. */
  errors: string[];
}

/**
 * True when the running CLI is a development install (`npm link` or a direct
 * checkout). Overwriting those with a global install would silently orphan
 * local code, so self-update refuses and the notice stays manual.
 */
export function isDevelopmentInstall(): boolean {
  if (process.env.MAW_DEV_INSTALL === '1' || process.env.CODER_DEV_INSTALL === '1') return true;
  try {
    return !require.resolve('../package.json').split(sep).includes('node_modules');
  } catch {
    return false;
  }
}

function selfUpdateDisabled(): boolean {
  return ['MAW_NO_SELF_UPDATE', 'CODER_NO_SELF_UPDATE'].some((name) => {
    const value = process.env[name];
    return value !== undefined && value !== '0' && value.toLowerCase() !== 'false';
  });
}

interface SpawnOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnNpm(command: string, args: string[], timeoutMs: number, spawnImpl: typeof spawn): Promise<SpawnOutput> {
  return new Promise((resolveSpawn) => {
    // shell on win32 lets Node resolve npm.cmd; on POSIX the args are fixed
    // constants so no shell interpretation is possible.
    const child = spawnImpl(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finishSpawn = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSpawn({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finishSpawn(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', () => finishSpawn(null));
    child.on('close', (code) => finishSpawn(code));
  });
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

/**
 * Probes a registry before installing from it so a blocked mirror degrades to
 * the default registry quickly instead of letting npm hang on timeouts.
 */
async function registryReachable(packageName: string, registry: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${registry}/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Installs the latest release globally via npm, preferring the China mirror
 * (registry.npmmirror.com). Falls back to the default registry when the mirror
 * is unreachable or its install fails. Never throws: failures are reported in
 * the result so callers can keep the session running.
 */
export async function selfUpdate(options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  const current = pkg.version ?? '0.0.0';
  const target = options.version ?? 'latest';
  const packageName = options.packageName ?? PKG_NAME;
  const npmCommand = options.npmCommand ?? 'npm';
  const spawnImpl = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const errors: string[] = [];
  const fail = (message: string): SelfUpdateResult => ({
    ok: false, from: current, to: target, registry: '', errors: [...errors, message],
  });

  const devInstall = options.devInstall ?? isDevelopmentInstall();
  if (devInstall) {
    return fail('dev install detected (npm link); self-update skipped to avoid overwriting local code');
  }
  if (selfUpdateDisabled()) return fail('self-update disabled via MAW_NO_SELF_UPDATE');

  const defaultRegistry = (options.registryUrl ?? REGISTRY_URL).replace(/\/$/, '');
  const mirror = options.mirrorUrl === undefined ? NPM_MIRROR_REGISTRY : options.mirrorUrl;
  const candidates = [mirror, defaultRegistry]
    .filter((registry): registry is string => Boolean(registry))
    .filter((registry, index, all) => all.indexOf(registry) === index);

  for (const registry of candidates) {
    if (!(await registryReachable(packageName, registry, fetchImpl))) {
      errors.push(`${registry}: unreachable`);
      continue;
    }
    const install = await spawnNpm(
      npmCommand,
      ['install', '-g', '--no-fund', '--no-audit', '--registry', registry, `${packageName}@${target}`],
      timeoutMs,
      spawnImpl,
    );
    if (install.code === 0) {
      return { ok: true, from: current, to: target, registry, errors };
    }
    errors.push(`${registry}: npm exit ${install.code ?? 'killed'}${install.stderr.trim() ? ` — ${lastLine(install.stderr)}` : ''}`);
  }
  return { ok: false, from: current, to: target, registry: '', errors };
}

/**
 * Asks `Update now? [y/N]` on the real stdin/stdout after the TUI has shut
 * down. Defaults to no; only y/yes (any case) accepts. A 30s timeout or EOF
 * also declines, and stdin that is already gone skips the prompt entirely.
 */
export async function promptForUpdate(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  allowSelfUpdateOverride?: boolean,
): Promise<boolean> {
  if (selfUpdateDisabled()) return false;
  if (!(allowSelfUpdateOverride ?? !isDevelopmentInstall())) return false;
  if (!input.readable) return false;
  // A TTY gets terminal mode so typed input is echoed; pipes (tests, CI) fall
  // back to plain line reading.
  const terminal = Boolean((input as { isTTY?: boolean }).isTTY);
  const rl = createInterface({ input, output, terminal });
  const answer = await new Promise<string>((resolvePrompt) => {
    const timeout = setTimeout(() => {
      output.write('\n');
      rl.close();
      resolvePrompt('');
    }, PROMPT_TIMEOUT_MS);
    rl.question('Update now? [y/N] ', (text) => {
      clearTimeout(timeout);
      resolvePrompt(text);
    });
    rl.on('close', () => {
      clearTimeout(timeout);
      resolvePrompt('');
    });
  });
  rl.close();
  return /^\s*(y|yes)\s*$/i.test(answer);
}

/**
 * End-to-end interactive flow: ask, and on confirmation self-update. Returns
 * a printable message, or null when nothing happened. Failures leave the
 * current install untouched and working.
 */
export async function offerSelfUpdate(
  result: UpdateCheckResult,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  options: SelfUpdateOptions = {},
): Promise<string | null> {
  if (!result.updateAvailable) return null;
  if (selfUpdateDisabled() || (options.devInstall ?? isDevelopmentInstall())) return null;
  const accepted = await promptForUpdate(input, output,
    options.devInstall === undefined ? undefined : !options.devInstall);
  if (!accepted) return null;
  output.write(`Updating ${result.packageName} to ${result.latest} via npm (China mirror first)...\n`);
  const outcome = await selfUpdate({ ...options, version: options.version ?? result.latest });
  if (outcome.ok) {
    return [
      `Updated ${result.packageName} ${result.current} → ${result.latest} (from ${outcome.registry}).`,
      'Restart with `maw` to use the new version.',
    ].join('\n');
  }
  return [
    `Update to ${result.latest} failed:`,
    ...outcome.errors.map((error) => `  - ${error}`),
    `Run \`npm install -g ${result.packageName}@latest\` manually.`,
  ].join('\n');
}

async function fetchLatestVersion(registryUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  const url = `${registryUrl}/${encodeURIComponent(PKG_NAME)}/latest`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const manifest = (await response.json()) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : null;
}

/**
 * Checks npm for a newer release at most once per day (cached in
 * CODER_DATA_HOME). Returns null when disabled, offline, up to date, or on
 * any error — update checks must never break the CLI.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult | null> {
  const current = pkg.version ?? '0.0.0';
  if (updateCheckDisabled()) return null;
  const path = options.cacheFile ?? cacheFilePath();
  const registryUrl = (options.registryUrl ?? REGISTRY_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  let cached: UpdateCheckCache | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as UpdateCheckCache;
    if (typeof parsed.checkedAt === 'number' && typeof parsed.latest === 'string') cached = parsed;
  } catch {
    cached = null;
  }

  let latest: string | null = null;
  if (!options.force && cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatestVersion(registryUrl, fetchImpl).catch(() => null);
    if (latest) {
      const entry: UpdateCheckCache = { checkedAt: Date.now(), latest };
      await mkdir(dirname(path), { recursive: true });
      await atomicReplaceFile(path, `${JSON.stringify(entry, null, 2)}\n`).catch(async () => {
        await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`).catch(() => undefined);
      });
    }
  }

  if (!latest) return null;
  return {
    packageName: PKG_NAME,
    current,
    latest,
    updateAvailable: compareSemver(latest, current) > 0,
  };
}
