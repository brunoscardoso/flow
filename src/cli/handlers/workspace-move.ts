/**
 * `workspace move-flow-folder --to <dir>` — move what the Flow folder holds for
 * Workspaces to another folder, and re-point every checkout's `flow` link.
 *
 * WHAT MOVES: the Workspace part of the Flow folder — `workspaces/`,
 * `settings/` and `projects.local.json`. The vault (`brain/`) and anything else
 * in the folder STAY where they are: the vault is resolved on its own
 * (`getVaultDir`, `PLAN_FLOW_VAULT_DIR`), and every vault-linked project's
 * `flow` points into it — links this verb has no list of, so moving the vault
 * would break them silently.
 *
 * WHAT IT CANNOT DO: make future runs look there. The Flow folder is resolved
 * from the environment (`PLAN_FLOW_HOME`, utils/files.ts), so the caller has to
 * persist the new location and hand it to every later CLI run and agent
 * session. The result says so (`needs`). NOTHING persists it today — the Flow
 * app does not follow a moved Flow folder yet — so a run without the env
 * would silently find no Workspaces. The verb therefore REFUSES
 * (`move-not-persisted`) unless the caller says `--confirm`, i.e. "I will set
 * PLAN_FLOW_HOME myself"; the refusal carries the env it needs.
 *
 * Every refusal is decided before anything moves (allowed-pattern #24's other
 * half): the target is absent or an empty folder, neither folder is inside the
 * other, there is something to move, and no Workspace is being synced. Both
 * folders are REQUIRED inputs — there is no default for either
 * (forbidden-pattern #15).
 *
 * Links: for each project in `projects.local.json`, a `<checkout>/flow` that is
 * a link into the old `workspaces/` is replaced by one to the same project
 * under the new location. A checkout whose `flow` is anything else — gone, a
 * real folder, a link somewhere else — is left exactly as it is and reported.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createSymlink, isSymlink, readSymlinkTarget } from '../utils/files.js';
import { staleLock, SYNC_LOCK_GIT_PATH } from './workspace-sync.js';
import {
  PROJECTS_LOCAL_FILENAME,
  SETTINGS_DIRNAME,
  WORKSPACES_DIRNAME,
  WorkspaceRefusal,
  readLocalProjects,
  realOrResolved,
} from './workspace-model.js';

/** What belongs to Workspaces in a Flow folder — the entries that move, in this order. */
export const MOVABLE_ENTRIES = [WORKSPACES_DIRNAME, SETTINGS_DIRNAME, PROJECTS_LOCAL_FILENAME] as const;

export interface MoveFlowFolderOptions {
  /** REQUIRED — the Flow folder the entries move FROM. */
  flowFolder: string;
  /** REQUIRED — where they move to. Absent, or an empty folder. */
  to: string;
  /** The caller will persist `PLAN_FLOW_HOME` itself — required, see the header. */
  confirm?: boolean;
  now?: () => Date;
}

