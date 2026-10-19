/**
 * `workspace migrate --roots <json> [--name <n>] [--workspace <w>] [--dry-run]`
 * — the hard migration (decision 2026-10-06, workspaces-hard-migration): every
 * registered project goes into a Workspace, its existing knowledge copied in.
 *
 * THE WORKSPACE: `--workspace` when given (an unknown one is refused);
 * otherwise this machine's Default (`settings/workspaces.local.json`); with no
 * Default recorded, a Workspace whose folder is the Default's slug is adopted,
 * and failing that the Default is created (`--name`, default "Default") and
 * recorded. Other Workspaces on the machine never make this ask which one.
 *
 * EACH ROOT, independently — one failure never stops the others:
 *   - not a git repository's top (or missing)  → `failed`
 *   - `flow` already links into a Workspace     → `unchanged` (wherever it links)
 *   - a `flow/` COMMITTED in the code repo      → `pending`: renaming it needs a
 *     code-repo commit, which is never made silently; the payload carries the
 *     commit for the app to confirm with `link --confirm-commit --import`
 *   - anything else                             → linked with `--import`
 *     (`migrated`), the old `flow` kept as the backup `linkRepo` describes.
 * Roots are deduplicated by real path (the first spelling wins).
 *
 * `--dry-run` writes NOTHING — no Workspace, no record, no copy — and reports
 * what would happen root by root (`plan`), from the same `prepareLink` the real
 * run uses. Exit 0 with failures in the payload; the only refusals are about
 * the roots list and the Workspace choice.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { isSymlink } from '../utils/files.js';
import { locateWorkspaceProject } from './workspace-locate.js';
import { DEFAULT_WORKSPACE_NAME, ensureDefaultWorkspace, planDefaultWorkspace } from './workspace-admin.js';
import type { ImportReport } from './workspace-import.js';
import {
  NO_HINTS,
  WorkspaceRefusal,
  contextOf,
  errorText,
  isRepoRoot,
  linkRepo,
  pickWorkspace,
  prepareLink,
  readWorkspace,
  realOrResolved,
  scanWorkspaces,
  workspaceLinkOf,
  type LoadedWorkspace,
  type PreviousFlow,
  type ProjectView,
  type WorkspaceContext,
  type WorkspaceDeps,
} from './workspace-model.js';

export interface MigrateOptions extends WorkspaceContext {
  /** Absolute paths of the code repositories to migrate. */
  roots: readonly string[];
  /** The name of the Default Workspace when one has to be created. */
  name?: string;
  /** Migrate into this Workspace (slug or name) instead of the Default. */
  workspace?: string;
  /** Report what would happen; write nothing. */
  dryRun?: boolean;
}

export interface MigratedRoot {
  root: string;
  project: ProjectView;
  previous: PreviousFlow;
  imported: ImportReport;
}

export interface PendingRoot {
  root: string;
  reason: 'committed-folder';
  /** The code-repo commit renaming the folder takes — confirm with `link --confirm-commit --import`. */
  commit: { message: string; files: number; from: string; to: string };
}

export interface FailedRoot {
  root: string;
  /** A WorkspaceRefusal reason (`not-a-git-repo`, `malformed-local-map`, …) or `failed`. */
  reason: string;
  detail: string;
}

export type PlannedRoot =
  | {
      root: string;
      would: 'link';
      project: { id: string; name: string; slug: string };
      /** What happens to `<repo>/flow`: absent | link | untracked | knowledge-repo. */
      previous: string;
      /** Files the import would copy. */
      files: number;
      renamed: { from: string; to: string }[];
      skipped: string[];
    }
  | { root: string; would: 'unchanged' }
  | { root: string; would: 'pending'; reason: 'committed-folder'; commit: PendingRoot['commit'] }
  | { root: string; would: 'fail'; reason: string; detail: string };

export interface MigrateResult {
  action: 'migrate';
  dryRun: boolean;
  /** Dry run only: whether the Workspace would be created or is used as it is. */
  would?: 'create-workspace' | 'use-workspace';
  workspace: { name: string; slug: string; path: string; created: boolean };
  migrated: MigratedRoot[];
  unchanged: string[];
  pending: PendingRoot[];
  failed: FailedRoot[];
  /** Dry run only: one entry per root, in order. */
  plan?: PlannedRoot[];
}

function validRoots(roots: readonly unknown[]): string[] {
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === 'string' && root.trim() !== '' && isAbsolute(root))) {
    throw new WorkspaceRefusal('invalid-roots', 'the roots must be a JSON array of absolute paths to code repositories', {
      example: ['/Users/me/code/app'],
    });
  }
  return roots as string[];
}

/** Whether `<repo>/flow` already links into a Workspace project folder — this Flow folder's or any other's. */
function alreadyInWorkspace(flowFolder: string, repo: string): boolean {
  const flow = join(repo, 'flow');
  if (!isSymlink(flow)) return false;
  return workspaceLinkOf(flowFolder, flow) !== null || locateWorkspaceProject(flow) !== null;
}

