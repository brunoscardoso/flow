/**
 * CODE STORYLINE — finding the TypeScript compiler (discovery `code-storyline`).
 *
 * The storyline parses with the TypeScript compiler's syntax API
 * (`createSourceFile` only — never a type-checker program). The compiler is NOT
 * bundled into the CLI: it is ~9 MB and the app already ships one. So the order
 * is:
 *
 *   1. `FLOW_TYPESCRIPT_PATH` — an absolute path the app passes, pointing at the
 *      compiler it ships;
 *   2. the CLI's own `typescript` package, when one resolves next to it (a dev
 *      checkout, a terminal install that brought it along);
 *   3. nothing — the caller turns `null` into a `no-compiler` refusal.
 *
 * Never throws: a compiler that cannot be loaded is an answer, not a crash.
 */

import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

/** The compiler module. Type-only import: nothing is pulled in at runtime. */
export type TsModule = typeof import('typescript');

export interface LoadTypeScriptDeps {
  env?: NodeJS.ProcessEnv;
  requireFn?: (id: string) => unknown;
}

/** The environment variable naming the app's shipped compiler. */
export const TYPESCRIPT_PATH_ENV = 'FLOW_TYPESCRIPT_PATH';

/** A loaded value is usable only when it carries the syntax API we call. */
function asTsModule(value: unknown): TsModule | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<TsModule>;
  if (typeof candidate.createSourceFile !== 'function') return null;
  if (typeof candidate.ScriptTarget !== 'object') return null;
  return candidate as TsModule;
}

function tryRequire(requireFn: (id: string) => unknown, id: string): TsModule | null {
  try {
    return asTsModule(requireFn(id));
  } catch {
    // A missing or broken compiler at this rung is expected (the env path may
    // be stale, the package may not be installed): fall through to the next.
    return null;
  }
}

function defaultRequire(): ((id: string) => unknown) | null {
  try {
    return createRequire(import.meta.url);
  } catch {
    // Only reachable in an environment without a module URL; no compiler then.
    return null;
  }
}

/** Load the TypeScript compiler, or `null` when none can be found. */
export function loadTypeScript(deps: LoadTypeScriptDeps = {}): TsModule | null {
  const env = deps.env ?? process.env;
  const requireFn = deps.requireFn ?? defaultRequire();
  if (requireFn === null) return null;

  const configured = env[TYPESCRIPT_PATH_ENV];
  if (typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured.trim())) {
    const loaded = tryRequire(requireFn, configured.trim());
    if (loaded !== null) return loaded;
  }
  return tryRequire(requireFn, 'typescript');
}
