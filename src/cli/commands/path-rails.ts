/**
 * planflow-ai PATH Rails
 *
 * The beat prompts call `planflow-ai loop next` **by name**, so a checkout whose
 * binary does not resolve makes every beat improvise a fallback. `planflow-ai
 * init` owns the rails that make the name resolve, and they are the same shape
 * as the graphify install rails: detect with `which`, try the user's own tooling
 * in order, and degrade to printed instructions.
 *
 * Two rules are absolute, because breaking either is the exact failure that
 * motivated these rails (`EACCES: permission denied, mkdir
 * '/usr/local/lib/node_modules'`):
 *
 *   - NEVER `sudo`, and never write to a root-owned npm prefix. The EACCES is
 *     predictable from the prefix's ownership, so it is PREDICTED (the rung is
 *     skipped without attempting) rather than caught after the fact.
 *   - NEVER edit a shell profile. When the shim's directory is not on PATH the
 *     export line is PRINTED as a next step; writing it is the user's call.
 *
 * The fallback is a shim SCRIPT, never a shell alias: agents run commands in
 * non-interactive shells where aliases do not exist, so an alias would work for
 * the human and not for the agent that needs the binary.
 *
 * All subprocess and environment inputs are dependency-injected (`exec`,
 * `canWrite`, `homeDir`, `pathValue`, `packageRoot`, `platform`) so tests never
 * run a real `npm link`, never touch the real `~/.local/bin`, never depend on
 * the machine's actual PATH, and can assert the Windows branches from a POSIX
 * host (NFR3).
 *
 * B6 — the shim's FORM is per-platform. On Windows an extensionless `#!/bin/sh`
 * file resolves against `PATHEXT` to nothing, and `chmod` has no exec bit to
 * set. Those decisions live in `../utils/platform-shim.js`; this file only
 * applies them. The POSIX path is byte-identical to what it was before B6.
 */

import { execSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix as posixPath, win32 as win32Path } from 'node:path';
import { homedir } from 'node:os';
import * as log from '../utils/logger.js';
import { getPackageRoot } from '../utils/files.js';
import {
  buildShimScript,
  cliEntryPath,
  commandLookupTool,
  isPlanflowShim,
  pathAdvice,
  shimExecMode,
  shimFileName,
  shimTargetOf,
} from '../utils/platform-shim.js';

/** Timeout for fast detection commands (`which ...`, `npm prefix -g`). */
const WHICH_TIMEOUT_MS = 5_000;

/** Timeout for `npm link`, which may compile/copy. */
const LINK_TIMEOUT_MS = 120_000;

/** The binary name every beat prompt and skill invokes. */
const BINARY = 'planflow-ai';

/**
 * Directory the shim is written into, relative to the user's home. Kept on
 * Windows too: `%USERPROFILE%\.local\bin` is the same convention uv and pipx
 * use there, and inventing a second location would mean two places to clean up.
 */
const SHIM_DIR_SEGMENTS = ['.local', 'bin'] as const;

/**
 * Path fragments that mark a resolution as EPHEMERAL rather than installed.
 * `npx planflow-ai init` puts a temporary bin directory on PATH for the
 * duration of that one command — treating it as "already on PATH" would report
 * success and leave the very next shell with `command not found`.
 */
const EPHEMERAL_PATH_MARKERS = ['/_npx/', '/node_modules/.bin/'] as const;

export type PathOutcome =
  | 'already-resolves'
  | 'linked-via-npm'
  | 'shim-written'
  | 'unavailable';

export interface EnsurePathResult {
  outcome: PathOutcome;
  /** One-line notice for init to print. */
  notice: string;
  /**
   * The exact `export PATH=...` line the user must add to their own profile,
   * or null when nothing is needed. NEVER written by these rails.
   */
  pathLine: string | null;
  /** Absolute path of the shim, when one was written. */
  shimPath: string | null;
}

