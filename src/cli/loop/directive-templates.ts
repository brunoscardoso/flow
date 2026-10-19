/**
 * Seeding a fresh project's loop directives.
 *
 * `init` provisions `.claude/**` and `flow/**`, and for a long time provisioned
 * nothing else — so a freshly-provisioned checkout had no `loops/` at all, and
 * the first `/run fix` on a second machine failed with `no directive for loop
 * 'fix'`. A project starts with loops now.
 *
 * Three rules shape every decision here, and each of them is the conservative
 * reading of a real hazard:
 *
 *   - **PAUSED, always.** A seeded directive is a guess at what this project
 *     wants swept. Reading it and resuming it is a deliberate act by the user
 *     (`paused: false`, committed) — the templates say so in their own prose.
 *   - **The queue is bound to what actually resolved, never to a placeholder.**
 *     The shipped templates are the `queue: ledger` form, which is valid on its
 *     own and needs no remote. Only when `git remote get-url origin` resolves to
 *     a real `owner/name` on github.com is the pair rewritten to
 *     `queue: github` + `repo: owner/name`. A guessed remote on a fork would be
 *     wrong, and `repo:` is the one field the parser refuses to default.
 *   - **Never overwrite.** A `loops/` directory holding ANYTHING is left
 *     completely alone. `init` runs on every IDE project-open, so a seeder that
 *     could clobber an edited mission would clobber it repeatedly.
 *
 * Nothing here throws: an unresolvable remote, a missing template directory or a
 * write failure degrades to a notice, because the install must never fail
 * because a template could not be copied.
 *
 * The templates ship from `templates/loops/` — this repo's own `loops/` are its
 * OWN directives (its repo, its missions, its verification commands) and must
 * not travel to someone else's project.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CopyResult } from '../types.js';
import { ensureDir, getPackageRoot } from '../utils/files.js';
import * as log from '../utils/logger.js';
import { REPO_PATTERN, TRACKED_LOOPS_DIRNAME } from './directive-parser.js';

/** Timeout for the one git call this module makes. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The only host whose remote becomes a `repo:`.
 *
 * `repo:` exists for `queue: github`, and that backend shells out to `gh`. A
 * GitLab or Bitbucket remote normalises to a perfectly well-formed `owner/name`
 * that `gh` would then resolve against github.com — a different repository, very
 * possibly someone else's. So a non-GitHub remote resolves to nothing and the
 * project keeps the local ledger queue, which needs no remote at all.
 */
const GITHUB_HOST = 'github.com';

/** Where the shipped templates live, relative to the package root. */
const TEMPLATE_SEGMENTS = ['templates', 'loops'] as const;

/** The `queue:` line the shipped templates carry — the no-remote form. */
const LEDGER_QUEUE_LINE = /^queue: ledger[^\S\n]*$/m;

/**
 * The commented `repo:` placeholder. A COMMENT rather than a value on purpose:
 * the parser skips `#` lines, so the shipped template is a valid directive as
 * it stands, and a project with no GitHub remote gets a file that parses rather
 * than one that refuses at boot.
 */
const REPO_PLACEHOLDER_LINE = /^#\s*repo:.*$/m;

export interface DirectiveSeedDeps {
  /**
   * Run a command and return its stdout; must throw on non-zero exit or
   * timeout. Injected so tests never shell out to a real `git`.
   */
  exec: (command: string, args: readonly string[], cwd: string) => string;
  /** Root of the installed package, holding `templates/loops/`. */
  packageRoot: string;
}

export interface DirectiveSeedResult extends CopyResult {
  /** `owner/name` the seeded directives were bound to, or null when none resolved. */
  repo: string | null;
  /** One line describing what happened — always present, even when nothing was written. */
  notice: string;
}

/**
 * Defaults are resolved per CALL, not at module load, so a test or an E2E that
 * points the package root somewhere else is honoured by the code it is testing.
 */
function defaultDeps(): DirectiveSeedDeps {
  return {
    exec: (command, args, cwd) =>
      execFileSync(command, [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }),
    packageRoot: getPackageRoot(),
  };
}

/**
 * Normalise a git remote URL to `owner/name`, or null when it is not a GitHub
 * repository this can state with certainty.
 *
 * Null is the SAFE answer and is returned generously: a nested GitLab group, a
 * GitHub Enterprise host we cannot recognise, a path with more or fewer than two
 * segments. The cost of null is a local ledger queue; the cost of a wrong guess
 * is a loop pointed at a repository nobody chose.
 */
export function repoFromRemote(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (url.length === 0) return null;

  // Two shapes reach this function: scp-like (`git@host:owner/name.git`) and
  // URL-like (`https://host/owner/name.git`, `ssh://git@host:22/owner/name`).
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(url);
  const uri = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(url);
  const match = scp ?? uri;
  if (match === null) return null;

  const host = match[1].toLowerCase();
  if (host !== GITHUB_HOST) return null;

  const path = match[2].replace(/\/+$/, '').replace(/\.git$/i, '');
  return REPO_PATTERN.test(path) ? path : null;
}

/**
 * Resolve this project's `origin` remote to `owner/name`, or null.
 * A project with no remote, no git, or a non-GitHub remote is the normal case,
 * not an error — hence the silent fall-through.
 */
