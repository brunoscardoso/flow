/**
 * `planflow-ai workspace <create|link|join|status|link-knowledge|links|describe|sync|move-flow-folder|migrate|rename|move-project|delete|set-default|set-remote|unset-remote>` — the ONE door onto
 * Workspaces, used by the terminal, the app and the heartbeat daemon alike.
 *
 * THIN ON PURPOSE. Every decision — where a Workspace lives, which project a
 * repo is, what linking does to an existing `flow/` — lives in
 * `handlers/workspace-model.ts` (allowed-pattern #14). This file parses,
 * calls, and prints.
 *
 * Contract (the `knowledge` / `worktree` precedent):
 *
 *   - Success: the result object on stdout, exit 0. `--json` prints it as one
 *     JSON line; without it, one human line. A second formatter, never a
 *     second computation.
 *   - Refusal: the payload (`{ action, refused, detail, ... }`) as one JSON
 *     line on stdout — with or without `--json`, because a refusal here is a
 *     question the asking surface has to put (allowed-pattern #21) — then ONE
 *     `workspace refused: <reason> — <sentence>` line via the repo logger
 *     (stdout too, allowed-pattern #15), exit 1.
 *   - Callers read the LAST parseable JSON line on stdout.
 *   - `join` reaches the network (one clone); `sync` fetches and pushes —
 *     plain pushes only, never a force (`handlers/workspace-sync.ts`). Its
 *     `ask` / `review` states are RESULTS (exit 0), not refusals: the payload
 *     carries the question and both sides.
 *
 * `link-knowledge` / `links` are the cross-project knowledge links
 * (`handlers/workspace-links.ts` — the one writer of `<workspace>/links.jsonl`).
 *
 * `sync --commit-only` commits and nothing else (the app's quit path).
 * `move-flow-folder --to <dir>` moves the Workspace part of the Flow folder
 * and re-points every checkout's `flow` link (`handlers/workspace-move.ts`);
 * the caller persists the new location (PLAN_FLOW_HOME) for later runs.
 *
 * The hard migration (decision 2026-10-06): `link --import` copies a repo's
 * existing knowledge in first (`handlers/workspace-import.ts`); `migrate
 * --roots <json>` links many repos into the Default Workspace at once
 * (`handlers/workspace-migrate.ts`, exit 0 with per-root failures in the
 * payload); `rename`, `move-project`, `delete` and `set-default` manage
 * Workspaces afterwards (`handlers/workspace-admin.ts`).
 *
 * `learn-connections [--pair <a>,<b> [--answer <file> | --model <outcome>]]`
 * learns how the Workspace's projects talk, one pair at a time
 * (`handlers/workspace-connections.ts`): without `--pair` it is the plan (and
 * the fast model's dossiers) and writes nothing.
 *
 * `set-remote --workspace <w> --remote <url> [--replace]` / `unset-remote
 * --workspace <w>` connect a Workspace to a shared repository after it was
 * created, or disconnect it (`handlers/workspace-remote.ts`). Neither contacts
 * the remote: the next `sync` publishes.
 */

import { error as logError } from '../utils/logger.js';
import { resolveFlowFolder } from '../utils/files.js';
import { syncAllWorkspaces, syncWorkspace, type SyncAllResult, type SyncResult } from '../handlers/workspace-sync.js';
import { moveFlowFolder, type MoveFlowFolderResult } from '../handlers/workspace-move.js';
import { migrateWorkspaces, type MigrateResult } from '../handlers/workspace-migrate.js';
import {
  deleteWorkspace,
  moveProject,
  renameWorkspace,
  setDefaultWorkspace,
  type DeleteResult,
  type MoveProjectResult,
  type RenameResult,
  type SetDefaultResult,
} from '../handlers/workspace-admin.js';
import {
  setWorkspaceRemote,
  unsetWorkspaceRemote,
  type SetRemoteResult,
  type UnsetRemoteResult,
} from '../handlers/workspace-remote.js';
import {
  WorkspaceRefusal,
  createWorkspace,
  describeProject,
  joinWorkspace,
  linkRepo,
  workspaceStatus,
  type CreateResult,
  type DescribeResult,
  type JoinResult,
  type LinkResult,
  type StatusListResult,
  type StatusTargetResult,
  type WorkspaceDeps,
} from '../handlers/workspace-model.js';
import {
  describeLink,
  linkKnowledge,
  listWorkspaceLinks,
  type LinkKnowledgeResult,
  type LinksListResult,
} from '../handlers/workspace-links.js';
import {
  describeLearnConnections,
  learnConnections,
  type LearnConnectionsPairResult,
  type LearnConnectionsPlanResult,
} from '../handlers/workspace-connections.js';

