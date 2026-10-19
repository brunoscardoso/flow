/**
 * WHICH WORKSPACE PROJECT IS THIS `flow/`? — the cheap, structural answer the
 * knowledge WRITERS ask (feature store, decision writer, rounds archiver).
 *
 * `workspace status --target <repo>` (workspace-model.ts) is the full answer: it
 * scans the Flow folder, reads `projects.local.json` and asks git for the
 * remote. A writer holding a `flow/` dir needs much less — "does this folder
 * live at `<w>/projects/<p>/` of a Workspace, and what is `<p>`?" — and must
 * stay cheap (it runs on every feature write) and import-light (the feature
 * store is loaded by every blueprint verb; workspace-model pulls in the
 * provisioning graph). So this module reads the one fact on disk that decides
 * it: the real path of `flow/` and the `workspace.json` two levels up.
 *
 * Outside a Workspace it answers `null`, and every caller then behaves exactly
 * as before Workspaces existed (FR-5).
 *
 * The two names below restate workspace-model's `WORKSPACE_FILENAME` /
 * `WORKSPACE_PROJECTS_DIRNAME` rather than import them (import cost, and
 * workspace-model ↔ shared already form a cycle); a test pins them equal.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const LOCATE_WORKSPACE_FILENAME = 'workspace.json';
export const LOCATE_PROJECTS_DIRNAME = 'projects';

export interface WorkspaceProjectLocation {
  /** The Workspace repository root (`<Flow folder>/workspaces/<w>`). */
  workspacePath: string;
  /** The Workspace's slug as recorded in its `workspace.json`. */
  workspace: string;
  /** The project's folder name — the namespace of its knowledge (`<project>/<feature>`). */
  project: string;
  /** The project's id (remote identity) as recorded, or null when unlisted. */
  projectId: string | null;
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The Workspace project a `flow/` directory (or any project folder) belongs
 * to, or `null`. Never throws: an unreadable `workspace.json` is "not a
 * Workspace", because a writer must never fail on account of Workspaces.
 *
 * A folder counts only when its Workspace's file LISTS it — a stray folder
 * under `projects/` is not a project, and namespacing its knowledge on a guess
 * would mint ids nobody can resolve.
 */
export function locateWorkspaceProject(flowDir: string): WorkspaceProjectLocation | null {
  const real = realOrResolved(flowDir);
  const projectsDir = dirname(real);
  if (basename(projectsDir) !== LOCATE_PROJECTS_DIRNAME) return null;
  const workspacePath = dirname(projectsDir);
  const filePath = join(workspacePath, LOCATE_WORKSPACE_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const file = parsed as { slug?: unknown; projects?: unknown };
    if (!Array.isArray(file.projects)) return null;
    const project = basename(real);
    const listed = file.projects.find(
      (entry): entry is { slug: string; id?: unknown } =>
        typeof entry === 'object' && entry !== null && (entry as { slug?: unknown }).slug === project
    );
    if (listed === undefined) return null;
    return {
      workspacePath,
      workspace: typeof file.slug === 'string' ? file.slug : basename(workspacePath),
      project,
      projectId: typeof listed.id === 'string' ? listed.id : null,
    };
  } catch {
    return null;
  }
}
