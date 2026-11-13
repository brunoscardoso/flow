/**
 * THE BRANCH A WORKSPACE SYNCS ON.
 *
 *   workspace branches   --workspace <w> [--remote <url>]
 *   workspace set-branch --workspace <w> --branch <name>
 *
 * A Workspace syncs on whatever branch its repository has checked out — git is
 * the record, nothing else holds it. These verbs are the one door for
 * CHOOSING it (allowed-pattern #14); `set-remote --branch` and `join --branch`
 * reach the same switch through `switchWorkspaceBranch`.
 *
 * `branches` READS the shared repository (`git ls-remote`, the only network
 * call here) and answers what a person needs to choose: the branches it has,
 * its default, which ones this machine saw refuse a direct push, and a
 * SUGGESTION labelled with where it came from (allowed-pattern #21) — never a
 * silent pick. It writes nothing.
 *
 * `set-branch` moves the Workspace to the named branch AT ITS CURRENT COMMIT:
 * the working tree is untouched and every local commit comes along; the next
 * sync merges what the remote holds there. A local branch of that name that
 * already holds commits the current one lacks is refused (`branch-diverged`)
 * rather than dropped. A person choosing clears the record of a move Flow made
 * by itself — the choice is theirs now.
 */

import {
  NO_HINTS,
  WORKSPACE_FALLBACK_BRANCH,
  WorkspaceRefusal,
  chosenBranchOf,
  clearBranchMove,
  contextOf,
  currentBranchOf,
  errorText,
  isRepoRoot,
  isValidBranchName,
  originOf,
  pickWorkspace,
  pullRequestOnlyBranches,
  readWorkspace,
  remoteRefusal,
  scanWorkspaces,
  setChosenBranch,
  summaryOf,
  type LoadedWorkspace,
  type WorkspaceContext,
  type WorkspaceGit,
  type WorkspaceSummary,
} from './workspace-model.js';
import { refuseIfBusy } from './workspace-admin.js';

export { WORKSPACE_FALLBACK_BRANCH };

// ─── Switching ──────────────────────────────────────────────────────────────