/** Prefix every refusal line carries — never doubled. */
const WORKSPACE_REFUSED_PREFIX = 'workspace refused:';

/** How long a refusal line may run before it is truncated. */
const REASON_MAX_LENGTH = 300;

/** Every action this command answers to. */
export const WORKSPACE_ACTIONS = [
  'create',
  'link',
  'join',
  'status',
  'link-knowledge',
  'links',
  'describe',
  'sync',
  'move-flow-folder',
  'migrate',
  'rename',
  'move-project',
  'delete',
  'set-default',
  'set-remote',
  'unset-remote',
  'learn-connections',
] as const;

export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

export function isWorkspaceAction(value: string): value is WorkspaceAction {
  return (WORKSPACE_ACTIONS as readonly string[]).includes(value);
}

/** Everything the actions read off the command line. */
export interface WorkspaceCommandOptions {
  /** create: the Workspace's name. join: the folder name on this machine. */
  name?: string;
  /** create: the Workspace's repository (recorded, never contacted). join: the repository to clone. */
  remote?: string;
  /** link / status: the code repository. */
  target?: string;
  /** link / status / link-knowledge / links: which Workspace (slug or name). */
  workspace?: string;
  /** link: map the repo onto this existing project (id or slug). links: only this project's links (slug). */
  project?: string;
  /** link-knowledge: `<project>/<feature-or-anchor>` on each end. move-flow-folder: `--to` is the new folder. */
  from?: string;
  to?: string;
  /** link-knowledge: calls | exposes | consumes | relates. */
  kind?: string;
  /** link-knowledge: one line of why/how. */
  note?: string;
  /** describe: the project's description. */
  text?: string;
  /** describe: only write when the project has no description yet. */
  ifEmpty?: boolean;
  /** link: a person has reviewed the code-repo commit that renames a committed flow/. */
  confirmCommit?: boolean;
  /** move-flow-folder: the caller will set PLAN_FLOW_HOME itself (nothing persists the new location). delete: a person asked. */
  confirm?: boolean;
  /** link: copy the knowledge `<repo>/flow` holds today into the Workspace first. */
  import?: boolean;
  /** migrate: a JSON array of absolute paths to code repositories. */
  roots?: string;
  /** migrate: report what would happen; write nothing. */
  dryRun?: boolean;
  /** sync: the commit message for local changes. */
  message?: string;
  /** sync: false with `--no-push` — commit, fetch and merge, but publish nothing. */
  push?: boolean;
  /** sync: every Workspace on this machine, one after another. */
  all?: boolean;
  /** sync: commit local changes only — no fetch, merge or push. */
  commitOnly?: boolean;
  /** sync: the Workspace-relative path of an ask/review to decide. */
  resolve?: string;
  /** sync: the id of the ask/review to decide — the decision applies only to exactly that content. */
  id?: string;
  /** sync --resolve / --id: ours | theirs | merged | file:<path>. */
  take?: string;
  /** set-remote: a person chose to change the shared repository the Workspace already has. */
  replace?: boolean;
  /** learn-connections: check this pair of projects, `<a>,<b>`. */
  pair?: string;
  /** learn-connections --pair: a file holding the fast model's raw answer. */
  answer?: string;
  /** learn-connections --pair: how the model pass ended when no answer is given. */
  model?: string;
  /** Print the result object rather than the human line. */
  json?: boolean;
}

/** Test seam — production passes none. */
export interface WorkspaceRuntime {
  flowFolder?: string;
  deps?: Partial<WorkspaceDeps>;
}

type WorkspaceResult =
  | CreateResult
  | LinkResult
  | JoinResult
  | StatusListResult
  | StatusTargetResult
  | LinkKnowledgeResult
  | LinksListResult
  | DescribeResult
  | SyncResult
  | SyncAllResult
  | MoveFlowFolderResult
  | MigrateResult
  | RenameResult
  | MoveProjectResult
  | DeleteResult
  | SetDefaultResult
  | SetRemoteResult
  | UnsetRemoteResult
  | LearnConnectionsPlanResult
  | LearnConnectionsPairResult;

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > REASON_MAX_LENGTH ? `${collapsed.slice(0, REASON_MAX_LENGTH - 1)}…` : collapsed;
}

function required(value: string | undefined, flag: string, action: WorkspaceAction): string {
  if (value === undefined || value.trim() === '') {
    throw new WorkspaceRefusalLine(`${action} needs --${flag}`);
  }
  return value;
}

