/**
 * Graphify Install Rails
 *
 * Graphify (Python package `graphifyy`, binary `graphify`) is a required
 * backbone dependency of plan-flow's blueprint system. `planflow-ai init`
 * owns the install rails: plan-flow never vendors graphify — these rails
 * invoke the user's own package managers (uv, then pipx) and degrade to
 * printed manual instructions when neither is available or an install fails.
 *
 * When graphify is not installed, blueprint derive runs native-only with a
 * one-line notice. That is driven by availability (`which graphify`), not by
 * any flowconfig key — these rails record nothing (#1808).
 *
 * All subprocess behavior is dependency-injected (`exec`, `prompt`,
 * `spawnDetached`) so tests never touch real package managers.
 */

import { execSync, spawn } from 'node:child_process';

import { backgroundWorkDisabled } from '../utils/background-work.js';

import * as log from '../utils/logger.js';
import { ensureGraphifyOutLocal } from '../blueprint/graphify-out-symlink.js';

/** Timeout for fast binary-detection commands (`which ...`). */
const WHICH_TIMEOUT_MS = 5_000;

/** Timeout for package-manager installs (`uv tool install`, `pipx install`). */
const INSTALL_TIMEOUT_MS = 120_000;

/** Manual install commands shown when automatic install is not possible. */
const MANUAL_INSTALL_COMMANDS = ['uv tool install graphifyy', 'pipx install graphifyy'] as const;

export type GraphifyOutcome =
  | 'already-installed'
  | 'installed-via-uv'
  | 'installed-via-pipx'
  | 'pending';

export interface EnsureGraphifyResult {
  outcome: GraphifyOutcome;
  /** One-line notice for init to print. */
  notice: string;
}

export interface GraphifyRailsDeps {
  /** Run a shell command synchronously; must throw on non-zero exit or timeout. */
  exec: (command: string, timeoutMs: number) => string;
  /** Fire-and-forget a detached background process (output ignored). */
  spawnDetached: (command: string, args: string[], cwd: string) => void;
}

/**
 * Default exec: synchronous shell command with a hard timeout.
 * Throws on non-zero exit or timeout (callers treat throws as "unavailable").
 */
