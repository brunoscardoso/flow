/**
 * Is the RUNNING binary behind the source it lives beside? (#1651)
 *
 * The operative CLI is `dist/` in a checkout, reached through a shim — and
 * `dist/` only changes when a human rebuilds. Loops landed fixes to their own
 * machinery on main and kept beating through the old machinery for hours,
 * with nothing anywhere saying so (live: the installed binary still made the
 * pre-fix remote reads thirty minutes after the fix merged; earlier, it
 * refused `--plan` days after main gained the flag).
 *
 * THE SIGNAL IS ONE STDERR LINE on the two verbs every surface passes through
 * (`loop next`, `loop status`). stderr, because stdout is the JSON contract a
 * run parses (the same split `defaultGhLog` documents).
 *
 * SOURCE CHECKOUTS ONLY. An npm-installed package has no `.git` at its root
 * and its stamp carries no commit — both read as "not a dogfood checkout" and
 * stay silent. A pre-#1651 build has no stamp at all: silent too, because a
 * warning that fires forever until the next rebuild is noise, and the next
 * rebuild writes the stamp that makes the check real.
 *
 * CONTENT, NOT MTIME (forbidden-pattern #10): staleness is "commits exist in
 * origin/<base> that the stamped commit does not contain", asked of git —
 * never a file clock compared against a commit clock.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What `scripts/stamp-build.mjs` wrote beside the running code. */
export interface BuildStamp {
  /** Source commit the build was cut from; null when built with no git. */
  commit: string | null;
  /** Whether tracked files were modified at build time. */
  dirty: boolean;
  builtAt: string;
}

/** Minimal exec surface — argv in, stdout out, throw on failure. */
export type StalenessExec = (file: string, args: readonly string[], cwd: string) => string;

/**
 * Where the CHECKOUT stands against origin/main — null when git could not say.
 *
 * A SECOND FACT, because the first one cannot pick a remedy. `behind` is
 * measured from the STAMP, so it answers "is the running build old"; it says
 * nothing about whether a rebuild could fix that. `npm run build` compiles the
 * WORKING TREE and stamps the commit the working tree is on, so it clears the
 * notice only when the working tree already contains origin/main — that is
 * exactly `behind === 0` here (#1796).
 */
export interface CheckoutDistance {
  /** Commits on origin/main the working tree does not have. */
  behind: number;
  /** Commits the working tree has that origin/main does not. */
  ahead: number;
}

/** Read the build stamp beside `dist/`, or null (absent, unreadable, malformed). */
export function readBuildStamp(packageRoot: string): BuildStamp | null {
  try {
    const raw = JSON.parse(readFileSync(join(packageRoot, 'dist', 'build-info.json'), 'utf-8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const commit = typeof record.commit === 'string' && record.commit.length > 0 ? record.commit : null;
    return {
      commit,
      dirty: record.dirty === true,
      builtAt: typeof record.builtAt === 'string' ? record.builtAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * The warning line, or null when there is nothing honest to say.
 *
 * Pure — the policy lives here so it is pinned by tests; the I/O edge below
 * only gathers the two facts.
 */
export function cliStalenessWarning(
  stamp: BuildStamp | null,
  behind: number | null,
  dirtyAtBuild = stamp?.dirty === true,
  checkout: CheckoutDistance | null = null,
): string | null {
  if (stamp === null || stamp.commit === null) return null;
  if (behind === null || behind <= 0) {
    // Current — but a build cut from a modified tree is its own honest note:
    // "matches the commit" proves nothing about what was actually compiled.
    return dirtyAtBuild
      ? `planflow-ai: this build was cut from a DIRTY tree at ${stamp.commit.slice(0, 8)} — what runs may not match any commit`
      : null;
  }
  const plural = behind === 1 ? '' : 's';
  return (
    `planflow-ai: the running build is ${String(behind)} commit${plural} behind origin/main ` +
    `(built from ${stamp.commit.slice(0, 8)}${dirtyAtBuild ? ', dirty tree' : ''}) — ` +
    `${remedyFor(checkout)} (#1651)`
  );
}

/**
 * The step that would actually make the running build current.
 *
 * THE REMEDY IS THE WHOLE POINT OF THE NOTICE. #1651 exists because loops kept
 * beating through old machinery with nothing saying so; a notice that says so
 * and then hands over an instruction that provably does not work reintroduces
 * the same outcome one step later — the reader rebuilds, believes they are
 * current, and is not.
 *
 * `npm run build` compiles the WORKING TREE. When the working tree is missing
 * commits that are on origin/main, rebuilding produces a stamp that is behind by
 * exactly the same count and the notice returns unchanged on the very next
 * command (#1796, reproduced at 4 behind / 21 ahead). "to pick up landed fixes"
 * is the misleading half: those fixes are not in the checkout at all, and no
 * compile step can pick up a commit the checkout does not have.
 *
 * The diverged case names no command on purpose. `pull --ff-only` is what fails
 * there, and choosing rebase or merge on the reader's behalf is a guess about
 * their repository, not a remedy.
 *
 * UNKNOWN READS AS TODAY'S WORDING. Every path in this module fails soft, and
 * the wording that has been shipping is the honest thing to say when the second
 * fact could not be gathered.
 */
function remedyFor(checkout: CheckoutDistance | null): string {
  if (checkout === null || checkout.behind <= 0) {
    return 'run `npm run build` in the checkout to pick up landed fixes';
  }
  if (checkout.ahead <= 0) {
    return (
      `the checkout does not have those commits either, so a rebuild alone changes nothing — ` +
      'pull, then run `npm run build`'
    );
  }
  return (
    `the checkout has diverged (${String(checkout.ahead)} ahead, ${String(checkout.behind)} behind), ` +
    `so it does not have those commits and no rebuild can pick them up — ` +
    'reconcile with origin/main first, then run `npm run build`'
  );
}

/**
 * How far the working tree stands from origin/main, or null when git cannot say.
 *
 * `--left-right --count HEAD...origin/main` answers both halves in one call:
 * left is what only HEAD has (ahead), right is what only origin/main has
 * (behind).
 */
function checkoutDistance(packageRoot: string, exec: StalenessExec): CheckoutDistance | null {
  try {
    const [left, right] = exec(
      'git',
      ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
      packageRoot,
    )
      .trim()
      .split(/\s+/);
    const ahead = Number.parseInt(left ?? '', 10);
    const behind = Number.parseInt(right ?? '', 10);
    if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
    return { ahead, behind };
  } catch {
    return null; // no origin/main, unborn HEAD — silence, not a guess
  }
}

/**
 * The one call sites make. Every failure path is silence, deliberately: a
 * staleness NOTICE must never break a verb (no git, no origin/main ref, no
 * .git at the package root — each means "nothing to say", not "crash").
 */
export function detectCliStaleness(packageRoot: string, exec: StalenessExec): string | null {
  try {
    if (!existsSync(join(packageRoot, '.git'))) return null; // npm install, not a checkout
    const stamp = readBuildStamp(packageRoot);
    if (stamp === null || stamp.commit === null) return null;
    let behind: number | null = null;
    try {
      behind = Number.parseInt(
        exec('git', ['rev-list', '--count', `${stamp.commit}..origin/main`], packageRoot).trim(),
        10,
      );
      if (Number.isNaN(behind)) behind = null;
    } catch {
      behind = null; // unknown commit / no origin/main — silence, not a guess
    }
    return cliStalenessWarning(stamp, behind, stamp.dirty, checkoutDistance(packageRoot, exec));
  } catch {
    return null;
  }
}