export interface PathRailsDeps {
  /** Run a shell command synchronously; must throw on non-zero exit or timeout. */
  exec: (command: string, timeoutMs: number, cwd?: string) => string;
  /** Whether the current user may write into a directory (never assumed — checked). */
  canWrite: (dir: string) => boolean;
  /** Absolute home directory the shim is written under. */
  homeDir: string;
  /** PATH value the shim directory is tested against. */
  pathValue: string;
  /** Absolute root of the checkout whose `dist/cli/index.js` the shim runs. */
  packageRoot: string;
  /** Platform whose shim form, lookup tool and PATH rules apply (NFR3). */
  platform: NodeJS.Platform | string;
  /** Whether a file exists — decides the CLI entry layout and a shim's staleness. */
  fileExists: (path: string) => boolean;
}

/**
 * Default exec: synchronous shell command with a hard timeout.
 * Throws on non-zero exit or timeout (callers treat throws as "unavailable").
 */
function defaultExec(command: string, timeoutMs: number, cwd?: string): string {
  return execSync(command, {
    timeout: timeoutMs,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
}

/**
 * Default writability check: refuse a root-owned directory outright, then ask
 * the filesystem. Ownership is checked FIRST and separately because a
 * root-owned npm prefix is the documented failure — predicting it is the whole
 * point of this rung, and `sudo` is never an option here.
 *
 * The uid gate is POSIX-only, and skipping it on Windows is not a nicety:
 * `fs.Stats.uid` is 0 for EVERY file there and `process.getuid` does not exist,
 * so the POSIX predicate would read "root-owned, not running as root" for every
 * directory on the machine and veto the `npm link` rung unconditionally.
 * Exported so the branch is assertable from a POSIX host (NFR3).
 */
export function canWriteDir(
  dir: string,
  platform: NodeJS.Platform | string = process.platform
): boolean {
  try {
    if (platform !== 'win32') {
      const stats = statSync(dir);
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (stats.uid === 0 && uid !== 0) return false;
    }
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    // Sanctioned fallback: an unreadable/absent directory is not writable as
    // far as these rails are concerned — route to the next rung.
    return false;
  }
}

/**
 * Defaults are resolved per CALL, not at module load: `homedir()` and `PATH`
 * are environment reads, and a subprocess E2E that points `HOME` at a throwaway
 * directory must be honoured by the rails it is testing.
 */
function defaultDeps(platform: NodeJS.Platform | string): PathRailsDeps {
  return {
    exec: defaultExec,
    canWrite: (dir: string) => canWriteDir(dir, platform),
    homeDir: homedir(),
    pathValue: process.env.PATH ?? '',
    packageRoot: getPackageRoot(),
    platform,
    fileExists: existsSync,
  };
}

/**
 * Resolve a binary on PATH via the platform's lookup tool (`which` on POSIX,
 * `where` on Windows), returning its absolute path or null. A failing lookup is
 * an expected state, not an error — sanctioned fail-soft.
 */
function resolveOnPath(
  exec: PathRailsDeps['exec'],
  binary: string,
  platform: NodeJS.Platform | string
): string | null {
  try {
    const output = exec(`${commandLookupTool(platform)} ${binary}`, WHICH_TIMEOUT_MS);
    const first = output.split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  } catch {
    // Sanctioned fallback: absent binary simply routes to the next rung.
    return null;
  }
}

/**
 * Whether a resolved path only exists for the lifetime of the current command
 * (npx's temporary bin, a project-local `node_modules/.bin`). Such a resolution
 * must NOT be reported as installed.
 */
export function isEphemeralResolution(
  resolvedPath: string,
  platform: NodeJS.Platform | string = process.platform
): boolean {
  // The markers are spelled with `/` because that is what they look like on
  // POSIX. `where.exe` prints backslashes, so the Windows branch compares
  // against a slash-normalized copy — POSIX is left exactly as it was, where a
  // literal backslash in a path is a filename character rather than a separator.
  const probe = platform === 'win32' ? resolvedPath.replace(/\\/g, '/') : resolvedPath;
  return EPHEMERAL_PATH_MARKERS.some((marker) => probe.includes(marker));
}

/**
 * The directory `npm link` must write into, or its nearest existing ancestor —
 * ownership of a directory that does not exist yet is decided by the parent
 * that would have to create it.
 */
export function globalModulesDir(prefix: string): string {
  const target = join(prefix, 'lib', 'node_modules');
  let dir = target;
  for (let i = 0; i < 20; i++) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return target;
}

/**
 * Whether a directory is already present on a PATH value.
 *
 * Entries are compared resolved, so `~/.local/bin/` and `~/.local/bin` agree.
 * The separator, the resolver and case-sensitivity are all platform decisions:
 * Windows splits on `;`, resolves with backslashes, and compares paths
 * case-insensitively, so `C:\Users\me\.local\bin` and `c:\users\me\.local\bin`
 * are the same directory there and two different ones on POSIX.
 */
export function pathContainsDir(
  pathValue: string,
  dir: string,
  platform: NodeJS.Platform | string = process.platform
): boolean {
  const windows = platform === 'win32';
  const pathApi = windows ? win32Path : posixPath;
  const normalize = (value: string): string => {
    const resolved = pathApi.resolve(value);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const wanted = normalize(dir);
  return pathValue
    .split(pathApi.delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => normalize(entry) === wanted);
}

/**
 * The shim's contents. It names the checkout it points at and who wrote it, so
 * a shim left behind by a deleted or moved checkout is diagnosable from `cat`
 * (or `type`) alone instead of failing with an opaque MODULE_NOT_FOUND.
 *
 * The entry the shim execs is resolved to the file that ACTUALLY exists under
 * `packageRoot`: the app bundle ships a single `planflow-ai.mjs` (no `dist/`
 * tree), a source checkout / npm install ships `dist/cli/index.js`. This is the
 * fix for #1944 — hard-coding the checkout layout made a shim written from the
 * bundle point at a nonexistent `dist/cli/index.js`. The filesystem check is
 * done HERE (this module already does fs); `platform-shim.ts` stays pure.
 *
 * The per-platform encoding lives in `platform-shim.ts`; this is the rails'
 * name for it, kept so callers and tests do not have to know which module owns
 * the decision.
 */
export function shimContent(
  packageRoot: string,
  platform: NodeJS.Platform | string = process.platform,
  fileExists: (path: string) => boolean = existsSync
): string {
  return buildShimScript(platform, packageRoot, fileExists);
}

/** Where the shim lives: `<home>/.local/bin/planflow-ai[.cmd]`. */
export function shimPathFor(homeDir: string, platform: NodeJS.Platform | string): string {
  return join(homeDir, ...SHIM_DIR_SEGMENTS, shimFileName(platform));
}

/**
 * What is at the shim's path, measured against the shim this CLI would write.
 *
 *  - `absent`     nothing there.
 *  - `foreign`    a file WITHOUT plan-flow's marker — the user's own. Never written.
 *  - `current`    byte-identical to what this CLI would write. Never rewritten.
 *  - `stale`      a plan-flow shim whose target no longer exists (an app update
 *                 moved the bundle, a checkout or a scratch build was deleted),
 *                 or one naming THIS CLI's entry in an older form. Rewritten.
 *  - `other-live` a plan-flow shim naming a DIFFERENT entry that still exists —
 *                 a developer's own checkout. It works, so it is left alone.
 */
export type ShimState = 'absent' | 'foreign' | 'current' | 'stale' | 'other-live';

export function classifyShim(
  existing: string | null,
  desired: string,
  fileExists: (path: string) => boolean
): { state: ShimState; target: string | null } {
  if (existing === null) return { state: 'absent', target: null };
  if (!isPlanflowShim(existing)) return { state: 'foreign', target: shimTargetOf(existing) };
  const target = shimTargetOf(existing);
  if (existing === desired) return { state: 'current', target };
  if (target === null || !fileExists(target)) return { state: 'stale', target };
  if (target === shimTargetOf(desired)) return { state: 'stale', target };
  return { state: 'other-live', target };
}

export type RepairOutcome = 'absent' | 'current' | 'rewritten' | 'foreign' | 'other-live' | 'failed';

export interface RepairShimResult {
  outcome: RepairOutcome;
  /** One line for whoever ran this, or null when there is nothing to say. */
  notice: string | null;
  shimPath: string;
  /** The entry the shim named before this ran (null when there was none). */
  previousTarget: string | null;
}

/** Read a file's text, or null when there is none (or it cannot be read). */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    // Sanctioned fallback: an absent or unreadable file is "nothing there".
    return null;
  }
}

/**
 * Repair a STALE plan-flow shim in place, and do nothing else: never create a
 * shim that is not there, never touch a file plan-flow did not write, never
 * replace a working shim that names another live checkout. A correct shim is
 * not rewritten (its mtime does not move).
 *
 * This is what the IDE runs at start-up (`planflow-ai path repair`): after an
 * app update the shim `init` once wrote can name an entry that no longer
 * exists, and `which planflow-ai` still finds the FILE — so the init ladder's
 * "already resolves" rung would never notice. Never throws.
 */
export function repairPlanflowShim(deps: Partial<PathRailsDeps> = {}): RepairShimResult {
  const platform = deps.platform ?? process.platform;
  const { homeDir, packageRoot, fileExists } = { ...defaultDeps(platform), ...deps };
  const shimPath = shimPathFor(homeDir, platform);
  const desired = shimContent(packageRoot, platform, fileExists);
  const { state, target } = classifyShim(readOrNull(shimPath), desired, fileExists);

  switch (state) {
    case 'absent':
      return { outcome: 'absent', notice: null, shimPath, previousTarget: null };
    case 'current':
      return { outcome: 'current', notice: null, shimPath, previousTarget: target };
    case 'foreign':
      return {
        outcome: 'foreign',
        notice: `CLI: ${shimPath} was not written by plan-flow — left untouched.`,
        shimPath,
        previousTarget: target,
      };
    case 'other-live':
      return { outcome: 'other-live', notice: null, shimPath, previousTarget: target };
    case 'stale':
      try {
        writeShim(homeDir, packageRoot, platform, fileExists);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          outcome: 'failed',
          notice: `CLI: could not rewrite the stale \`${BINARY}\` shim at ${shimPath}: ${message}`,
          shimPath,
          previousTarget: target,
        };
      }
      return {
        outcome: 'rewritten',
        notice: `CLI: rewrote the stale \`${BINARY}\` shim at ${shimPath} (it named ${target ?? 'nothing readable'}).`,
        shimPath,
        previousTarget: target,
      };
  }
}

