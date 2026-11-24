/**
 * Managing Workspaces after the hard migration (decision 2026-10-06): there is
 * ALWAYS a Default Workspace, and a person can rename Workspaces, move projects
 * between them, delete one, and choose which is the Default.
 *
 *   workspace rename --workspace <w> --name <n>          the display name only — the folder (slug) stays, so no link breaks
 *   workspace set-default --workspace <w>                which Workspace is the Default ON THIS MACHINE
 *   workspace move-project --project <p> --to <w> [--from <w>]
 *   workspace delete --workspace <w> --confirm           its projects move to the Default; the folder is kept as a backup
 *   workspace remove-project --workspace <w> --project <p> --confirm
 *                                                        the project leaves that Workspace; its folder is kept as a backup
 *
 * THE DEFAULT IS LOCAL. It is recorded in `<Flow folder>/settings/
 * workspaces.local.json` (`readDefaultWorkspace` / `writeDefaultWorkspace` in
 * workspace-model.ts), never in the synced `workspace.json`: two teammates
 * sharing a Workspace each have their own Default.
 *
 * NOTHING IS EVER DELETED. A moved project's folder is renamed (copy + remove
 * only across disks); a deleted Workspace's folder is renamed to
 * `workspaces/.deleted-<slug>-<date>/` (scans skip dot-folders) and its remote
 * is not touched. In the source Workspace's repository a moved project's
 * removal is an ordinary change that its next `workspace sync` publishes;
 * cross-project links recorded under the old Workspace (`links.jsonl`, append-
 * only) stay where they were written.
 *
 * Every refusal is decided before anything is written (allowed-pattern #24's
 * other half), and the ones that ask carry their answer (allowed-pattern #21).
 * `delete` changes nothing without `--confirm` (forbidden-pattern #15).
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { writeBrainIndex } from '../state/brain-index.js';
import { createSymlink, isSymlink, readSymlinkTarget } from '../utils/files.js';
import { SYNC_LOCK_GIT_PATH, staleLock } from './workspace-sync.js';
import {
  NO_HINTS,
  WORKSPACE_PROJECTS_DIRNAME,
  WorkspaceRefusal,
  contextOf,
  createWorkspace,
  errorText,
  joinWorkspace,
  isName,
  pickWorkspace,
  projectFolder,
  readDefaultWorkspace,
  readLocalProjects,
  readWorkspace,
  realOrResolved,
  scaffoldProjectFolder,
  scanWorkspaces,
  slugify,
  stamp,
  summaryOf,
  uniqueSlug,
  viewOf,
  workspaceDir,
  workspaceLinkOf,
  workspacesDir,
  writeDefaultWorkspace,
  writeWorkspace,
  type LoadedWorkspace,
  type ProjectView,
  type WorkspaceContext,
  type WorkspaceDeps,
  type WorkspaceProject,
  type WorkspaceScan,
  type WorkspaceSummary,
  type JoinOptions,
  type JoinResult,
} from './workspace-model.js';

export { readDefaultWorkspace } from './workspace-model.js';

/** The name of the Workspace `migrate` creates when this machine has no Default. */
export const DEFAULT_WORKSPACE_NAME = 'Default';

/** A removed project's folder is renamed to `<this><workspace>-<project>-<YYYYMMDD>` under `workspaces/`. */
export const REMOVED_PROJECT_PREFIX = '.removed-';

/** A deleted Workspace's folder is renamed to `<this><slug>-<YYYYMMDD>`. */
export const DELETED_WORKSPACE_PREFIX = '.deleted-';

// ─── The Default ────────────────────────────────────────────────────────────

/** What `ensureDefaultWorkspace` would do — decided without writing. */
export type DefaultPlan =
  | { kind: 'recorded'; workspace: LoadedWorkspace }
  /** No record, but a Workspace already has the Default's folder name — it becomes the Default. */
  | { kind: 'adopt'; workspace: LoadedWorkspace }
  | { kind: 'create'; name: string; slug: string; path: string };

