import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The installed version, read from `package.json`.
 *
 * Two candidates because the path differs between running from source and
 * running from the bundle, and a hardcoded string here would drift from what is
 * actually installed the first time somebody publishes without noticing.
 */
export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const raw = readFileSync(join(here, candidate), 'utf8');
      return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
    } catch {
      continue;
    }
  }

  return '0.0.0';
}
