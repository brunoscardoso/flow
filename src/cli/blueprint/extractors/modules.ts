/**
 * Module extractor — derives the FOLDER-STRUCTURE spine of the blueprint:
 *
 * 1. Hierarchical module nodes for the folder TREE (not just top level).
 *    Node id convention: `module:<repo-relative dir path>` (posix), e.g.
 *    `module:src/cli`, `module:src/cli/blueprint`,
 *    `module:src/cli/blueprint/extractors`. The label is the directory's
 *    basename; `sourceFile` is the directory path. Each node carries
 *    `meta.depth` (1 = the spine root itself), `meta.childDirs` (count of
 *    emitted child module nodes) and `meta.fileCount` (direct source files).
 *    Directories with zero source files in their whole subtree are skipped.
 * 2. Containment edges — `{ source: parent module id, target: child module
 *    id, relation: 'contains' }` — form the spine; per-branch rollups are
 *    derivable by walking `contains`, so attribution edges are NOT duplicated
 *    up the tree.
 * 3. Depth cap: directories deeper than `MODULE_TREE_DEPTH_CAP` roll up into
 *    their depth-cap ancestor — its `meta.fileCount` includes the rolled-up
 *    files and `meta.rolledUp: true` marks that this happened.
 * 4. Import edges: import/require statements with relative specifiers are
 *    resolved and attributed to the DEEPEST containing module on both sides —
 *    `{ source: module:<a>, target: module:<b>, relation: 'imports' }`.
 * 5. Attribution edges: nodes detected by the other extractors are attributed
 *    to the DEEPEST module whose directory contains their sourceFile —
 *    `exposes` for endpoints, `uses` for integrations and datastores.
 *
 * Legacy id bridge: module ids were previously basename-based
 * (`module:cli` for `src/cli`); they are now path-based (`module:src/cli`).
 * Anchor resolution (`anchors.ts` `resolveAnchor`, `module` kind) accepts the
 * old basename form via the node's label and the directory path via
 * `sourceFile`, so legacy anchors keep resolving.
 *
 * MULTI-ROOT SPINE: the folder tree is built per SPINE ROOT (see
 * `discoverSpineRoots` in `scan.ts`) — e.g. `src` and `app/src` in an npm
 * workspace. Every spine root is itself a depth-1 module node (`module:src`,
 * `module:app/src`); its child directories are depth 2, and the depth cap
 * applies per root (depth ≤ `MODULE_TREE_DEPTH_CAP` counting from the root).
 * Files sitting directly in a root are the root node's own `fileCount`
 * (longest-directory attribution keeps deeper files out of it). Deepest-
 * folder attribution considers the module nodes of ALL roots, so nodes
 * detected anywhere (e.g. a datastore under `app/src/main/store`) attach to
 * a real folder home. When discovery finds nothing, each repo-root directory
 * containing source files becomes a root — the legacy fallback, with
 * identical ids and depths to the previous behavior.
 *
 * Depth-semantics note: before multi-root support, depth 1 was each
 * top-level directory UNDER `src/` (`module:src/cli` had depth 1 and
 * `module:src` existed only as a special node for loose files). Module IDS
 * are unchanged (`module:<repo-relative dir path>`); only `meta.depth`
 * shifted by one inside `src/`-style roots, and `contains` chains now
 * consistently satisfy child.depth === parent.depth + 1 from the root down.
 *
 * Output is deterministic (stable sorts everywhere) and unreadable files
 * never throw — they are skipped and counted.
 */

import { join } from 'node:path';
import type { BlueprintEdge, BlueprintNode } from '../types.js';
import {
  discoverSpineRoots,
  isCodeFile,
  readFileSafe,
  sortEdges,
  sortNodes,
  walkRepo,
  type ExtractorFragment,
  type RepoScan,
} from './scan.js';
import { loadAliasConfig, resolveImportSpecifier } from './tsconfig-paths.js';