/**
 * The provenance line every rails shim carries (both platforms — the em dash on
 * POSIX, the hyphen on Windows, but this fragment is common to both). It is how
 * self-heal tells a shim THESE RAILS wrote from a `planflow-ai` someone else put
 * on PATH, so the rewrite below never touches a foreign binary.
 */
const RAILS_SHIM_MARKER = "written by plan-flow's `planflow-ai init`";

/**
 * Whether a `planflow-ai` resolved on PATH is a shim THESE RAILS wrote whose
 * target CLI entry no longer exists — the exact #1944 breakage: a shim written
 * from the app bundle pointing at a `dist/cli/index.js` the bundle does not
 * contain. Such a shim must be treated as unresolved so the rewrite rung heals
 * it; a foreign `planflow-ai`, or a healthy shim, is left untouched.
 *
 * Detection is positive and conservative (allowed-pattern #22 / #15-cousin):
 * the file must carry the rails' provenance line AND the entry it execs must be
 * missing. Anything unreadable, not ours, or still valid reads as "not broken" —
 * we never rewrite what we did not write. `readFile`/`exists` are injected so
 * the branch is assertable without a real binary on PATH (NFR3).
 */
export function isBrokenRailsShim(
  resolvedPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf-8'),
  exists: (path: string) => boolean = existsSync
): boolean {
  let content: string;
  try {
    content = readFile(resolvedPath);
  } catch {
    // Sanctioned fallback: a shim we cannot read is not one we will rewrite.
    return false;
  }
  if (!content.includes(RAILS_SHIM_MARKER)) return false;
  // Both branches exec `node "<entry>" …` — the first quoted path is the entry.
  const match = content.match(/node "([^"]+)"/);
  if (match === null) return false;
  return !exists(match[1]);
}