/** Read-only: which Workspace is (or would become) the Default. */
export function planDefaultWorkspace(flowFolder: string, name: string = DEFAULT_WORKSPACE_NAME): DefaultPlan {
  const recorded = readDefaultWorkspace(flowFolder);
  if (recorded !== null) return { kind: 'recorded', workspace: readWorkspace(flowFolder, recorded) };
  const wanted = slugify(name);
  if (wanted === '') throw new WorkspaceRefusal('invalid-name', 'a Workspace name needs at least one letter or digit');
  const scan = scanWorkspaces(flowFolder);
  const existing = scan.workspaces.find((workspace) => workspace.slug === wanted);
  if (existing !== undefined) return { kind: 'adopt', workspace: existing };
  const root = workspacesDir(flowFolder);
  const slug = uniqueSlug(wanted, new Set(existsSync(root) ? readdirSync(root) : []));
  return { kind: 'create', name: name.trim(), slug, path: workspaceDir(flowFolder, slug) };
}

/** The Default Workspace, made (and recorded) when this machine has none. */
export function ensureDefaultWorkspace(
  flowFolder: string,
  deps: WorkspaceDeps,
  name: string = DEFAULT_WORKSPACE_NAME
): { workspace: LoadedWorkspace; created: boolean } {
  const plan = planDefaultWorkspace(flowFolder, name);
  switch (plan.kind) {
    case 'recorded':
      return { workspace: plan.workspace, created: false };
    case 'adopt':
      writeDefaultWorkspace(flowFolder, plan.workspace.slug);
      return { workspace: plan.workspace, created: false };
    case 'create': {
      const made = createWorkspace({ flowFolder, deps, name: plan.name });
      writeDefaultWorkspace(flowFolder, made.workspace.slug);
      return { workspace: readWorkspace(flowFolder, made.workspace.slug), created: true };
    }
  }
}

export interface SetDefaultOptions extends WorkspaceContext {
  workspace: string;
}

export interface SetDefaultResult {
  action: 'set-default';
  workspace: WorkspaceSummary;
  /** The slug that was the Default before, or null. */
  previous: string | null;
}

export function setDefaultWorkspace(options: SetDefaultOptions): SetDefaultResult {
  const { flowFolder, deps } = contextOf(options);
  const workspace = pickWorkspace(scanWorkspaces(flowFolder), options.workspace, NO_HINTS);
  const previous = readDefaultWorkspace(flowFolder);
  if (previous !== workspace.slug) writeDefaultWorkspace(flowFolder, workspace.slug);
  return { action: 'set-default', workspace: summaryOf(workspace, deps.git), previous };
}

// ─── rename ─────────────────────────────────────────────────────────────────

export interface RenameOptions extends WorkspaceContext {
  workspace: string;
  name: string;
}

export interface RenameResult {
  action: 'rename';
  workspace: WorkspaceSummary;
  previousName: string;
  /** False when the name was already that. */
  changed: boolean;
}