export interface MoveFlowFolderResult {
  action: 'move-flow-folder';
  from: string;
  to: string;
  /** Entries moved, in order. */
  moved: string[];
  /** Entries of the old folder that stay there (the vault among them). */
  left: string[];
  relinked: { project: string; checkout: string; link: string }[];
  untouched: { project: string; checkout: string; reason: 'no-checkout' | 'no-link' | 'not-a-link' | 'points-elsewhere' }[];
  failed: { project: string; checkout: string; detail: string }[];
  /** What the caller must keep for every later run — the CLI cannot persist it. */
  needs: { env: 'PLAN_FLOW_HOME'; value: string };
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sameOrInside(a: string, b: string): boolean {
  return a === b || isInside(a, b);
}

/**
 * The real path of a folder that may not exist yet: the real path of its
 * deepest existing ancestor, plus the rest. `realOrResolved` alone would leave
 * a symlinked ANCESTOR unresolved, so `<link to the Flow folder>/new` would
 * not look like it is inside the Flow folder.
 */
function realPathOfFuture(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    if (existsSync(current)) return rest.length === 0 ? realOrResolved(current) : join(realOrResolved(current), ...rest.reverse());
    const parent = dirname(current);
    if (parent === current) return absolute;
    rest.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

/** A Workspace with a sync running right now (a lock that is still held). */
function busyWorkspaces(workspacesRoot: string, now: Date): string[] {
  if (!existsSync(workspacesRoot)) return [];
  const busy: string[] = [];
  for (const entry of readdirSync(workspacesRoot)) {
    const lock = join(workspacesRoot, entry, '.git', SYNC_LOCK_GIT_PATH);
    if (existsSync(lock) && staleLock(lock, now) === null) busy.push(entry);
  }
  return busy.sort();
}

/** Where `<checkout>/flow` should point after the move, or why it is left alone. */
function planLink(
  checkout: string,
  fromWorkspaces: readonly string[],
  toWorkspaces: string
): { kind: 'relink'; target: string } | { kind: 'leave'; reason: 'no-checkout' | 'no-link' | 'not-a-link' | 'points-elsewhere' } {
  if (!existsSync(checkout)) return { kind: 'leave', reason: 'no-checkout' };
  const flow = join(checkout, 'flow');
  try {
    lstatSync(flow);
  } catch {
    return { kind: 'leave', reason: 'no-link' };
  }
  if (!isSymlink(flow)) return { kind: 'leave', reason: 'not-a-link' };
  const stored = readSymlinkTarget(flow);
  if (stored === null) return { kind: 'leave', reason: 'points-elsewhere' };
  const target = resolve(dirname(flow), stored);
  for (const candidate of [target, realOrResolved(target)]) {
    for (const base of fromWorkspaces) {
      if (isInside(candidate, base)) return { kind: 'relink', target: join(toWorkspaces, relative(base, candidate)) };
    }
  }
  return { kind: 'leave', reason: 'points-elsewhere' };
}

/** rename, or — across file systems — copy then remove the original. */
function moveEntry(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

export function moveFlowFolder(options: MoveFlowFolderOptions): MoveFlowFolderResult {
  const from = resolve(options.flowFolder);
  const to = resolve(options.to);
  const now = options.now ?? (() => new Date());
  const realFrom = realOrResolved(from);
  const realTo = realPathOfFuture(to);

  // ── Every refusal before anything moves ──
  if (realFrom === realTo) {
    throw new WorkspaceRefusal('same-folder', 'that is already where the Flow folder is', { from, to });
  }
  if (sameOrInside(realTo, realFrom) || sameOrInside(realFrom, realTo)) {
    throw new WorkspaceRefusal('target-inside', "the Flow folder can't move into itself, or into a folder that holds it", { from, to });
  }
  if (existsSync(to)) {
    if (!statSync(to).isDirectory() || readdirSync(to).length > 0) {
      throw new WorkspaceRefusal('target-not-empty', 'the folder to move to already has something in it — pick an empty or new folder', { from, to });
    }
  }
  const present = MOVABLE_ENTRIES.filter((entry) => existsSync(join(from, entry)));
  if (present.length === 0) {
    throw new WorkspaceRefusal('nothing-to-move', 'there are no Workspaces in this Flow folder to move', { from, to });
  }
  if (options.confirm !== true) {
    throw new WorkspaceRefusal(
      'move-not-persisted',
      `nothing remembers a moved Flow folder yet — the Flow app does not follow one, and every later run needs PLAN_FLOW_HOME=${to} — so moving needs your explicit go-ahead`,
      { from, to, flag: 'confirm', needs: { env: 'PLAN_FLOW_HOME', value: to } },
    );
  }
  const busy = busyWorkspaces(join(from, WORKSPACES_DIRNAME), now());
  if (busy.length > 0) {
    throw new WorkspaceRefusal('sync-busy', 'a Workspace is being synced right now — try again once it has finished', { workspaces: busy });
  }
  // Read (and validate) the checkout list BEFORE moving it.
  const local = readLocalProjects(from);

  const fromWorkspaces = [...new Set([join(from, WORKSPACES_DIRNAME), join(realFrom, WORKSPACES_DIRNAME)])];
  const toWorkspaces = join(to, WORKSPACES_DIRNAME);
  const plans = Object.entries(local).map(([project, checkout]) => ({ project, checkout, plan: planLink(checkout, fromWorkspaces, toWorkspaces) }));

  // ── Move, putting back what moved if one entry fails ──
  mkdirSync(to, { recursive: true });
  const moved: string[] = [];
  for (const entry of present) {
    try {
      moveEntry(join(from, entry), join(to, entry));
      moved.push(entry);
    } catch (error) {
      const restored: string[] = [];
      for (const done of [...moved].reverse()) {
        try {
          moveEntry(join(to, done), join(from, done));
          restored.push(done);
        } catch {
          // reported below: what is not restored stays in the new folder
        }
      }
      throw new WorkspaceRefusal('failed', `the Flow folder could not be moved, so what had moved was put back: ${errorText(error)}`, {
        from,
        to,
        restored,
        notRestored: moved.filter((done) => !restored.includes(done)),
      });
    }
  }

  // ── Re-point the links ──
  const relinked: MoveFlowFolderResult['relinked'] = [];
  const untouched: MoveFlowFolderResult['untouched'] = [];
  const failed: MoveFlowFolderResult['failed'] = [];
  for (const { project, checkout, plan } of plans) {
    if (plan.kind === 'leave') {
      untouched.push({ project, checkout, reason: plan.reason });
      continue;
    }
    try {
      createSymlink(plan.target, join(checkout, 'flow'));
      relinked.push({ project, checkout, link: plan.target });
    } catch (error) {
      failed.push({ project, checkout, detail: errorText(error) });
    }
  }

  const left = existsSync(from) ? readdirSync(from).sort() : [];
  return {
    action: 'move-flow-folder',
    from,
    to,
    moved,
    left,
    relinked,
    untouched,
    failed,
    needs: { env: 'PLAN_FLOW_HOME', value: to },
  };
}
