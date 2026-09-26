import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Parsed by hand instead of createRequire(...)(...): tsx's require hook
// transpiles package.json into JS on some platforms (observed on Windows),
// which then fails JSON.parse inside Node's `.json` loader.
export const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
export const PACKAGE_JSON = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
  name?: string;
  version?: string;
};

export const CODER_VERSION = PACKAGE_JSON.version ?? '0.0.0';