/** Change a Workspace's display name. Its slug — the folder every `flow` link points into — never changes. */
export function renameWorkspace(options: RenameOptions): RenameResult {
  const { flowFolder, deps } = contextOf(options);
  const name = options.name.trim();
  if (!isName(name)) throw new WorkspaceRefusal('invalid-name', 'a Workspace needs a plain name');
  const scan = scanWorkspaces(flowFolder);
  const workspace = pickWorkspace(scan, options.workspace, NO_HINTS);
  const clash = scan.workspaces.find(
    (other) => other.slug !== workspace.slug && other.file.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (clash !== undefined) {
    throw new WorkspaceRefusal('duplicate-name', `there is already a Workspace called ${clash.file.name} on this machine`, {
      workspaces: scan.workspaces.map((entry) => ({ slug: entry.slug, name: entry.file.name })),
    });
  }
  const previousName = workspace.file.name;
  const changed = previousName !== name;
  if (changed) writeWorkspace({ ...workspace, file: { ...workspace.file, name } });
  return { action: 'rename', workspace: summaryOf(readWorkspace(flowFolder, workspace.slug), deps.git), previousName, changed };
}

// ─── move-project ───────────────────────────────────────────────────────────

/** Workspaces whose sync holds its lock right now. */
function busy(workspaces: readonly LoadedWorkspace[]): string[] {
  const now = new Date();
  return workspaces
    .filter((workspace) => {
      const lock = join(workspace.path, '.git', SYNC_LOCK_GIT_PATH);
      return existsSync(lock) && staleLock(lock, now) === null;
    })
    .map((workspace) => workspace.slug);
}

/** Refuse `sync-busy` while any of these Workspaces is being synced — before anything is written. */
export function refuseIfBusy(workspaces: readonly LoadedWorkspace[]): void {
  const held = busy(workspaces);
  if (held.length > 0) {
    throw new WorkspaceRefusal('sync-busy', 'a Workspace is being synced right now — try again once it has finished', { workspaces: held });
  }
}

/** rename, or — across file systems — copy then remove the original. */
function moveFolder(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

function findProject(workspace: LoadedWorkspace, wanted: string): WorkspaceProject | undefined {
  return workspace.file.projects.find((project) => project.slug === wanted) ?? workspace.file.projects.find((project) => project.id === wanted);
}

function sourceOf(
  scan: WorkspaceScan,
  project: string,
  from: string | undefined,
  target: LoadedWorkspace
): { workspace: LoadedWorkspace; project: WorkspaceProject } {
  if (from !== undefined) {
    const workspace = pickWorkspace(scan, from, NO_HINTS);
    const found = findProject(workspace, project);
    if (found === undefined) {
      throw new WorkspaceRefusal('unknown-project', `the ${workspace.file.name} Workspace has no project ${project}`, {
        workspace: workspace.slug,
        projects: workspace.file.projects.map((entry) => ({ id: entry.id, name: entry.name, slug: entry.slug })),
      });
    }
    return { workspace, project: found };
  }
  // A project already in the target is not the one being moved there.
  const all = scan.workspaces
    .map((workspace) => ({ workspace, project: findProject(workspace, project) }))
    .filter((entry): entry is { workspace: LoadedWorkspace; project: WorkspaceProject } => entry.project !== undefined);
  const holders = all.filter((entry) => entry.workspace.slug !== target.slug);
  if (holders.length === 0 && all.length > 0) {
    throw new WorkspaceRefusal('same-workspace', `${all[0].project.name} is already in the ${target.file.name} Workspace`, {
      workspace: target.slug,
      project: all[0].project.slug,
    });
  }
  if (holders.length === 0) {
    throw new WorkspaceRefusal('unknown-project', `no Workspace on this machine has a project ${project}`, {
      projects: scan.workspaces.flatMap((workspace) =>
        workspace.file.projects.map((entry) => ({ workspace: workspace.slug, id: entry.id, name: entry.name, slug: entry.slug }))
      ),
    });
  }
  if (holders.length > 1) {
    throw new WorkspaceRefusal('which-workspace', `more than one Workspace has a project ${project} — say which one it moves from`, {
      workspaces: holders.map((entry) => ({ slug: entry.workspace.slug, name: entry.workspace.file.name })),
    });
  }
  return holders[0];
}

export interface MoveProjectOptions extends WorkspaceContext {
  /** The project, by slug or id. */
  project: string;
  /** The Workspace it moves to (slug or name). */
  to: string;
  /** The Workspace it moves from — needed only when more than one has it. */
  from?: string;
}

export interface MoveProjectResult {
  action: 'move-project';
  /** The project as it is now, in the target Workspace (its slug may have taken a suffix). */
  project: ProjectView;
  from: WorkspaceSummary;
  to: WorkspaceSummary;
  movedFrom: string;
  movedTo: string;
  /** Checkouts whose `flow` link now points at the new folder. */
  relinked: { project: string; checkout: string; link: string }[];
  /** Checkouts of this project whose `flow` was not a link to the old folder — left as they were. */
  untouched: { project: string; checkout: string; reason: 'no-checkout' | 'not-a-link' | 'points-elsewhere' }[];
  /** Links that could not be re-pointed. */
  failed: { project: string; checkout: string; detail: string }[];
}

/**
 * Move one project's knowledge folder to another Workspace, update both
 * `workspace.json` files, and re-point every checkout's `flow` link.
 */
export function moveProject(options: MoveProjectOptions): MoveProjectResult {
  const { flowFolder, deps } = contextOf(options);
  const scan = scanWorkspaces(flowFolder);
  const target = pickWorkspace(scan, options.to, NO_HINTS);
  const source = sourceOf(scan, options.project, options.from, target);
  if (target.slug === source.workspace.slug) {
    throw new WorkspaceRefusal('same-workspace', `${source.project.name} is already in the ${target.file.name} Workspace`, {
      workspace: target.slug,
      project: source.project.slug,
    });
  }
  if (target.file.projects.some((entry) => entry.id === source.project.id)) {
    throw new WorkspaceRefusal('project-exists', `the ${target.file.name} Workspace already has ${source.project.name}`, {
      workspace: target.slug,
      project: source.project.id,
    });
  }
  refuseIfBusy([source.workspace, target]);
  const local = readLocalProjects(flowFolder);
  return executeMove(flowFolder, deps, source.workspace, source.project, target, local);
}

function executeMove(
  flowFolder: string,
  deps: WorkspaceDeps,
  sourceWorkspace: LoadedWorkspace,
  project: WorkspaceProject,
  target: LoadedWorkspace,
  local: Record<string, string>
): MoveProjectResult {
  const targetProjects = join(target.path, WORKSPACE_PROJECTS_DIRNAME);
  const takenSlugs = new Set([...target.file.projects.map((entry) => entry.slug), ...(existsSync(targetProjects) ? readdirSync(targetProjects) : [])]);
  const slug = uniqueSlug(project.slug, takenSlugs);
  const moved: WorkspaceProject = { ...project, slug };
  const from = projectFolder(flowFolder, sourceWorkspace.slug, project.slug);
  const to = projectFolder(flowFolder, target.slug, slug);
  const fromCandidates = new Set([resolve(from), realOrResolved(from)]);

  // 1. The target lists it first, so the project is never in neither.
  writeWorkspace({ ...target, file: { ...target.file, projects: [...target.file.projects, moved] } });
  // 2. The folder.
  try {
    if (existsSync(from)) moveFolder(from, to);
  } catch (error) {
    writeWorkspace(target);
    throw new WorkspaceRefusal('failed', `the project's knowledge folder could not be moved, so nothing changed: ${errorText(error)}`, {
      from,
      to,
      restored: true,
    });
  }
  scaffoldProjectFolder(to);
  // 3. The source lets go.
  writeWorkspace({ ...sourceWorkspace, file: { ...sourceWorkspace.file, projects: sourceWorkspace.file.projects.filter((entry) => entry.id !== project.id) } });

  // 4. Every checkout whose `flow` pointed at the old folder.
  const relinked: MoveProjectResult['relinked'] = [];
  const untouched: MoveProjectResult['untouched'] = [];
  const failed: MoveProjectResult['failed'] = [];
  for (const [id, checkout] of Object.entries(local)) {
    const flow = join(checkout, 'flow');
    const stored = isSymlink(flow) ? readSymlinkTarget(flow) : null;
    const pointsHere = stored !== null && fromCandidates.has(resolve(dirname(flow), stored));
    if (!pointsHere) {
      if (id !== project.id) continue;
      if (!existsSync(checkout)) untouched.push({ project: id, checkout, reason: 'no-checkout' });
      else untouched.push({ project: id, checkout, reason: isSymlink(flow) ? 'points-elsewhere' : 'not-a-link' });
      continue;
    }
    try {
      createSymlink(to, flow);
      relinked.push({ project: id, checkout, link: to });
    } catch (error) {
      failed.push({ project: id, checkout, detail: errorText(error) });
    }
  }
  try {
    writeBrainIndex(to);
  } catch {
    // A missing index is rebuilt on the next capture; moving never fails on it.
  }

  const updatedTarget = readWorkspace(flowFolder, target.slug);
  const updatedSource = readWorkspace(flowFolder, sourceWorkspace.slug);
  return {
    action: 'move-project',
    project: viewOf(flowFolder, updatedTarget, moved, local),
    from: summaryOf(updatedSource, deps.git),
    to: summaryOf(updatedTarget, deps.git),
    movedFrom: from,
    movedTo: to,
    relinked,
    untouched,
    failed,
  };
}

// ─── delete ─────────────────────────────────────────────────────────────────

export interface DeleteOptions extends WorkspaceContext {
  workspace: string;
  /** A person asked for it (forbidden-pattern #15) — without it, the refusal lists what would move. */
  confirm?: boolean;
}

export interface DeleteResult {
  action: 'delete';
  /** The Workspace as it was. */
  workspace: WorkspaceSummary;
  /** The Default its projects moved to. */
  into: WorkspaceSummary;
  /** True when the Default was created by this call. */
  intoCreated: boolean;
  movedProjects: ProjectView[];
  /** The deleted Workspace's folder, renamed — nothing in it is removed. */
  /** Projects the Default already had: its copy stayed and gained what only this one had. */
  merged: { id: string; name: string; carried: number }[];
  keptAt: string;
  /** The shared repository is never touched: teammates still have the Workspace. */
  remoteUntouched: true;
  detail: string;
}

/**
 * Delete a Workspace: every project moves to the Default (as `move-project`),
 * then the folder is renamed to `workspaces/.deleted-<slug>-<date>/`. The
 * Default itself is never deleted.
 */
export function deleteWorkspace(options: DeleteOptions): DeleteResult {
  const { flowFolder, deps } = contextOf(options);
  const scan = scanWorkspaces(flowFolder);
  const workspace = pickWorkspace(scan, options.workspace, NO_HINTS);
  const defaultPlan = planDefaultWorkspace(flowFolder);
  const intoSlug = defaultPlan.kind === 'create' ? null : defaultPlan.workspace.slug;
  if (intoSlug === workspace.slug) {
    throw new WorkspaceRefusal('default-workspace', `${workspace.file.name} is the Default Workspace — make another Workspace the Default first`, {
      workspace: workspace.slug,
    });
  }
  const into =
    defaultPlan.kind === 'create'
      ? { name: defaultPlan.name, slug: defaultPlan.slug, create: true }
      : { name: defaultPlan.workspace.file.name, slug: defaultPlan.workspace.slug, create: false };
  const projects = workspace.file.projects.map((project) => ({ id: project.id, name: project.name, slug: project.slug }));
  if (options.confirm !== true) {
    throw new WorkspaceRefusal(
      'unconfirmed',
      `deleting ${workspace.file.name} moves its ${projects.length} project${projects.length === 1 ? '' : 's'} into ${into.name} and keeps its folder as a backup — that needs your go-ahead`,
      { workspace: { name: workspace.file.name, slug: workspace.slug, remote: workspace.file.remote ?? null }, projects, into, remoteUntouched: true, needs: 'confirm' }
    );
  }
  // A project the Default already lists is not refused any more (user report
  // 2026-11-24: "That Workspace already has this project" with no way out).
  // The Default's copy stays, gains what only this copy had, and the
  // project's checkout is pointed at it; this copy is kept in the backup.
  const alsoInDefault = new Set(
    defaultPlan.kind === 'create'
      ? []
      : workspace.file.projects.filter((project) => defaultPlan.workspace.file.projects.some((entry) => entry.id === project.id)).map((project) => project.id)
  );
  if (defaultPlan.kind !== 'create') {
    refuseIfBusy([workspace, defaultPlan.workspace]);
  } else {
    refuseIfBusy([workspace]);
  }

  const before = summaryOf(workspace, deps.git);
  const ensured = ensureDefaultWorkspace(flowFolder, deps);
  const local = readLocalProjects(flowFolder);
  const movedProjects: ProjectView[] = [];
  const merged: { id: string; name: string; carried: number }[] = [];
  let current = workspace;
  let target = ensured.workspace;
  for (const project of workspace.file.projects) {
    if (alsoInDefault.has(project.id)) {
      const kept = target.file.projects.find((entry) => entry.id === project.id) as WorkspaceProject;
      const from = projectFolder(flowFolder, workspace.slug, project.slug);
      const to = projectFolder(flowFolder, target.slug, kept.slug);
      mkdirSync(to, { recursive: true });
      const carried = carryKnowledge(from, to);
      scaffoldProjectFolder(to);
      const checkout = local[project.id];
      if (checkout !== undefined) {
        const flow = join(checkout, 'flow');
        const linked = workspaceLinkOf(flowFolder, flow);
        if (linked !== null && linked.workspace === workspace.slug && linked.project === project.slug) createSymlink(to, flow);
      }
      merged.push({ id: project.id, name: project.name, carried });
      continue;
    }
    const result = executeMove(flowFolder, deps, current, project, target, local);
    movedProjects.push(result.project);
    current = readWorkspace(flowFolder, workspace.slug);
    target = readWorkspace(flowFolder, target.slug);
  }

  const root = workspacesDir(flowFolder);
  const taken = new Set(readdirSync(root));
  const base = `${DELETED_WORKSPACE_PREFIX}${workspace.slug}-${stamp(deps.now())}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  const keptAt = join(root, name);
  renameSync(workspace.path, keptAt);

  return {
    action: 'delete',
    workspace: before,
    into: summaryOf(readWorkspace(flowFolder, target.slug), deps.git),
    intoCreated: ensured.created,
    movedProjects,
    merged,
    keptAt,
    remoteUntouched: true,
    detail:
      before.remote === null
        ? 'The Workspace folder is kept as a backup.'
        : 'The Workspace folder is kept as a backup. Its shared repository was not touched — teammates still have it.',
  };
}

// ─── Remove a project from a Workspace ──────────────────────────────────────

/**
 * Bring what one copy of a project's knowledge has and another lacks into the
 * other (user, 2026-11-24: the same project listed in two Workspaces, and no
 * way to clear it). Only files `into` does not have are copied; an
 * append-only log (`.jsonl`) gains the lines it lacks. Nothing `into` already
 * has is overwritten — the copy that stays keeps its own versions, and the
 * other copy is kept whole as a backup by the caller. Returns how many files
 * changed in `into`.
 */
export function carryKnowledge(from: string, into: string): number {
  if (!existsSync(from) || !existsSync(into)) return 0;
  let carried = 0;
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(from, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = rel === '' ? entry.name : join(rel, entry.name);
      const source = join(from, path);
      const target = join(into, path);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
        carried += 1;
        continue;
      }
      if (!path.endsWith('.jsonl')) continue;
      const have = readFileSync(target, 'utf-8');
      const known = new Set(have.split('\n'));
      const extra = readFileSync(source, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !known.has(line));
      if (extra.length === 0) continue;
      appendFileSync(target, `${have === '' || have.endsWith('\n') ? '' : '\n'}${extra.join('\n')}\n`);
      carried += 1;
    }
  };
  walk('');
  return carried;
}

/** A free backup path under `workspaces/` for one project folder. */
function removedBackupPath(flowFolder: string, workspaceSlug: string, projectSlug: string, now: Date): string {
  const root = workspacesDir(flowFolder);
  const taken = new Set(existsSync(root) ? readdirSync(root) : []);
  const base = `${REMOVED_PROJECT_PREFIX}${workspaceSlug}-${projectSlug}-${stamp(now)}`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return join(root, name);
}

export interface RemoveProjectOptions extends WorkspaceContext {
  /** The Workspace it leaves (slug or name). */
  workspace: string;
  /** The project, by slug or id. */
  project: string;
  /** A person asked for it (forbidden-pattern #15). */
  confirm?: boolean;
}

export interface RemoveProjectResult {
  action: 'remove-project';
  workspace: WorkspaceSummary;
  project: { id: string; name: string; slug: string };
  /** Where the removed copy is kept. */
  keptAt: string;
  /** The Workspace that still has the project on this machine, or null. */
  keptIn: WorkspaceSummary | null;
  /** Files the remaining copy gained from the removed one. */
  carried: number;
  /** The folder the project's checkout now uses, when its link moved. */
  relinked: string | null;
  detail: string;
}

/**
 * Take a project out of one Workspace. When another Workspace here also has
 * it, that copy stays: it gains what only the removed copy had, and the
 * project's checkout is pointed at it. The removed copy is kept whole under
 * `workspaces/.removed-…`, so nothing is lost. In a shared Workspace the
 * removal is an ordinary change its next sync publishes — for everyone, which
 * the refusal that asks says.
 *
 * The one thing it refuses: the only copy here, used by the project's
 * checkout. Removing it would leave the checkout's knowledge nowhere; moving it
 * to another Workspace is the way.
 */
export function removeProject(options: RemoveProjectOptions): RemoveProjectResult {
  const { flowFolder, deps } = contextOf(options);
  const scan = scanWorkspaces(flowFolder);
  const workspace = pickWorkspace(scan, options.workspace, NO_HINTS);
  const project = findProject(workspace, options.project);
  if (project === undefined) {
    throw new WorkspaceRefusal('unknown-project', `the ${workspace.file.name} Workspace has no project ${options.project}`, {
      workspace: workspace.slug,
      projects: workspace.file.projects.map((entry) => ({ id: entry.id, name: entry.name, slug: entry.slug })),
    });
  }
  const local = readLocalProjects(flowFolder);
  const checkout = local[project.id];
  const flow = checkout === undefined ? null : join(checkout, 'flow');
  const linked = flow === null ? null : workspaceLinkOf(flowFolder, flow);
  const usesThis = linked !== null && linked.workspace === workspace.slug && linked.project === project.slug;
  const others = scan.workspaces.filter((entry) => entry.slug !== workspace.slug && entry.file.projects.some((p) => p.id === project.id));
  const keeper = others.find((entry) => linked !== null && entry.slug === linked.workspace) ?? others[0] ?? null;
  const summary = summaryOf(workspace, deps.git);
  const named = { id: project.id, name: project.name, slug: project.slug };
  if (keeper === null && usesThis) {
    throw new WorkspaceRefusal(
      'sole-copy',
      `${project.name}'s knowledge lives only in ${workspace.file.name} on this machine, and its checkout uses it — move it to another Workspace instead`,
      { workspace: summary, project: named }
    );
  }
  if (options.confirm !== true) {
    throw new WorkspaceRefusal(
      'unconfirmed',
      `removing ${project.name} from ${workspace.file.name} keeps its folder as a backup — that needs your go-ahead`,
      {
        workspace: summary,
        project: named,
        keptIn: keeper === null ? null : { name: keeper.file.name, slug: keeper.slug },
        shared: summary.remote !== null,
        needs: 'confirm',
      }
    );
  }
  refuseIfBusy(keeper === null ? [workspace] : [workspace, keeper]);

  const from = projectFolder(flowFolder, workspace.slug, project.slug);
  let carried = 0;
  let relinked: string | null = null;
  if (keeper !== null) {
    const kept = keeper.file.projects.find((entry) => entry.id === project.id) as WorkspaceProject;
    const to = projectFolder(flowFolder, keeper.slug, kept.slug);
    mkdirSync(to, { recursive: true });
    carried = carryKnowledge(from, to);
    scaffoldProjectFolder(to);
    if (usesThis && flow !== null) {
      createSymlink(to, flow);
      relinked = to;
    }
    try {
      writeBrainIndex(to);
    } catch {
      // Rebuilt on the next capture; removing never fails on it.
    }
  }
  const keptAt = removedBackupPath(flowFolder, workspace.slug, project.slug, deps.now());
  if (existsSync(from)) moveFolder(from, keptAt);
  writeWorkspace({ ...workspace, file: { ...workspace.file, projects: workspace.file.projects.filter((entry) => entry.id !== project.id) } });

  const keptSummary = keeper === null ? null : summaryOf(readWorkspace(flowFolder, keeper.slug), deps.git);
  return {
    action: 'remove-project',
    workspace: summaryOf(readWorkspace(flowFolder, workspace.slug), deps.git),
    project: named,
    keptAt,
    keptIn: keptSummary,
    carried,
    relinked,
    detail:
      keptSummary === null
        ? 'Its knowledge folder is kept as a backup.'
        : `${keptSummary.name} keeps the project, with anything only the removed copy had. The removed copy is kept as a backup.`,
  };
}