export function resolveOriginRepo(
  target: string,
  exec: DirectiveSeedDeps['exec']
): string | null {
  try {
    return repoFromRemote(exec('git', ['-C', target, 'remote', 'get-url', 'origin'], target));
  } catch {
    // Sanctioned fail-soft: no git, no repo, no origin — all mean "no repo:".
    return null;
  }
}

/**
 * Bind a shipped template to a repository — for a caller that has been TOLD to.
 *
 * NO LONGER PART OF SEEDING. `init` used to call this with whatever
 * `git remote get-url origin` returned, so a project with a GitHub remote got
 * `queue: github` without anyone choosing it. Reported live: "the local project
 * should be a local todo list not github, the git should be checked only if the
 * user select the git" — from someone whose panel said "This project · queue"
 * while every run demanded `gh auth login`, because the seeded directive had
 * bound itself to the remote at install time.
 *
 * A remote is a fact about where code is pushed. It is not a statement about
 * where this project's work is LISTED, and reading one as the other is the
 * silent guess the thread-remote binding exists to refuse (allowed-pattern #22).
 * The choice is now made by a person — the Loops panel's "Change", or
 * `loop point --queue github --repo owner/name` — and this function is what
 * performs it once made.
 *
 * `null` returns the content untouched — the ledger form the template already
 * is. A repo rewrites BOTH lines or NEITHER: `repo:` under `queue: ledger` and a
 * missing `repo:` under `queue: github` are each a directive that refuses to
 * parse, so a template missing one of the two markers is left in the form that
 * is known to be valid.
 */
export function bindDirectiveQueue(content: string, repo: string | null): string {
  if (repo === null) return content;
  if (!LEDGER_QUEUE_LINE.test(content) || !REPO_PLACEHOLDER_LINE.test(content)) {
    return content;
  }
  return content
    .replace(LEDGER_QUEUE_LINE, 'queue: github')
    .replace(REPO_PLACEHOLDER_LINE, `repo: ${repo}`);
}

/** Absolute path of the shipped template directory. */
export function loopTemplatesDir(packageRoot: string): string {
  return join(packageRoot, ...TEMPLATE_SEGMENTS);
}

/** The shipped template filenames, sorted so a seed is deterministic. */
export function loopTemplateFiles(packageRoot: string): string[] {
  const dir = loopTemplatesDir(packageRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.md'))
      .sort();
  } catch {
    // Sanctioned fail-soft: an unreadable template dir seeds nothing.
    return [];
  }
}

/**
 * Seed `<target>/loops/` with the shipped directives, paused, bound to the
 * project's own remote when one resolves. Called by `initShared`.
 *
 * Idempotent by the crudest possible test — a `loops/` with any entry in it is
 * left alone. That bluntness is the point: the directory is hand-edited intent,
 * `init` runs on every project-open, and no per-file merge could tell an edited
 * mission from a stale one.
 */
export function seedLoopDirectives(
  target: string,
  deps: Partial<DirectiveSeedDeps> = {}
): DirectiveSeedResult {
  // `exec` stays on the deps for callers and tests that still inject a git —
  // seeding no longer runs one, because the list is no longer read off a remote.
  const { packageRoot } = { ...defaultDeps(), ...deps };
  const result: DirectiveSeedResult = {
    created: [],
    skipped: [],
    updated: [],
    repo: null,
    notice: '',
  };
  const loopsDir = join(target, TRACKED_LOOPS_DIRNAME);

  try {
    if (existsSync(loopsDir) && readdirSync(loopsDir).length > 0) {
      result.skipped.push(loopsDir);
      result.notice = `Loops: ${TRACKED_LOOPS_DIRNAME}/ already has directives — left untouched.`;
      log.skip(`${TRACKED_LOOPS_DIRNAME}/ already has directives`);
      return result;
    }

    const templates = loopTemplateFiles(packageRoot);
    if (templates.length === 0) {
      result.notice = `Loops: no directive templates found at ${loopTemplatesDir(packageRoot)} — none seeded.`;
      log.warn(result.notice);
      return result;
    }

    // THE LIST IS A CHOICE, NOT A CONSEQUENCE OF HAVING A REMOTE. Seeding
    // leaves the shipped `queue: ledger` in place; pointing a loop at GitHub is
    // something a person does afterwards, in the panel or with `loop point`.
    const templatesDir = loopTemplatesDir(packageRoot);
    ensureDir(loopsDir);

    for (const file of templates) {
      const dest = join(loopsDir, file);
      if (existsSync(dest)) {
        result.skipped.push(dest);
        continue;
      }
      writeFileSync(dest, readFileSync(join(templatesDir, file), 'utf-8'), 'utf-8');
      result.created.push(dest);
      log.success(`Created ${TRACKED_LOOPS_DIRNAME}/${file}`);
    }

    result.notice =
      `Loops: seeded ${result.created.length} paused directive(s) in ${TRACKED_LOOPS_DIRNAME}/ — ` +
      `queue: ledger (this project's own list).`;
    log.info(`${result.notice} Set \`paused: false\` in a directive to start it.`);
  } catch (error) {
    // Sanctioned fail-soft: the install never fails because a template could
    // not be copied. Whatever was written stays; the rest is a notice.
    const message = error instanceof Error ? error.message : String(error);
    result.notice = `Loops: seeding skipped (${message}).`;
    log.warn(result.notice);
  }

  return result;
}