function dispatch(action: WorkspaceAction, options: WorkspaceCommandOptions, runtime: WorkspaceRuntime): WorkspaceResult {
  const context = {
    ...(runtime.flowFolder === undefined ? {} : { flowFolder: runtime.flowFolder }),
    ...(runtime.deps === undefined ? {} : { deps: runtime.deps }),
  };
  switch (action) {
    case 'create':
      return createWorkspace({
        ...context,
        name: required(options.name, 'name', action),
        ...(options.remote === undefined ? {} : { remote: options.remote }),
      });
    case 'link':
      return linkRepo({
        ...context,
        target: required(options.target, 'target', action),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(options.project === undefined ? {} : { project: options.project }),
        // THE TYPED FLAG IS THE CONFIRMATION (forbidden-pattern #15): the
        // code-repo commit happens only when a caller says a person asked.
        confirmCommit: options.confirmCommit === true,
        import: options.import === true,
      });
    case 'join':
      return joinWorkspace({
        ...context,
        remote: required(options.remote, 'remote', action),
        ...(options.name === undefined ? {} : { name: options.name }),
      });
    case 'status':
      return workspaceStatus({
        ...context,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      });
    case 'link-knowledge':
      return linkKnowledge({
        ...context,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        from: required(options.from, 'from', action),
        to: required(options.to, 'to', action),
        kind: required(options.kind, 'kind', action),
        ...(options.note === undefined ? {} : { note: options.note }),
      });
    case 'learn-connections':
      return learnConnections({
        ...context,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(options.pair === undefined ? {} : { pair: options.pair }),
        ...(options.answer === undefined ? {} : { answer: options.answer }),
        ...(options.model === undefined ? {} : { model: options.model }),
      });
    case 'links':
      return listWorkspaceLinks({
        ...context,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(options.project === undefined ? {} : { project: options.project }),
      });
    case 'describe':
      return describeProject({
        ...context,
        project: required(options.project, 'project', action),
        text: required(options.text, 'text', action),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ifEmpty: options.ifEmpty === true,
      });
    case 'sync':
      return dispatchSync(options, runtime);
    case 'move-flow-folder':
      // Both folders explicit: the handler has no default for either (forbidden-pattern #15).
      return moveFlowFolder({
        flowFolder: runtime.flowFolder ?? resolveFlowFolder(),
        to: required(options.to, 'to', action),
        confirm: options.confirm === true,
        ...(runtime.deps?.now === undefined ? {} : { now: runtime.deps.now }),
      });
    case 'migrate':
      return migrateWorkspaces({
        ...context,
        roots: parseRoots(required(options.roots, 'roots', action)),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        dryRun: options.dryRun === true,
      });
    case 'rename':
      return renameWorkspace({
        ...context,
        workspace: required(options.workspace, 'workspace', action),
        name: required(options.name, 'name', action),
      });
    case 'move-project':
      return moveProject({
        ...context,
        project: required(options.project, 'project', action),
        to: required(options.to, 'to', action),
        ...(options.from === undefined ? {} : { from: options.from }),
      });
    case 'delete':
      return deleteWorkspace({
        ...context,
        workspace: required(options.workspace, 'workspace', action),
        // THE TYPED FLAG IS THE CONFIRMATION (forbidden-pattern #15).
        confirm: options.confirm === true,
      });
    case 'set-default':
      return setDefaultWorkspace({ ...context, workspace: required(options.workspace, 'workspace', action) });
    case 'set-remote':
      return setWorkspaceRemote({
        ...context,
        workspace: required(options.workspace, 'workspace', action),
        remote: required(options.remote, 'remote', action),
        // THE TYPED FLAG IS THE CONFIRMATION (forbidden-pattern #15).
        replace: options.replace === true,
      });
    case 'unset-remote':
      return unsetWorkspaceRemote({ ...context, workspace: required(options.workspace, 'workspace', action) });
  }
}

/** `--roots` is a JSON array; anything else is the handler's `invalid-roots` refusal. */
function parseRoots(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return (Array.isArray(parsed) ? parsed : [null]) as string[];
}

/**
 * `sync`. The Flow folder is resolved HERE, explicitly, because the handler
 * takes no default (forbidden-pattern #15); pushing is on unless `--no-push`.
 */