function defaultExec(command: string, timeoutMs: number): string {
  return execSync(command, {
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
}

/**
 * Default detached spawn: mirrors init's existing fire-and-forget pattern
 * (heartbeat daemon start / blueprint first derive) — detached, output
 * ignored, unref'd so init never waits on it.
 */
function defaultSpawnDetached(command: string, args: string[], cwd: string): void {
  // A DETACHED GRAPH BUILD OUTLIVES THE TEST THAT STARTED IT (#1848). It writes
  // `graphify-out/` into the cwd, which under jest is a temp directory the suite
  // is deleting — the `ENOTEMPTY: … rmdir '…/graphify-out'` that made a
  // different init test fail on every full run. Guarded in the DEFAULT only, so
  // a caller that injected its own `spawnDetached` (which is what the rails
  // tests do) is unaffected.
  if (backgroundWorkDisabled()) return;
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
}

const DEFAULT_DEPS: GraphifyRailsDeps = {
  exec: defaultExec,
  spawnDetached: defaultSpawnDetached,
};

/**
 * Check whether a binary resolves on the user's PATH via `which`.
 * A failing `which` is an expected state, not an error — sanctioned fail-soft.
 */
function binaryExists(exec: GraphifyRailsDeps['exec'], binary: string): boolean {
  try {
    exec(`which ${binary}`, WHICH_TIMEOUT_MS);
    return true;
  } catch {
    // Sanctioned fallback: absent binary simply routes to the next rail.
    return false;
  }
}

/**
 * Run a package-manager install, timeout-bounded.
 * Failures degrade to the manual-instructions path — sanctioned fail-soft.
 */
function tryInstall(exec: GraphifyRailsDeps['exec'], command: string): boolean {
  try {
    exec(command, INSTALL_TIMEOUT_MS);
    return true;
  } catch {
    // Sanctioned fallback: a failed install is handled by recording `pending`
    // and printing manual instructions, never by throwing out of init.
    return false;
  }
}

/**
 * Fire-and-forget the first `graphify update .` graph build after a
 * successful install, consistent with init's async first-derive pattern.
 */
function fireFirstGraphBuild(spawnDetached: GraphifyRailsDeps['spawnDetached'], repoRoot: string): void {
  // Ensure graphify's cwd-convention `graphify-out/` is a real, gitignored local
  // directory BEFORE it writes — never a vault symlink, which Tailwind/Turbopack
  // follow out of the project and panic on (#142). Fail-soft.
  ensureGraphifyOutLocal(repoRoot);
  try {
    spawnDetached('graphify', ['update', '.'], repoRoot);
  } catch {
    // Sanctioned fallback: the first build is opportunistic — the next
    // blueprint derive will build/enrich when graphify is invoked again.
  }
}

/**
 * Print manual install instructions and return the pending result. This is the
 * sanctioned degraded path when no package manager is available or installs
 * fail.
 *
 * NOTHING IS RECORDED, because nothing would read it (#1808). This used to
 * write `engines.graphify: pending`, and the docs credited that value with
 * keeping derive native-only behind a persistent notice — but the key has five
 * writers and zero readers, and derive is native-only because `which graphify`
 * finds nothing, not because a key says so. The behaviour is real; only its
 * stated cause was.
 */
function recordPending(): EnsureGraphifyResult {
  log.warn('Graphify could not be installed automatically. Install it manually with one of:');
  for (const command of MANUAL_INSTALL_COMMANDS) {
    log.info(`  ${command}`);
  }
  return {
    outcome: 'pending',
    notice:
      'Graphify: pending — install with `uv tool install graphifyy` or `pipx install graphifyy`; blueprint derive runs native-only until then.',
  };
}

/**
 * Install flow: verify/repair the graphify binary via uv → pipx rails,
 * record the resulting engine state, and kick off the first graph build.
 */
function installGraphify(
  repoRoot: string,
  exec: GraphifyRailsDeps['exec'],
  spawnDetached: GraphifyRailsDeps['spawnDetached']
): EnsureGraphifyResult {
  // The binary may already exist without a flowconfig record (manual install).
  // Record it as enabled instead of re-installing — keeps the rails idempotent.
  if (binaryExists(exec, 'graphify')) {
    return {
      outcome: 'already-installed',
      notice: 'Graphify: binary found — nothing to install.',
    };
  }

  if (binaryExists(exec, 'uv')) {
    const installed = tryInstall(exec, 'uv tool install graphifyy');
    if (installed && binaryExists(exec, 'graphify')) {
      fireFirstGraphBuild(spawnDetached, repoRoot);
      return {
        outcome: 'installed-via-uv',
        notice: 'Graphify: installed via uv — first graph build started in background.',
      };
    }
    return recordPending();
  }

  if (binaryExists(exec, 'pipx')) {
    const installed = tryInstall(exec, 'pipx install graphifyy');
    if (installed && binaryExists(exec, 'graphify')) {
      fireFirstGraphBuild(spawnDetached, repoRoot);
      return {
        outcome: 'installed-via-pipx',
        notice: 'Graphify: installed via pipx — first graph build started in background.',
      };
    }
    return recordPending();
  }

  // Both package managers missing — degrade to manual instructions.
  return recordPending();
}

/**
 * Ensure the graphify binary is available, using the user's package managers
 * (uv → pipx) and degrading to manual instructions. Called by `planflow-ai
 * init`.
 *
 * Always-on (#142): graphify is a required backbone dependency — there is no
 * consent prompt and no decline, and the derive gate asks `which graphify`
 * rather than reading a key. Any legacy `engines.graphify` value in a user's
 * flowconfig is ignored.
 *
 * NOTHING IS WRITTEN TO FLOWCONFIG (#1808). These rails used to record
 * `enabled`/`pending`, which read as a setting and was not one: the key had
 * five writers and no readers, and the documented `declined` value — which
 * these rails never even wrote — would not have been honoured by anything. A
 * user who set it by hand got graphify anyway, silently. A key nobody reads is
 * an invitation to try to use it. The install state is reported in the returned
 * notice, where a person can act on it.
 *
 * All rails are timeout-bounded and fail-soft — this returns `pending` rather
 * than throwing when installation is not possible.
 */
export async function ensureGraphify(
  repoRoot: string,
  deps: Partial<GraphifyRailsDeps> = {}
): Promise<EnsureGraphifyResult> {
  const { exec, spawnDetached } = { ...DEFAULT_DEPS, ...deps };

  // Binary already resolves → nothing to do. Idempotent by construction now
  // that there is no record to reconcile: whatever a legacy flowconfig says,
  // the answer is what `which graphify` finds.
  if (binaryExists(exec, 'graphify')) {
    return {
      outcome: 'already-installed',
      notice: 'Graphify: already installed.',
    };
  }

  return installGraphify(repoRoot, exec, spawnDetached);
}
