/**
 * Connecting a Workspace to a shared repository — after it was created.
 *
 *   workspace set-remote --workspace <w> --remote <url> [--replace]
 *   workspace unset-remote --workspace <w>
 *
 * Until now a Workspace's shared repository could only be named at `create
 * --remote`. These two verbs are THE one door for it afterwards (allowed-
 * pattern #14): the app's "Connect a shared repository…", the terminal and any
 * skill all call them, and nothing else writes a Workspace's `origin` or the
 * `remote` its `workspace.json` records.
 *
 * WHAT `set-remote` DOES — and what it does not:
 *
 *   · validates the address with the ONE grammar the app shares
 *     (`parseGitRemote`, pinned to app/src/shared/git-remote-fixtures.json):
 *     https or ssh only, never credentials in it — validated, never rewritten
 *     (allowed-pattern #22);
 *   · sets the Workspace repository's `origin` (`git remote add -- origin
 *     <url>`, the `--` before the positional) and `remote` in workspace.json;
 *   · DOES NOT CONTACT THE REMOTE. Nothing is fetched or pushed here: the next
 *     `workspace sync` publishes the Workspace there. If the repository already
 *     holds this Workspace's history (a teammate's, an earlier connection),
 *     sync's ordinary merge brings it in; if it holds a history with nothing in
 *     common, sync refuses `unrelated-history` and nothing is mixed.
 *
 * A Workspace that already shares through ANOTHER repository is refused
 * `remote-exists` unless `--replace` says a person chose to change it
 * (forbidden-pattern #15: the destructive branch needs a typed flag). The old
 * repository is not touched — it simply stops being where this Workspace syncs.
 * Replacing drops the old remote's tracking refs with it (`git remote remove`),
 * so the next sync never judges the new repository against the old one's
 * history.
 *
 * `unset-remote` keeps everything local: the Workspace, its history and its
 * projects stay exactly as they are on this machine, and the shared repository
 * is left alone. The Workspace is then local-only until it is connected again.
 *
 * Both refuse while the Workspace is being synced (`sync-busy`) or holds a
 * half-done merge (`merge-in-progress`) — decided before anything is written.
 */

import { redactRemote } from './knowledge-migration.js';
import { refuseIfBusy } from './workspace-admin.js';
import {
  NO_HINTS,
  WorkspaceRefusal,
  contextOf,
  errorText,
  isRepoRoot,
  originOf,
  pickWorkspace,
  readWorkspace,
  remoteRefusal,
  scanWorkspaces,
  summaryOf,
  writeWorkspace,
  type LoadedWorkspace,
  type WorkspaceContext,
  type WorkspaceGit,
  type WorkspaceSummary,
} from './workspace-model.js';

const REMOTE_NAME = 'origin';

export interface SetRemoteOptions extends WorkspaceContext {
  workspace: string;
  remote: string;
  /** A person chose to change a shared repository the Workspace already has (forbidden-pattern #15). */
  replace?: boolean;
}

export interface SetRemoteResult {
  action: 'set-remote';
  workspace: WorkspaceSummary;
  /** The address now recorded, exactly as given (trimmed). */
  remote: string;
  /** The shared repository it had before (credentials masked), or null. */
  previous: string | null;
  /** False when it already shared through exactly this address. */
  changed: boolean;
  /** Always false: this verb never contacts the remote — the next sync publishes. */
  pushed: false;
  detail: string;
}

export interface UnsetRemoteOptions extends WorkspaceContext {
  workspace: string;
}

export interface UnsetRemoteResult {
  action: 'unset-remote';
  workspace: WorkspaceSummary;
  /** The shared repository it had (credentials masked), or null. */
  previous: string | null;
  changed: boolean;
  /** Always true: the shared repository itself is never touched. */
  remoteUntouched: true;
  detail: string;
}

function attempt(git: WorkspaceGit, args: string[], cwd: string): boolean {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/** The Workspace folder must be the top of its own repository — never one around it. */
function requireRepository(workspace: LoadedWorkspace, git: WorkspaceGit): void {
  if (!isRepoRoot(workspace.path, git)) {
    throw new WorkspaceRefusal('not-a-git-repo', `the ${workspace.file.name} Workspace folder is not a git repository`, { workspace: workspace.slug });
  }
}

/** Busy and half-done merges are refused before anything is written. */
function refuseIfUnsettled(workspace: LoadedWorkspace, git: WorkspaceGit): void {
  refuseIfBusy([workspace]);
  if (attempt(git, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], workspace.path)) {
    throw new WorkspaceRefusal(
      'merge-in-progress',
      `a merge was left half-done in the ${workspace.file.name} Workspace, so its shared repository can't change until a sync settles it`,
      { workspace: workspace.slug }
    );
  }
}