function dispatchSync(options: WorkspaceCommandOptions, runtime: WorkspaceRuntime): SyncResult | SyncAllResult {
  const flowFolder = runtime.flowFolder ?? resolveFlowFolder();
  const push = options.push !== false;
  const shared = {
    flowFolder,
    push,
    ...(runtime.deps === undefined ? {} : { deps: runtime.deps }),
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.commitOnly === true ? { commitOnly: true } : {}),
  };
  const deciding = options.resolve !== undefined || options.id !== undefined;
  if (options.all === true) {
    if (options.workspace !== undefined || deciding) {
      throw new WorkspaceRefusalLine('sync --all syncs every Workspace — it takes neither --workspace nor --resolve/--id');
    }
    return syncAllWorkspaces(shared);
  }
  if (options.commitOnly === true && deciding) {
    throw new WorkspaceRefusalLine('sync --commit-only commits and nothing else — it takes no --resolve/--id');
  }
  if (deciding !== (options.take !== undefined)) {
    throw new WorkspaceRefusalLine('sync --resolve <path> needs --take ours|theirs|merged|file:<path>, and --take needs --resolve or --id');
  }
  return syncWorkspace({
    ...shared,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(!deciding || options.take === undefined
      ? {}
      : {
          resolve: {
            ...(options.resolve === undefined ? {} : { path: options.resolve }),
            ...(options.id === undefined ? {} : { id: options.id }),
            take: options.take,
          },
        }),
  });
}

function renderSync(result: SyncResult): string {
  const parts: string[] = [];
  if (result.recovered.lock !== null) parts.push('cleared a leftover lock');
  if (result.recovered.merge) parts.push('undid a merge an earlier sync left half-done');
  if (result.committed !== null) parts.push(`committed ${result.committed.files} file(s)`);
  if (result.pulled > 0) parts.push(`pulled ${result.pulled} commit(s)`);
  if (result.resolutions.length > 0) parts.push(`${result.resolutions.length} merge(s) recorded`);
  if (result.pushed) parts.push('pushed');
  if (result.asks.length > 0) parts.push(`${result.asks.length} need a decision`);
  if (result.reviews.length > 0) parts.push(`${result.reviews.length} need a merged version`);
  if (result.rules.copied.length > 0) parts.push(`team rules copied into ${result.rules.copied.length} checkout(s)`);
  const tail = parts.length === 0 ? '' : ` — ${parts.join(', ')}`;
  return `workspace: ${result.workspace.name} ${result.state}${tail}${result.detail === undefined ? '' : `. ${result.detail}`}`;
}

