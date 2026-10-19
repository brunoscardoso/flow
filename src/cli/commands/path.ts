/**
 * `planflow-ai path repair` — repair a stale `~/.local/bin/planflow-ai` shim.
 *
 * The Flow IDE runs this at start-up when the shim `init` once wrote names an
 * entry that no longer exists (an app update moved the bundle, a checkout was
 * deleted). It only ever rewrites a shim plan-flow wrote; it never creates one,
 * never touches a user's own file at that path, and leaves a correct shim
 * byte-for-byte (and mtime) alone. All decisions live in `repairPlanflowShim`
 * (path-rails.ts) — the same code `init`'s PATH rails run first.
 */

import * as log from '../utils/logger.js';
import { repairPlanflowShim } from './path-rails.js';

export const PATH_VERBS = ['repair'] as const;

export function runPath(verb: string, options: { json?: boolean }): void {
  if (verb !== 'repair') {
    log.error(`path refused: unknown verb '${verb}' — expected one of: ${PATH_VERBS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const result = repairPlanflowShim();
  if (options.json === true) {
    console.log(JSON.stringify({ action: 'repair', ...result }));
  } else if (result.notice !== null) {
    log.info(result.notice);
  }
  if (result.outcome === 'failed') process.exitCode = 1;
}