// ─── Join, and hand over the projects this machine already had ──────────────

/**
 * Join a Workspace, then settle the projects it lists that this machine keeps
 * in a LOCAL-ONLY Workspace of its own (user report 2026-11-24: after joining,
 * the same projects sat in the team's Workspace and in "My Mac", and every
 * later move or delete refused). The team's copy stays; it gains what only the
 * local copy had, the checkout is pointed at it, and the local copy is kept as
 * a backup (`removeProject`). A project held by another SHARED Workspace is
 * left for a person: that is someone else's team.
 */
export function joinAndSettle(options: JoinOptions): JoinResult {
  const result = joinWorkspace(options);
  const { flowFolder, deps } = contextOf(options);
  const stillToReview: JoinResult['needsReview'] = [];
  for (const entry of result.needsReview) {
    const linkedTo = entry.refusal['linkedTo'] as { workspace?: unknown } | undefined;
    const holderSlug = entry.refusal['refused'] === 'linked-elsewhere' && typeof linkedTo?.workspace === 'string' ? linkedTo.workspace : null;
    const holder = holderSlug === null ? null : scanWorkspaces(flowFolder).workspaces.find((w) => w.slug === holderSlug) ?? null;
    if (holder === null || holder.slug === result.workspace.slug || summaryOf(holder, deps.git).remote !== null) {
      stillToReview.push(entry);
      continue;
    }
    try {
      removeProject({ flowFolder, deps, workspace: holder.slug, project: entry.id, confirm: true });
      const joined = readWorkspace(flowFolder, result.workspace.slug);
      const project = joined.file.projects.find((p) => p.id === entry.id);
      result.linked.push(project === undefined ? entry : viewOf(flowFolder, joined, project, readLocalProjects(flowFolder)));
    } catch (error) {
      if (!(error instanceof WorkspaceRefusal)) throw error;
      stillToReview.push(entry);
    }
  }
  result.needsReview = stillToReview;
  return result;
}