/** Import/require specifiers: `from 'x'`, `import('x')`, `require('x')`. */
const IMPORT_SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)[`'"]([^`'"]+)[`'"]/g;

/**
 * Maximum folder-tree depth for module nodes, applied PER SPINE ROOT
 * (1 = the root itself). Directories deeper than this roll up into their
 * depth-cap ancestor.
 */
export const MODULE_TREE_DEPTH_CAP = 4;

/** A module directory in the folder tree, with its accumulated file counts. */
interface ModuleDirInfo {
  /** Repo-relative posix path of the module directory. */
  dir: string;
  /** Folder-tree depth within its spine root: 1 = the root itself. */
  depth: number;
  /** Source files sitting directly in this directory. */
  directFiles: number;
  /** Source files rolled up from directories deeper than the depth cap. */
  rolledUpFiles: number;
}

/**
 * The chain of module directories containing a source file, outermost first
 * and UNCAPPED: the SPINE ROOT itself, then every directory down to the
 * file's parent. Returns null for files outside every spine root.
 *
 * Files directly in a root yield `['<root>']` (the root holds its loose
 * files); deeper files yield `['<root>', '<root>/a', '<root>/a/b', …]`.
 * Spine roots are never nested inside each other (see `discoverSpineRoots`),
 * so at most one root contains a given file.
 */
function moduleChainOf(relPath: string, spineRoots: string[]): string[] | null {
  const root = spineRoots.find((candidate) => relPath.startsWith(`${candidate}/`));
  if (root === undefined) {
    return null; // Outside every spine root — not a module file
  }
  const chain: string[] = [root];
  const relSegments = relPath.slice(root.length + 1).split('/');
  // Every segment but the last (the filename) extends the chain
  for (let end = 1; end < relSegments.length; end += 1) {
    chain.push(`${root}/${relSegments.slice(0, end).join('/')}`);
  }
  return chain;
}

/** Every ancestor of `dir`, outermost first, including `dir` itself. */
function ancestorChainOf(dir: string): string[] {
  const segments = dir.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * The chain for a file that no spine root contains but a PINNED directory
 * claims — the pinned directory's own ancestor chain, ending AT the pinned
 * directory. Deepest claim wins. Returns null when nothing pinned claims it.
 *
 * Ending at the pinned directory (rather than at the file's parent) is
 * deliberate: an e2e suite root is one boundary, not a tree. Everything below
 * it rolls up into it.
 */
function pinnedChainOf(relPath: string, pinnedDirs: readonly string[]): string[] | null {
  let deepest: string | null = null;
  for (const dir of pinnedDirs) {
    if (!relPath.startsWith(`${dir}/`)) continue;
    if (deepest === null || dir.length > deepest.length) deepest = dir;
  }
  return deepest === null ? null : ancestorChainOf(deepest);
}

/**
 * How far down a chain the depth cap must stretch: one past the DEEPEST pinned
 * directory on it, or the ordinary cap when nothing on the chain is pinned.
 *
 * This is what makes a capability directory survive. `MODULE_TREE_DEPTH_CAP`
 * is a guess about where meaning stops; a directory the repo NAMES after a
 * capability is evidence, and evidence outranks the guess.
 */
function chainDepthLimit(chain: readonly string[], pinnedDirs: ReadonlySet<string>): number {
  let limit = MODULE_TREE_DEPTH_CAP;
  for (let index = 0; index < chain.length; index += 1) {
    if (pinnedDirs.has(chain[index])) limit = Math.max(limit, index + 1);
  }
  return limit;
}

/**
 * Build the module directory tree from the repo's source files: every
 * directory on some file's (capped) module chain, with direct/rolled-up file
 * counts. Only directories with at least one source file somewhere in their
 * subtree appear — they are registered exclusively via files.
 *
 * `pinnedDirs` are capability directories (see `feature-surfaces`) that must
 * become module nodes even when the depth cap or the spine roots would exclude
 * them. Without this, a feature anchored at `src/app/app/(protected)/playbooks`
 * (depth 5) or `e2e/tests/playbooks` (outside every source root) references a
 * node that cannot exist, and its brief reports the anchor as unresolved
 * forever — the map disagreeing with the thing it is a map of.
 */
function resolveModuleDirs(
  files: string[],
  spineRoots: string[],
  pinnedDirs: readonly string[] = [],
): Map<string, ModuleDirInfo> {
  const sourceFiles = files.filter(isCodeFile); // #536: spine counts any code file
  const infos = new Map<string, ModuleDirInfo>();
  const pinnedSet = new Set(pinnedDirs);

  for (const relPath of sourceFiles) {
    const chain = moduleChainOf(relPath, spineRoots) ?? pinnedChainOf(relPath, pinnedDirs);
    if (chain === null) {
      continue;
    }
    const capped = chain.slice(0, chainDepthLimit(chain, pinnedSet));
    for (let index = 0; index < capped.length; index += 1) {
      if (!infos.has(capped[index])) {
        infos.set(capped[index], {
          dir: capped[index],
          depth: index + 1,
          directFiles: 0,
          rolledUpFiles: 0,
        });
      }
    }
    const owner = infos.get(capped[capped.length - 1]) as ModuleDirInfo;
    if (chain.length > capped.length) {
      owner.rolledUpFiles += 1; // File deeper than the cap — rolls up
    } else {
      owner.directFiles += 1; // Chain ends at the file's parent directory
    }
  }

  return infos;
}

/**
 * Find the DEEPEST module owning a repo-relative path — the longest matching
 * directory wins, so `src/cli/blueprint` beats `src/cli` for files under both.
 */
function moduleOf(relPath: string, moduleDirs: ModuleDirInfo[]): ModuleDirInfo | null {
  let best: ModuleDirInfo | null = null;
  for (const moduleDir of moduleDirs) {
    if (relPath === moduleDir.dir || relPath.startsWith(`${moduleDir.dir}/`)) {
      if (best === null || moduleDir.dir.length > best.dir.length) {
        best = moduleDir;
      }
    }
  }
  return best;
}

/** The parent directory of a repo-relative posix path, or null at the top. */
function parentDirOf(dir: string): string | null {
  const lastSlash = dir.lastIndexOf('/');
  return lastSlash === -1 ? null : dir.slice(0, lastSlash);
}

/** The basename of a repo-relative posix path. */
function basenameOf(dir: string): string {
  const lastSlash = dir.lastIndexOf('/');
  return lastSlash === -1 ? dir : dir.slice(lastSlash + 1);
}

/**
 * Detect the folder-structure module tree and its relations for a repository.
 *
 * `externalNodes` are nodes produced by the other extractors (integrations,
 * endpoints, datastores); each is attributed to the DEEPEST module containing
 * its sourceFile via a `uses`/`exposes` edge. Pass an empty array to derive
 * modules, `contains` and import edges only.
 *
 * `spineRoots` (repo-relative posix dirs, non-nested) seeds the per-root
 * folder trees; when omitted, roots are discovered via `discoverSpineRoots`.
 *
 * `repoScan` (optional) reuses a pre-computed `walkRepo` result — the derive
 * pipeline walks ONCE and threads the scan through; omitted, this walks
 * itself (other callers/tests).
 *
 * `pinnedDirs` (optional) are capability directories that must survive the
 * depth cap and the spine-root filter — see `resolveModuleDirs`.
 */
export function extractModules(
  repoRoot: string,
  externalNodes: BlueprintNode[] = [],
  spineRoots?: string[],
  repoScan?: RepoScan,
  pinnedDirs: readonly string[] = [],
): ExtractorFragment {
  const coverageNotes: string[] = [];
  const scan = repoScan ?? walkRepo(repoRoot);
  const roots = spineRoots ?? discoverSpineRoots(repoRoot, scan);
  const infos = resolveModuleDirs(scan.files, roots, pinnedDirs);
  const moduleDirs = [...infos.values()].sort((a, b) => a.dir.localeCompare(b.dir));

  // Signal 1 — hierarchical folder nodes
  const nodes: BlueprintNode[] = moduleDirs.map((info) => {
    const childDirs = moduleDirs.filter((candidate) => parentDirOf(candidate.dir) === info.dir).length;
    const node: BlueprintNode = {
      id: `module:${info.dir}`,
      kind: 'module',
      label: basenameOf(info.dir),
      sourceFile: info.dir,
      meta: {
        depth: info.depth,
        childDirs,
        fileCount: info.directFiles + info.rolledUpFiles,
      },
    };
    if (info.rolledUpFiles > 0 && node.meta !== undefined) {
      node.meta.rolledUp = true;
    }
    return node;
  });

  const edgeKeys = new Set<string>();
  const edges: BlueprintEdge[] = [];
  const addEdge = (edge: BlueprintEdge): boolean => {
    const key = `${edge.source} ${edge.target} ${edge.relation}`;
    if (edgeKeys.has(key)) {
      return false;
    }
    edgeKeys.add(key);
    edges.push(edge);
    return true;
  };

  // Signal 2 — the `contains` spine (parent module → child module).
  // Rollups are derivable by walking these edges, so attribution edges are
  // never duplicated up the tree.
  let containsEdgeCount = 0;
  for (const info of moduleDirs) {
    const parentDir = parentDirOf(info.dir);
    if (parentDir === null || !infos.has(parentDir)) {
      continue; // Top-level module (or parent dir emitted no module node)
    }
    if (addEdge({ source: `module:${parentDir}`, target: `module:${info.dir}`, relation: 'contains' })) {
      containsEdgeCount += 1;
    }
  }

  // Signal 3 — import edges between the deepest containing modules.
  // Alias-aware resolution (loaded once per derive) lets tsconfig path-aliases
  // (`@/lib/…`, ubiquitous in TS apps) produce real `imports` edges CLI-free;
  // true external packages resolve to nothing local and are dropped by moduleOf.
  const aliasConfig = loadAliasConfig(repoRoot);
  const sourceFiles = scan.files.filter(isCodeFile); // #536: spine counts any code file
  let importEdgeCount = 0;
  let unreadableFiles = 0;

  for (const relPath of sourceFiles) {
    const sourceModule = moduleOf(relPath, moduleDirs);
    if (sourceModule === null) {
      continue;
    }
    const content = readFileSafe(join(repoRoot, relPath));
    if (content === null) {
      unreadableFiles += 1;
      continue;
    }

    for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      const resolved = resolveImportSpecifier(specifier, relPath, aliasConfig);
      if (resolved === null) {
        continue; // External package or out-of-root — not a module relation
      }
      const targetModule = moduleOf(resolved, moduleDirs);
      if (targetModule !== null && targetModule.dir !== sourceModule.dir) {
        const added = addEdge({
          source: `module:${sourceModule.dir}`,
          target: `module:${targetModule.dir}`,
          relation: 'imports',
        });
        if (added) {
          importEdgeCount += 1;
        }
      }
    }
  }

  // Signal 4 — attribute externally-detected nodes to their DEEPEST module
  let attributionEdgeCount = 0;
  for (const externalNode of externalNodes) {
    if (externalNode.kind === 'module') {
      continue;
    }
    const owningModule = moduleOf(externalNode.sourceFile, moduleDirs);
    if (owningModule === null) {
      continue;
    }
    const added = addEdge({
      source: `module:${owningModule.dir}`,
      target: externalNode.id,
      relation: externalNode.kind === 'endpoint' ? 'exposes' : 'uses',
    });
    if (added) {
      attributionEdgeCount += 1;
    }
  }
  // SDK integrations carry their importing files (#orphan integrations) —
  // every importing module gets its own `uses` edge, so the card shows the
  // REAL fan-in instead of a single anchor (addEdge dedupes the first file).
  for (const externalNode of externalNodes) {
    const importingFiles = externalNode.meta?.importingFiles;
    if (!Array.isArray(importingFiles)) continue;
    for (const relPath of importingFiles) {
      if (typeof relPath !== 'string') continue;
      const owner = moduleOf(relPath, moduleDirs);
      if (owner === null) continue;
      if (addEdge({ source: `module:${owner.dir}`, target: externalNode.id, relation: 'uses' })) {
        attributionEdgeCount += 1;
      }
    }
  }

  const rootDirs = moduleDirs.filter((info) => info.depth === 1).map((info) => info.dir);
  coverageNotes.push(
    `modules: ${moduleDirs.length} folder node(s) across ${rootDirs.length} spine root(s) (${rootDirs.join(', ') || 'none'}), depth cap ${MODULE_TREE_DEPTH_CAP} per root`,
    `modules: ${containsEdgeCount} contains edge(s), ${importEdgeCount} cross-module import(s), ${attributionEdgeCount} attribution edge(s)`,
  );
  if (pinnedDirs.length > 0) {
    const kept = pinnedDirs.filter((dir) => infos.has(dir)).length;
    coverageNotes.push(
      `modules: ${kept}/${pinnedDirs.length} capability dir(s) pinned past the depth cap`,
    );
  }
  if (unreadableFiles > 0) {
    coverageNotes.push(`modules: ${unreadableFiles} unreadable source file(s) skipped`);
  }

  return { nodes: sortNodes(nodes), edges: sortEdges(edges), coverageNotes };
}