/**
 * Write the shim into `<home>/.local/bin`, creating the directory.
 *
 * The file NAME carries a `.cmd` extension on Windows (`PATHEXT` resolves
 * nothing otherwise) and the chmod is SKIPPED there rather than called with a
 * mode that would silently do nothing — `shimExecMode` returning null is the
 * instruction to skip, not an absent value.
 *
 * REFUSES a file plan-flow did not write: the path is the user's
 * `~/.local/bin`, and a file there without the marker is theirs.
 *
 * Throws on filesystem failure or refusal — the caller degrades that to a notice.
 */
function writeShim(
  homeDir: string,
  packageRoot: string,
  platform: NodeJS.Platform | string,
  fileExists: (path: string) => boolean
): string {
  const shimPath = shimPathFor(homeDir, platform);
  const existing = readOrNull(shimPath);
  if (existing !== null && !isPlanflowShim(existing)) {
    throw new Error(`${shimPath} exists and was not written by plan-flow — left untouched`);
  }
  const content = shimContent(packageRoot, platform, fileExists);
  // A correct shim is left as it is — its mtime is evidence of when it was
  // last CHANGED, and a no-op rewrite would erase that.
  if (existing !== content) {
    mkdirSync(dirname(shimPath), { recursive: true });
    writeFileSync(shimPath, content, 'utf-8');
  }
  const mode = shimExecMode(platform);
  if (mode !== null) {
    chmodSync(shimPath, mode);
  }
  return shimPath;
}