function tryRun(git: WorkspaceGit, args: string[], cwd: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function revParse(git: WorkspaceGit, repo: string, ref: string): string | null {
  try {
    const out = git(['rev-parse', '-q', '--verify', `${ref}^{commit}`], repo).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * Put the Workspace repository on `target`, losing nothing:
 *   · no local branch of that name, or one HEAD already contains → created /
 *     reset AT HEAD (the tree is untouched, local commits come along);
 *   · one that contains HEAD → checked out (it is HEAD plus more);
 *   · one that diverged → refused `branch-diverged`.
 * The CALLER validated the name. Returns whether anything changed.
 */
export function switchWorkspaceBranch(git: WorkspaceGit, repo: string, target: string, workspaceName: string): boolean {
  if (currentBranchOf(repo, git) === target) return false;
  const local = revParse(git, repo, `refs/heads/${target}`);
  const head = revParse(git, repo, 'HEAD');
  const contains = (ancestor: string, of: string): boolean => tryRun(git, ['merge-base', '--is-ancestor', ancestor, of], repo);
  if (local === null || head === null || contains(local, 'HEAD')) {
    if (!tryRun(git, ['switch', '-q', '-C', target], repo)) {
      throw new WorkspaceRefusal('failed', `the ${workspaceName} Workspace could not move to the branch '${target}'`, { branch: target });
    }
    return true;
  }
  if (contains('HEAD', local)) {
    try {
      git(['-c', 'core.symlinks=false', 'switch', '-q', target], repo);
      return true;
    } catch (error) {
      throw new WorkspaceRefusal('failed', `the ${workspaceName} Workspace could not move to the branch '${target}': ${errorText(error)}`, { branch: target });
    }
  }
  throw new WorkspaceRefusal(
    'branch-diverged',
    `this computer already has a branch '${target}' for the ${workspaceName} Workspace with changes the current one doesn't have, so Flow won't switch over it`,
    { branch: target }
  );
}

// ─── Suggesting ─────────────────────────────────────────────────────────────

export type BranchSuggestionSource =
  /** The branch this Workspace already syncs on, which the repository has. */
  | 'current'
  /** The fallback branch exists there: some member already moved to it. */
  | 'in-use'
  /** The repository's own default branch. */
  | 'default'
  /** The repository has no usable branch: this one will be created by the first sync. */
  | 'new';

export interface BranchSuggestion {
  name: string;
  source: BranchSuggestionSource;
}

/**
 * The branch to pre-select, and why. Never one this machine saw refuse a
 * direct push. Pure — the ladder is the whole decision.
 */
export function suggestBranch(input: {
  branches: readonly string[];
  defaultBranch: string | null;
  /** The Workspace's current branch, only when the repository asked about is the one it already uses. */
  current: string | null;
  /**
   * A person chose `current`. Only then does it outrank the fallback branch: an
   * UNCHOSEN branch is one sync follows away from as soon as the fallback
   * exists, so suggesting it would offer what sync is about to undo.
   */
  currentChosen?: boolean;
  pullRequestOnly: readonly string[];
}): BranchSuggestion {
  const usable = (name: string | null): name is string =>
    name !== null && input.branches.includes(name) && !input.pullRequestOnly.includes(name);
  if (input.currentChosen === true && usable(input.current)) return { name: input.current, source: 'current' };
  if (usable(WORKSPACE_FALLBACK_BRANCH)) return { name: WORKSPACE_FALLBACK_BRANCH, source: 'in-use' };
  if (usable(input.current)) return { name: input.current, source: 'current' };
  if (usable(input.defaultBranch)) return { name: input.defaultBranch, source: 'default' };
  const other = input.branches.find((name) => usable(name));
  if (other !== undefined) return { name: other, source: 'default' };
  if (input.branches.length === 0 && input.current !== null) return { name: input.current, source: 'new' };
  return { name: input.branches.length === 0 ? 'main' : WORKSPACE_FALLBACK_BRANCH, source: 'new' };
}

/** `git ls-remote --symref -- <remote> HEAD refs/heads/*`, read. */
export function parseLsRemote(out: string): { branches: string[]; defaultBranch: string | null } {
  const branches: string[] = [];
  let defaultBranch: string | null = null;
  for (const line of out.split('\n')) {
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (symref !== null) {
      defaultBranch = symref[1] ?? null;
      continue;
    }
    const head = /^[0-9a-f]{40,64}\s+refs\/heads\/(\S+)$/.exec(line.trim());
    if (head !== null && head[1] !== undefined) branches.push(head[1]);
  }
  return { branches: [...new Set(branches)].sort((a, b) => a.localeCompare(b)), defaultBranch };
}

// ─── The verbs ──────────────────────────────────────────────────────────────

function requireRepository(workspace: LoadedWorkspace, git: WorkspaceGit): void {
  if (!isRepoRoot(workspace.path, git)) {
    throw new WorkspaceRefusal('not-a-git-repo', `the ${workspace.file.name} Workspace folder is not a git repository`, { workspace: workspace.slug });
  }
}

export interface BranchesOptions extends WorkspaceContext {
  workspace: string;
  /** Ask about this repository instead of the one the Workspace uses (a connect not made yet). */
  remote?: string;
}

export interface BranchesResult {
  action: 'branches';
  workspace: WorkspaceSummary;
  /** The repository asked about, as given (an address a person typed is data). */
  remote: string;
  branches: Array<{ name: string; pullRequestOnly: boolean }>;
  defaultBranch: string | null;
  suggestion: BranchSuggestion;
}

export function listWorkspaceBranches(options: BranchesOptions): BranchesResult {
  const { flowFolder, deps } = contextOf(options);
  const workspace = pickWorkspace(scanWorkspaces(flowFolder), options.workspace, NO_HINTS);
  requireRepository(workspace, deps.git);
  const origin = originOf(workspace.path, deps.git);
  const asked = options.remote?.trim() || origin;
  if (asked === null || asked === undefined || asked === '') {
    throw new WorkspaceRefusal('remote-unreadable', `the ${workspace.file.name} Workspace has no shared repository to read branches from`, {
      workspace: workspace.slug,
    });
  }
  const invalid = remoteRefusal(asked);
  if (invalid !== null) throw invalid;
  let out: string;
  try {
    out = deps.git(['ls-remote', '--symref', '--', asked, 'HEAD', 'refs/heads/*'], workspace.path, { network: true });
  } catch (error) {
    throw new WorkspaceRefusal('remote-unreadable', `Flow couldn't read the branches of that repository: ${errorText(error)}`, { remote: asked });
  }
  const { branches, defaultBranch } = parseLsRemote(out);
  const pullRequestOnly = pullRequestOnlyBranches(workspace.path, deps.git);
  const sameRemote = origin !== null && origin === asked;
  const current = sameRemote ? currentBranchOf(workspace.path, deps.git) : null;
  return {
    action: 'branches',
    workspace: summaryOf(workspace, deps.git),
    remote: asked,
    branches: branches.map((name) => ({ name, pullRequestOnly: pullRequestOnly.includes(name) })),
    defaultBranch,
    suggestion: suggestBranch({
      branches,
      defaultBranch,
      current,
      currentChosen: current !== null && chosenBranchOf(workspace.path, deps.git) === current,
      pullRequestOnly,
    }),
  };
}

export interface SetBranchOptions extends WorkspaceContext {
  workspace: string;
  branch: string;
  /**
   * Put back a branch that was working, after a chosen one turned out unusable:
   * the switch happens, but nobody "chose" it — sync may move it again by itself.
   */
  restore?: boolean;
}

export interface SetBranchResult {
  action: 'set-branch';
  workspace: WorkspaceSummary;
  branch: string;
  previous: string | null;
  changed: boolean;
  detail: string;
}

/** Refuse a name git would not accept, before anything is touched. */
export function requireBranchName(branch: string, git: WorkspaceGit, cwd: string): string {
  if (!isValidBranchName(branch, git, cwd)) {
    throw new WorkspaceRefusal('invalid-branch', `'${branch}' isn't a name a branch can have`, { branch });
  }
  return branch;
}

/**
 * Apply a person's branch choice to a Workspace already loaded and checked:
 * switch, and clear the record of any move Flow made by itself.
 */
export function chooseWorkspaceBranch(
  workspace: LoadedWorkspace,
  git: WorkspaceGit,
  branch: string,
  restore = false
): { previous: string | null; changed: boolean } {
  const previous = currentBranchOf(workspace.path, git);
  const changed = switchWorkspaceBranch(git, workspace.path, branch, workspace.file.name);
  if (restore) {
    setChosenBranch(workspace.path, git, null);
  } else {
    clearBranchMove(workspace.path, git);
    setChosenBranch(workspace.path, git, branch);
  }
  return { previous, changed };
}

export function setWorkspaceBranch(options: SetBranchOptions): SetBranchResult {
  const { flowFolder, deps } = contextOf(options);
  const workspace = pickWorkspace(scanWorkspaces(flowFolder), options.workspace, NO_HINTS);
  requireRepository(workspace, deps.git);
  const branch = requireBranchName(options.branch, deps.git, workspace.path);
  refuseIfBusy([workspace]);
  if (tryRun(deps.git, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], workspace.path)) {
    throw new WorkspaceRefusal(
      'merge-in-progress',
      `a merge was left half-done in the ${workspace.file.name} Workspace, so its branch can't change until a sync settles it`,
      { workspace: workspace.slug }
    );
  }
  const { previous, changed } = chooseWorkspaceBranch(workspace, deps.git, branch, options.restore === true);
  return {
    action: 'set-branch',
    workspace: summaryOf(readWorkspace(flowFolder, workspace.slug), deps.git),
    branch,
    previous,
    changed,
    detail: changed ? 'Nothing was sent yet — the next sync exchanges the Workspace on this branch.' : 'The Workspace already syncs on this branch.',
  };
}