/** Whether git has an `origin` remote at all (with or without a url). */
function hasOrigin(workspace: LoadedWorkspace, git: WorkspaceGit): boolean {
  try {
    return git(['remote'], workspace.path)
      .split('\n')
      .some((line) => line.trim() === REMOTE_NAME);
  } catch {
    return false;
  }
}

/** Remove `origin` — and with it every `refs/remotes/origin/*` tracking ref. */
function removeOrigin(workspace: LoadedWorkspace, git: WorkspaceGit): void {
  if (!hasOrigin(workspace, git)) return;
  try {
    git(['remote', 'remove', REMOTE_NAME], workspace.path);
  } catch (error) {
    throw new WorkspaceRefusal('failed', `the Workspace's current shared repository could not be let go of: ${errorText(error)}`, {
      workspace: workspace.slug,
    });
  }
}

function withRemote(workspace: LoadedWorkspace, remote: string | undefined): LoadedWorkspace {
  const file = { ...workspace.file };
  if (remote === undefined) delete file.remote;
  else file.remote = remote;
  return { ...workspace, file };
}

/** Connect a Workspace to a shared repository. Contacts nothing — the next sync publishes. */
export function setWorkspaceRemote(options: SetRemoteOptions): SetRemoteResult {
  const { flowFolder, deps } = contextOf(options);
  const remote = options.remote.trim();
  const invalid = remoteRefusal(remote);
  if (invalid !== null) throw invalid;
  const workspace = pickWorkspace(scanWorkspaces(flowFolder), options.workspace, NO_HINTS);
  requireRepository(workspace, deps.git);

  const origin = originOf(workspace.path, deps.git);
  const recorded = workspace.file.remote ?? null;
  const current = origin ?? recorded;
  if (origin === remote && recorded === remote) {
    return {
      action: 'set-remote',
      workspace: summaryOf(workspace, deps.git),
      remote,
      previous: redactRemote(remote),
      changed: false,
      pushed: false,
      detail: 'The Workspace already shares through this repository.',
    };
  }
  const other = [origin, recorded].find((value): value is string => value !== null && value !== remote);
  if (other !== undefined && options.replace !== true) {
    throw new WorkspaceRefusal(
      'remote-exists',
      `the ${workspace.file.name} Workspace already shares through another repository — say so to replace it`,
      { workspace: workspace.slug, current: redactRemote(other), wanted: remote, needs: 'replace' }
    );
  }
  refuseIfUnsettled(workspace, deps.git);

  if (origin !== remote) {
    removeOrigin(workspace, deps.git);
    try {
      deps.git(['remote', 'add', '--', REMOTE_NAME, remote], workspace.path);
    } catch (error) {
      // Put the previous address back, so a failure leaves the Workspace as it was.
      if (origin !== null) attempt(deps.git, ['remote', 'add', '--', REMOTE_NAME, origin], workspace.path);
      throw new WorkspaceRefusal('failed', `the shared repository could not be recorded, so nothing changed: ${errorText(error)}`, {
        workspace: workspace.slug,
      });
    }
  }
  if (recorded !== remote) writeWorkspace(withRemote(workspace, remote));

  return {
    action: 'set-remote',
    workspace: summaryOf(readWorkspace(flowFolder, workspace.slug), deps.git),
    remote,
    previous: current === null ? null : redactRemote(current),
    changed: true,
    pushed: false,
    detail: 'Nothing was sent yet — the next sync publishes the Workspace there.',
  };
}

/** Disconnect a Workspace from its shared repository. Everything stays on this machine; the repository is untouched. */
export function unsetWorkspaceRemote(options: UnsetRemoteOptions): UnsetRemoteResult {
  const { flowFolder, deps } = contextOf(options);
  const workspace = pickWorkspace(scanWorkspaces(flowFolder), options.workspace, NO_HINTS);
  requireRepository(workspace, deps.git);

  const origin = originOf(workspace.path, deps.git);
  const recorded = workspace.file.remote ?? null;
  const previous = origin ?? recorded;
  const keptLine = 'The Workspace and its history stay on this machine; the shared repository was not touched.';
  if (previous === null && !hasOrigin(workspace, deps.git)) {
    return {
      action: 'unset-remote',
      workspace: summaryOf(workspace, deps.git),
      previous: null,
      changed: false,
      remoteUntouched: true,
      detail: 'The Workspace has no shared repository.',
    };
  }
  refuseIfUnsettled(workspace, deps.git);

  removeOrigin(workspace, deps.git);
  if (recorded !== null) writeWorkspace(withRemote(workspace, undefined));

  return {
    action: 'unset-remote',
    workspace: summaryOf(readWorkspace(flowFolder, workspace.slug), deps.git),
    previous: previous === null ? null : redactRemote(previous),
    changed: true,
    remoteUntouched: true,
    detail: keptLine,
  };
}
