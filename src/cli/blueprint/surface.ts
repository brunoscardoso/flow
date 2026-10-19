/**
 * Cross-project surface (federation layer, Phase 1) — the distilled "what
 * this project EXPOSES" file every derive publishes for siblings to match
 * against.
 *
 * Written beside graph.json in `flow/brain/.structure/`. In a Workspace,
 * `flow/` links into the Workspace's project folder and the siblings are the
 * Workspace's other projects (FR-21, `readSiblingSurfaces`). Outside one — for vault-managed
 * projects `flow/` is a symlink into `~/plan-flow/brain/projects/<name>/flow`,
 * so publishing lands in the shared vault with no extra plumbing; the vault
 * IS the federation. `repoPath` rides inside the file (refreshed every
 * derive), so a sibling refresh can re-derive this project without any
 * separate registry.
 *
 * Derived/disposable tier: rebuilt in full on every derive, safe to delete.
 * Reader is per-field fail-soft — a corrupt sibling surface skips with a
 * note, never breaks a consumer's derive (NFR2).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import type { BlueprintGraph } from './types.js';
import { workspaceContextOf, type StatusTargetResult, type WorkspaceContext } from '../handlers/workspace-model.js';

export const SURFACE_FILENAME = 'surface.json';

export interface SurfaceEndpoint {
  method: string;
  path: string;
  pathGroup?: string;
}

export interface SurfaceGraphqlOperation {
  operation: 'query' | 'mutation';
  name: string;
}

export interface ProjectSurface {
  version: 1;
  project: string;
  repoPath: string;
  derivedAt: string;
  graphHash: string;
  endpoints: SurfaceEndpoint[];
  graphqlOperations: SurfaceGraphqlOperation[];
}

/** Distill a derived graph into its publishable surface. Pure/deterministic. */
export function buildSurface(graph: BlueprintGraph, repoPath: string): ProjectSurface {
  const endpoints: SurfaceEndpoint[] = [];
  const graphqlOperations: SurfaceGraphqlOperation[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'endpoint') {
      continue;
    }
    const operation = node.meta?.operation;
    if (operation === 'query' || operation === 'mutation') {
      graphqlOperations.push({ operation, name: String(node.meta?.route ?? node.label) });
      continue;
    }
    const method = typeof node.meta?.method === 'string' ? node.meta.method : node.label.split(' ')[0] ?? '*';
    const path = typeof node.meta?.route === 'string' ? node.meta.route : (node.label.split(' ')[1] ?? node.label);
    const pathGroup = typeof node.meta?.pathGroup === 'string' ? node.meta.pathGroup : undefined;
    endpoints.push({ method, path, ...(pathGroup !== undefined ? { pathGroup } : {}) });
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  graphqlOperations.sort((a, b) => a.name.localeCompare(b.name) || a.operation.localeCompare(b.operation));
  return {
    version: 1,
    project: basename(repoPath),
    repoPath,
    derivedAt: graph.derivedAt,
    graphHash: createHash('sha256').update(JSON.stringify({ n: graph.nodes, e: graph.edges })).digest('hex').slice(0, 16),
    endpoints,
    graphqlOperations,
  };
}

/** Write the surface beside graph.json (structure dir). Fail-soft: a write
 *  failure warns via the returned note, never throws out of derive. */
export function writeSurface(structureDir: string, surface: ProjectSurface): string | null {
  try {
    writeFileSync(join(structureDir, SURFACE_FILENAME), `${JSON.stringify(surface, null, 2)}\n`, 'utf-8');
    return null;
  } catch (error) {
    return `surface: publish failed (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Tolerant reader — null on missing/corrupt/foreign-version files. */
export function readSurface(path: string): ProjectSurface | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ProjectSurface;
    if (parsed?.version !== 1 || typeof parsed.project !== 'string' || !Array.isArray(parsed.endpoints)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Where a sibling list came from — a Workspace's projects, or the vault scan. */
export type SiblingSource = 'workspace' | 'vault';

export interface SiblingSurfacesOptions extends WorkspaceContext {
  /**
   * The Workspace answer for `selfRepoPath`, when the caller already has it.
   * `undefined` = look it up; `null` = the caller knows it is in no Workspace.
   */
  workspace?: StatusTargetResult | null;
}

/**
 * Every sibling surface, excluding the given project. Skipped siblings
 * (missing/corrupt surface) are reported, never silent (NFR2).
 *
 * SIBLINGS ARE THE WORKSPACE'S PROJECTS when `selfRepoPath` is a project of a
 * Workspace (FR-21) — read from each sibling's knowledge folder, so a project
 * with no checkout on this machine still contributes the surface its last
 * derive published. Outside a Workspace this is the vault scan it always was
 * (FR-5): every `<vault>/projects/<name>/flow`.
 */
export function readSiblingSurfaces(
  vaultDir: string,
  selfRepoPath: string,
  options: SiblingSurfacesOptions = {},
): { surfaces: ProjectSurface[]; skipped: string[]; source: SiblingSource } {
  const workspace = options.workspace !== undefined ? options.workspace : workspaceContextOf(selfRepoPath, options);
  if (workspace !== null && workspace.workspace !== null) {
    return { ...readWorkspaceSiblingSurfaces(workspace, selfRepoPath), source: 'workspace' };
  }
  return { ...readVaultSiblingSurfaces(vaultDir, selfRepoPath), source: 'vault' };
}

function readWorkspaceSiblingSurfaces(
  workspace: StatusTargetResult,
  selfRepoPath: string,
): { surfaces: ProjectSurface[]; skipped: string[] } {
  const surfaces: ProjectSurface[] = [];
  const skipped: string[] = [];
  for (const sibling of [...workspace.siblings].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const surface = readSurface(join(sibling.flowPath, 'brain', '.structure', SURFACE_FILENAME));
    if (surface === null) {
      skipped.push(`${sibling.slug} (no surface published — derive it once)`);
      continue;
    }
    if (surface.repoPath === selfRepoPath) {
      continue; // self, published under another name
    }
    surfaces.push(surface);
  }
  return { surfaces, skipped };
}

function readVaultSiblingSurfaces(
  vaultDir: string,
  selfRepoPath: string,
): { surfaces: ProjectSurface[]; skipped: string[] } {
  const projectsDir = join(vaultDir, 'projects');
  const surfaces: ProjectSurface[] = [];
  const skipped: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return { surfaces, skipped: ['(vault unavailable)'] };
  }
  for (const name of entries.sort()) {
    const surfacePath = join(projectsDir, name, 'flow', 'brain', '.structure', SURFACE_FILENAME);
    const surface = readSurface(surfacePath);
    if (surface === null) {
      if (existsSync(join(projectsDir, name, 'flow'))) {
        skipped.push(`${name} (no surface published — derive it once)`);
      }
      continue;
    }
    if (surface.repoPath === selfRepoPath) {
      continue; // self
    }
    surfaces.push(surface);
  }
  return { surfaces, skipped };
}