/**
 * Try `npm link` from the checkout — but ONLY when npm's global prefix is a
 * directory this user can actually write. A root-owned prefix (the snap/apt
 * default) is skipped without attempting: the EACCES is predictable, and the
 * only "fix" for it would be sudo, which these rails never use.
 */
function tryGlobalLink(
  exec: PathRailsDeps['exec'],
  canWrite: PathRailsDeps['canWrite'],
  packageRoot: string,
  platform: NodeJS.Platform | string
): boolean {
  if (resolveOnPath(exec, 'npm', platform) === null) return false;

  let prefix: string;
  try {
    prefix = exec('npm prefix -g', WHICH_TIMEOUT_MS).trim();
  } catch {
    // Sanctioned fallback: no prefix, no link — route to the shim rung.
    return false;
  }
  if (prefix.length === 0) return false;

  const modulesDir = globalModulesDir(prefix);
  if (!canWrite(modulesDir)) {
    log.skip(
      `npm global prefix ${modulesDir} is not writable by this user — skipping npm link (never sudo).`
    );
    return false;
  }

  try {
    exec('npm link', LINK_TIMEOUT_MS, packageRoot);
    return true;
  } catch {
    // Sanctioned fallback: a failed link is handled by writing a shim, never
    // by throwing out of init.
    return false;
  }
}

/**
 * Ensure `planflow-ai` resolves by name, without sudo and without editing any
 * shell profile. Called by `planflow-ai init`.
 *
 * The ladder:
 *   1. `which`/`where planflow-ai` resolves (non-ephemerally) → nothing to do.
 *   2. `npm link` — only when npm's global prefix is user-writable.
 *   3. A shim at `~/.local/bin/planflow-ai[.cmd]` naming this checkout.
 *   4. If that directory is not on PATH, the PATH line is printed, never written.
 *
 * Every rung degrades to a notice; this never throws, so the install can never
 * fail because of it.
 */
