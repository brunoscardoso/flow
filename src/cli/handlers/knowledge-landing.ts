/**
 * DID THE WORK A KNOWLEDGE DOCUMENT DESCRIBES REACH THE DEFAULT BRANCH?
 *
 * The question is asked of the CODE repository, not of the Workspace: the
 * Workspace holds `projects/<slug>/…` knowledge, and whether that knowledge is
 * true is decided by what is on the default branch of the checkout it talks
 * about. `projects.local.json` is what connects the two, and it is the only
 * thing that knows where a project lives on THIS computer.
 *
 * The answer is three-valued, and the third value carries the weight. A
 * project that is not on this computer, a checkout someone moved, a git that
 * refused — none of those mean "not landed". They mean the question could not
 * be asked, and `knowledgeDisposition` shares on that, because a gate that
 * silently stops publishing when a folder moves is indistinguishable from a
 * gate that is broken.
 *
 * ── THE LIMIT, STATED ──────────────────────────────────────────────────────
 *
 * This finds a token in a commit MESSAGE on the default branch. A squash merge
 * mints a new commit but keeps the body, so the trailer rides along; so does a
 * rebase. What defeats it is a person rewriting the squash message by hand and
 * deleting the trailer — then the token is nowhere and the document waits.
 *
 * There is no clever recovery for that and this module does not pretend to one:
 * a heuristic that guessed "probably landed" would make the gate unpredictable,
 * which is worse than one that is occasionally conservative. The way out is a
 * person writing `status: shared`, which outranks the token by design.
 */
import { existsSync } from 'node:fs';

import { isRunToken, knowledgeDisposition, readKnowledgeStamp, runTrailer } from '../state/knowledge-status.js';
import type { WorkspaceGit } from './workspace-model.js';

/** Branch names tried, in order, when the repository does not say. */
const FALLBACK_DEFAULTS = ['main', 'master'] as const;

function run(git: WorkspaceGit, args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * The ref to search: the remote's own default branch where one is recorded,
 * then a local `main`/`master`.
 *
 * `origin/HEAD` FIRST, because it is the only one of these that is a fact
 * rather than a convention — it is what the remote said its default was when
 * the repository was cloned. Guessing `main` at a shop whose trunk is
 * `develop` would answer "not landed" about every document for ever.
 */
export function defaultBranchRef(git: WorkspaceGit, repo: string): string | null {
  const head = run(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo);
  if (head !== null && head.trim() !== '') {
    const ref = head.trim();
    // `refs/remotes/origin/main` — usable as a rev directly.
    if (run(git, ['rev-parse', '--verify', '--quiet', ref], repo) !== null) return ref;
  }
  for (const name of FALLBACK_DEFAULTS) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (run(git, ['rev-parse', '--verify', '--quiet', ref], repo) !== null) return ref;
    }
  }
  return null;
}

/**
 * Has `token` reached `repo`'s default branch?
 *
 * `true` landed · `false` not there yet · `null` unanswerable.
 */
export function tokenLanded(git: WorkspaceGit, repo: string, token: string): boolean | null {
  // A token that is not a bare word never reaches `--grep`. It cannot carry a
  // glob or a metacharacter, and a malformed one is an unanswerable question
  // rather than a licence to run something odd.
  if (!isRunToken(token)) return null;
  if (!existsSync(repo)) return null;
  if (run(git, ['rev-parse', '--git-dir'], repo) === null) return null;

  const ref = defaultBranchRef(git, repo);
  if (ref === null) return null;

  // --fixed-strings: the token is matched literally, never as a pattern.
  const found = run(
    git,
    ['log', '--max-count=1', '--format=%H', '--fixed-strings', `--grep=${runTrailer(token)}`, ref],
    repo
  );
  if (found === null) return null;
  return found.trim() !== '';
}

/**
 * Where a Workspace project's code lives on this computer, or null.
 *
 * Two lookups because the two files disagree about what names a project: the
 * Workspace names it by SLUG (the folder its knowledge sits in) and
 * `projects.local.json` keys by ID (the repository address). The workspace
 * file is what maps one to the other, and it is per-Workspace while the local
 * map is per-computer — which is the whole reason the local map is not shared.
 */
export function projectCheckout(
  localProjects: Readonly<Record<string, string>>,
  projects: readonly { slug: string; id: string }[],
  slug: string
): string | null {
  const project = projects.find((entry) => entry.slug === slug);
  if (project === undefined) return null;
  const path = localProjects[project.id];
  return path === undefined || path === '' ? null : path;
}

/** One document sync kept back, and the sentence-worthy reason. */
export interface HeldKnowledge {
  /** Workspace-relative, as `git diff --cached` prints it. */
  path: string;
  project: string;
  why: 'draft' | 'pending';
}

export interface HeldDeps {
  /** The document's text in the working tree, or null if it cannot be read. */
  readText: (relPath: string) => string | null;
  /** `projects.local.json` — project id → this computer's checkout path. */
  localProjects: Readonly<Record<string, string>>;
  /** The Workspace's own project list. */
  projects: readonly { slug: string; id: string }[];
}

/**
 * Which of the staged paths must not be committed yet.
 *
 * Only `authored` documents are candidates: a personal or generated file is
 * already decided by its class, and asking a second question about it would
 * let a stamp overrule the class table — the one place where "never share
 * this" is decided.
 *
 * The landing answer is cached per (project, token) because one run stamps
 * many documents and the git call is a process each time.
 */
export function heldKnowledgePaths(
  git: WorkspaceGit,
  stagedPaths: readonly string[],
  classify: (path: string) => string,
  deps: HeldDeps
): HeldKnowledge[] {
  const landedCache = new Map<string, boolean | null>();
  const held: HeldKnowledge[] = [];

  for (const path of stagedPaths) {
    const underProject = /^projects\/([^/]+)\/(.+)$/.exec(path);
    if (underProject === null) continue;
    if (!path.endsWith('.md')) continue;
    if (classify(path) !== 'authored') continue;

    const text = deps.readText(path);
    if (text === null) continue;
    const stamp = readKnowledgeStamp(text);
    if (stamp.readiness === null && stamp.landedBy === null) continue;

    const project = underProject[1];
    let landed: boolean | null = null;
    if (stamp.landedBy !== null) {
      const key = `${project}\u0000${stamp.landedBy}`;
      if (landedCache.has(key)) landed = landedCache.get(key) ?? null;
      else {
        const checkout = projectCheckout(deps.localProjects, deps.projects, project);
        landed = checkout === null ? null : tokenLanded(git, checkout, stamp.landedBy);
        landedCache.set(key, landed);
      }
    }

    const disposition = knowledgeDisposition(stamp, landed);
    if (disposition === 'hold-draft') held.push({ path, project, why: 'draft' });
    else if (disposition === 'hold-pending') held.push({ path, project, why: 'pending' });
  }
  return held;
}