function renderHuman(result: WorkspaceResult): string {
  switch (result.action) {
    case 'create':
      return `workspace: created ${result.workspace.name} at ${result.workspace.path}${result.workspace.remote === null ? '' : ` (remote ${result.workspace.remote}, not pushed)`}`;
    case 'link': {
      const linked = result as LinkResult;
      const kept =
        linked.previous.kind === 'folder' || linked.previous.kind === 'committed-folder' || linked.previous.kind === 'knowledge-repo'
          ? `; the old flow/ is kept at ${linked.previous.keptAt}`
          : '';
      const imported = linked.imported === null ? '' : `; ${linked.imported.files} file(s) imported`;
      const commit = linked.codeRepo.commit === null ? '' : `; code repo committed ${linked.codeRepo.commit.sha.slice(0, 7)}`;
      return `workspace: ${linked.project.name} → ${linked.workspace.name} (flow → ${linked.project.flowPath}, ${linked.link})${imported}${kept}${commit}`;
    }
    case 'join': {
      const joined = result as JoinResult;
      return `workspace: joined ${joined.workspace.name} — ${joined.linked.length} linked, ${joined.noLocalCheckout.length} with no checkout here, ${joined.needsReview.length} need review`;
    }
    case 'status': {
      if ('target' in result) {
        const status = result as StatusTargetResult;
        if (status.workspace === null || status.project === null) return 'workspace: this project is in no Workspace';
        return `workspace: ${status.project.name} in ${status.workspace.name}${status.linked ? '' : ' (flow not linked yet)'} — ${status.siblings.length} sibling project(s)`;
      }
      const list = result as StatusListResult;
      if (list.workspaces.length === 0) return 'workspace: none on this machine';
      return list.workspaces.map((workspace) => `workspace: ${workspace.name} (${workspace.projects.length} project(s))`).join('\n');
    }
    case 'link-knowledge': {
      const linked = result as LinkKnowledgeResult;
      const notes = linked.mirrored.filter((mirror) => mirror.written).length;
      return `workspace: ${linked.recorded ? 'linked' : 'already linked'} ${describeLink(linked.link)} — ${notes} feature note(s) updated`;
    }
    case 'learn-connections':
      return describeLearnConnections(result as LearnConnectionsPlanResult | LearnConnectionsPairResult);
    case 'links': {
      const listed = result as LinksListResult;
      if (listed.links.length === 0) return `workspace: no links in ${listed.workspace.name}${listed.project === null ? '' : ` for ${listed.project}`}`;
      return listed.links.map((link) => `${describeLink(link)}${link.note === undefined ? '' : ` — ${link.note}`}`).join('\n');
    }
    case 'describe': {
      const described = result as DescribeResult;
      return `workspace: ${described.project.name} ${described.changed ? 'described' : 'unchanged'}`;
    }
    case 'sync': {
      if ('all' in result) {
        const all = result as SyncAllResult;
        if (all.results.length === 0) return 'workspace: none on this machine';
        return all.results
          .map((entry) => ('state' in entry ? renderSync(entry as SyncResult) : `workspace: ${entry.workspace.slug} refused — ${entry.detail}`))
          .join('\n');
      }
      return renderSync(result as SyncResult);
    }
    case 'migrate': {
      const migrated = result as MigrateResult;
      const head = migrated.dryRun
        ? `workspace: would migrate into ${migrated.workspace.name}${migrated.would === 'create-workspace' ? ' (created)' : ''}`
        : `workspace: migrated into ${migrated.workspace.name}${migrated.workspace.created ? ' (created)' : ''}`;
      const linked = migrated.dryRun ? (migrated.plan ?? []).filter((entry) => entry.would === 'link').length : migrated.migrated.length;
      return `${head} — ${linked} linked, ${migrated.unchanged.length} unchanged, ${migrated.pending.length} waiting for a commit, ${migrated.failed.length} failed`;
    }
    case 'rename': {
      const renamed = result as RenameResult;
      return renamed.changed ? `workspace: ${renamed.previousName} renamed ${renamed.workspace.name}` : `workspace: ${renamed.workspace.name} unchanged`;
    }
    case 'move-project': {
      const moved = result as MoveProjectResult;
      return `workspace: ${moved.project.name} moved from ${moved.from.name} to ${moved.to.name} — ${moved.relinked.length} flow link(s) re-pointed`;
    }
    case 'delete': {
      const deleted = result as DeleteResult;
      return `workspace: deleted ${deleted.workspace.name} — ${deleted.movedProjects.length} project(s) moved to ${deleted.into.name}; kept at ${deleted.keptAt}. ${deleted.detail}`;
    }
    case 'set-default': {
      const chosen = result as SetDefaultResult;
      return `workspace: ${chosen.workspace.name} is the Default`;
    }
    case 'set-remote': {
      const connected = result as SetRemoteResult;
      return connected.changed
        ? `workspace: ${connected.workspace.name} now shares through ${connected.remote}. ${connected.detail}`
        : `workspace: ${connected.workspace.name} already shares through ${connected.remote}`;
    }
    case 'unset-remote': {
      const disconnected = result as UnsetRemoteResult;
      return disconnected.changed
        ? `workspace: ${disconnected.workspace.name} no longer shares through ${disconnected.previous ?? 'a repository'}. ${disconnected.detail}`
        : `workspace: ${disconnected.workspace.name} has no shared repository`;
    }
    case 'move-flow-folder': {
      const moved = result as MoveFlowFolderResult;
      const notes = [`${moved.relinked.length} flow link(s) re-pointed`];
      if (moved.untouched.length > 0) notes.push(`${moved.untouched.length} left as they were`);
      if (moved.failed.length > 0) notes.push(`${moved.failed.length} could not be re-pointed`);
      return `workspace: moved ${moved.moved.join(', ')} from ${moved.from} to ${moved.to} — ${notes.join(', ')}. Later runs need PLAN_FLOW_HOME=${moved.to}`;
    }
  }
}

/**
 * `workspace <action>` — on any failure: the payload line, one
 * `workspace refused:` line, exit 1.
 */
export function runWorkspace(action: string, options: WorkspaceCommandOptions, runtime: WorkspaceRuntime = {}): void {
  try {
    if (!isWorkspaceAction(action)) {
      throw new WorkspaceRefusalLine(`unknown action '${action}' — expected ${WORKSPACE_ACTIONS.join('|')}`);
    }
    const result = dispatch(action, options, runtime);
    process.stdout.write(options.json === true ? `${JSON.stringify(result)}\n` : `${renderHuman(result)}\n`);
  } catch (error) {
    if (error instanceof WorkspaceRefusal) {
      process.stdout.write(`${JSON.stringify({ action, ...error.payload })}\n`);
      logError(`${WORKSPACE_REFUSED_PREFIX} ${oneLine(`${error.reason} — ${error.sentence}`)}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logError(`${WORKSPACE_REFUSED_PREFIX} ${oneLine(message)}`);
    }
    process.exitCode = 1;
  }
}

/** A refusal with nothing to hand back (an unknown action, a missing flag). */
class WorkspaceRefusalLine extends Error {}