export async function ensurePlanflowOnPath(
  deps: Partial<PathRailsDeps> = {}
): Promise<EnsurePathResult> {
  const platform = deps.platform ?? process.platform;
  const { exec, canWrite, homeDir, pathValue, packageRoot, fileExists } = {
    ...defaultDeps(platform),
    ...deps,
  };

  // Rung 0 — a shim plan-flow wrote earlier whose target is gone. `which`
  // still finds the FILE, so rung 1 alone would call it installed and leave
  // every invocation failing with MODULE_NOT_FOUND. A file plan-flow did not
  // write is never touched; its notice is carried into whatever rung answers.
  const repair = repairPlanflowShim({ homeDir, packageRoot, platform, fileExists });
  if (repair.outcome === 'rewritten') {
    return shimWrittenResult(repair.shimPath, pathValue, platform, repair.notice ?? '');
  }
  const prefix = repair.outcome === 'foreign' && repair.notice !== null ? `${repair.notice} ` : '';

  // Rung 1 — already resolves. An npx-temporary resolution does not count, and
  // neither does a rails-written shim whose target entry has gone missing
  // (#1944) — that one must fall through to the rewrite rung and self-heal,
  // never be reported as a working install.
  const resolved = resolveOnPath(exec, BINARY, platform);
  if (
    resolved !== null &&
    !isEphemeralResolution(resolved, platform) &&
    !isBrokenRailsShim(resolved)
  ) {
    return {
      outcome: 'already-resolves',
      notice: `${prefix}CLI: \`${BINARY}\` already resolves (${resolved}).`,
      pathLine: null,
      shimPath: null,
    };
  }

  // Rung 2 — the user's own npm, only into a prefix the user owns.
  if (tryGlobalLink(exec, canWrite, packageRoot, platform)) {
    const linked = resolveOnPath(exec, BINARY, platform);
    if (linked !== null && !isEphemeralResolution(linked, platform)) {
      return {
        outcome: 'linked-via-npm',
        notice: `CLI: \`${BINARY}\` linked via npm link (${linked}).`,
        pathLine: null,
        shimPath: null,
      };
    }
  }

  // Rung 3 — a shim script under the user's own home. `writeShim` refuses a
  // file plan-flow did not write, which lands in the fallback below.
  let shimPath: string;
  try {
    shimPath = writeShim(homeDir, packageRoot, platform, fileExists);
  } catch (error) {
    // Sanctioned fallback: no rung worked. Say so in one line and continue —
    // the install never fails because the binary could not be placed.
    const message = error instanceof Error ? error.message : String(error);
    const entry = cliEntryPath(platform, packageRoot, fileExists);
    log.warn(`Could not put \`${BINARY}\` on PATH: ${message}`);
    log.info(`  Run it directly with: node ${entry}`);
    return {
      outcome: 'unavailable',
      notice: `${prefix}CLI: \`${BINARY}\` is not on PATH — run \`node ${entry}\` until it is.`,
      pathLine: null,
      shimPath: null,
    };
  }

  return shimWrittenResult(shimPath, pathValue, platform, `CLI: wrote \`${BINARY}\` shim to ${shimPath}`);
}

/**
 * Rung 4 — print the PATH line when needed. NEVER write it to a profile.
 * `headline` is the sentence before it (no trailing period).
 */
function shimWrittenResult(
  shimPath: string,
  pathValue: string,
  platform: NodeJS.Platform | string,
  headline: string
): EnsurePathResult {
  const shimDir = dirname(shimPath);
  const trimmed = headline.replace(/\.$/, '');
  if (pathContainsDir(pathValue, shimDir, platform)) {
    return {
      outcome: 'shim-written',
      notice: `${trimmed}.`,
      pathLine: null,
      shimPath,
    };
  }

  const advice = pathAdvice(platform, shimDir);
  log.warn(advice.warning);
  log.info(`  ${advice.line}`);
  return {
    outcome: 'shim-written',
    notice: `${trimmed} — ${advice.noticeSuffix}`,
    pathLine: advice.line,
    shimPath,
  };
}