function pendingOf(root: string, refusal: WorkspaceRefusal): PendingRoot {
  const commit = refusal.payload.commit as PendingRoot['commit'];
  return { root, reason: 'committed-folder', commit: { message: commit.message, files: commit.files, from: commit.from, to: commit.to } };
}

/** The Workspace this run migrates into — read or decided, created only when writing. */
function chooseWorkspace(
  flowFolder: string,
  deps: WorkspaceDeps,
  options: MigrateOptions
): { workspace: LoadedWorkspace; created: boolean; exists: boolean } {
  const dryRun = options.dryRun === true;
  if (options.workspace !== undefined) {
    return { workspace: pickWorkspace(scanWorkspaces(flowFolder), options.workspace, NO_HINTS), created: false, exists: true };
  }
  const name = options.name?.trim() || DEFAULT_WORKSPACE_NAME;
  if (!dryRun) {
    const ensured = ensureDefaultWorkspace(flowFolder, deps, name);
    return { workspace: ensured.workspace, created: ensured.created, exists: true };
  }
  const plan = planDefaultWorkspace(flowFolder, name);
  if (plan.kind !== 'create') return { workspace: plan.workspace, created: false, exists: true };
  return {
    workspace: { slug: plan.slug, path: plan.path, raw: {}, file: { name: plan.name, slug: plan.slug, projects: [] } },
    created: false,
    exists: false,
  };
}

export function migrateWorkspaces(options: MigrateOptions): MigrateResult {
  const { flowFolder, deps } = contextOf(options);
  const roots = validRoots(options.roots);
  const dryRun = options.dryRun === true;
  const chosen = chooseWorkspace(flowFolder, deps, options);
  const result: MigrateResult = {
    action: 'migrate',
    dryRun,
    ...(dryRun ? { would: chosen.exists ? ('use-workspace' as const) : ('create-workspace' as const) } : {}),
    workspace: { name: chosen.workspace.file.name, slug: chosen.workspace.slug, path: chosen.workspace.path, created: chosen.created },
    migrated: [],
    unchanged: [],
    pending: [],
    failed: [],
    ...(dryRun ? { plan: [] as PlannedRoot[] } : {}),
  };
  // The dry run plans every root against one in-memory copy of the Workspace,
  // so two roots that would both add a project `app` get `app` and `app-2`.
  let preview: LoadedWorkspace = {
    ...chosen.workspace,
    file: { ...chosen.workspace.file, projects: [...chosen.workspace.file.projects] },
  };

  const seen = new Set<string>();
  for (const root of roots) {
    const real = realOrResolved(root);
    if (seen.has(real)) continue;
    seen.add(real);

    if (!existsSync(real) || !isRepoRoot(real, deps.git)) {
      const failure = { root, reason: 'not-a-git-repo', detail: 'that folder is not the top of a git repository' };
      result.failed.push(failure);
      result.plan?.push({ ...failure, would: 'fail' });
      continue;
    }
    if (alreadyInWorkspace(flowFolder, real)) {
      result.unchanged.push(root);
      result.plan?.push({ root, would: 'unchanged' });
      continue;
    }

    try {
      if (dryRun) {
        const prepared = prepareLink(
          { flowFolder, deps, target: real, workspace: chosen.workspace.slug, import: true },
          { workspace: preview }
        );
        if (prepared.added) {
          preview = { ...preview, file: { ...preview.file, projects: [...preview.file.projects, prepared.project] } };
        }
        const importPlan = prepared.importPlan;
        result.plan?.push({
          root,
          would: 'link',
          project: { id: prepared.project.id, name: prepared.project.name, slug: prepared.project.slug },
          previous: prepared.plan.kind,
          files: importPlan?.copies.length ?? 0,
          renamed: importPlan?.renamed ?? [],
          skipped: importPlan?.skipped ?? [],
        });
        continue;
      }
      const linked = linkRepo({ flowFolder, deps, target: real, workspace: chosen.workspace.slug, import: true });
      result.migrated.push({
        root,
        project: linked.project,
        previous: linked.previous,
        imported: linked.imported ?? { files: 0, skipped: [], renamed: [] },
      });
    } catch (error) {
      if (error instanceof WorkspaceRefusal && error.reason === 'committed-flow') {
        const pending = pendingOf(root, error);
        result.pending.push(pending);
        result.plan?.push({ root, would: 'pending', reason: pending.reason, commit: pending.commit });
        continue;
      }
      const failure =
        error instanceof WorkspaceRefusal
          ? { root, reason: error.reason as string, detail: error.sentence }
          : { root, reason: 'failed', detail: errorText(error) };
      result.failed.push(failure);
      result.plan?.push({ ...failure, would: 'fail' });
    }
  }

  if (!dryRun) {
    const updated = readWorkspace(flowFolder, chosen.workspace.slug);
    result.workspace.name = updated.file.name;
  }
  return result;
}
