import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicWriteOptions {
  /** File mode for the temporary file and the final file when supported. */
  mode?: number;
  /** Number of rename retries before using a non-destructive copy fallback. */
  retries?: number;
  /** Initial delay between rename retries. */
  retryDelayMs?: number;
}

const RETRYABLE_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM', 'ENOTEMPTY']);

/**
 * Replace a file without deleting the old target first.
 *
 * Windows can temporarily reject rename-over-existing-file while an editor,
 * antivirus scanner, or indexer has the target open. Retrying is safe; if the
 * filesystem still refuses the rename, copyFile is attempted as a fallback.
 * Neither path removes the old target, so a failed write cannot destroy the
 * last good snapshot.
 */
export async function atomicWriteFile(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const retries = Math.max(0, options.retries ?? 5);
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 5);
  let lastError: unknown;

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temp, content, {
      encoding: 'utf8',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await rename(temp, path);
        if (options.mode !== undefined) await chmod(path, options.mode).catch(() => undefined);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!RETRYABLE_RENAME_ERRORS.has(code ?? '')) throw error;
        if (attempt < retries) {
          await new Promise((resolveWait) => setTimeout(resolveWait, retryDelayMs * (attempt + 1)));
        }
      }
    }

    // Some Windows filesystems permit copy-overwrite even when rename is
    // blocked. This is intentionally non-destructive: if copy also fails,
    // the original target remains untouched.
    try {
      await copyFile(temp, path);
      if (options.mode !== undefined) await chmod(path, options.mode).catch(() => undefined);
      return;
    } catch (fallbackError) {
      throw lastError ?? fallbackError;
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
