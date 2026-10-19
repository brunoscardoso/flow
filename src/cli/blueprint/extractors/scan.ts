/**
 * Shared filesystem scanning helpers for the blueprint extractors.
 *
 * Extractors are deterministic: the walk visits directory entries in sorted
 * order and returns repo-relative posix paths, so the same code always
 * produces the same output. Ignored directories are skipped — well-known
 * artifact names, VCS metadata and hidden dirs by name, plus whatever the
 * repo's own `.gitignore` excludes (`gitIgnoredDirs`), because a hardcoded list
 * of seven names cannot know about a given repo's generated output. Unreadable
 * files or directories never throw — they are skipped and surfaced through
 * counters so coverage reporting has no silent gaps.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { BlueprintEdge, BlueprintNode } from '../types.js';

/** Directory names never descended into during a repo walk. */
const IGNORED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv']);

/** File extensions treated as scannable source code. */
const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Conventional spine-root candidate patterns checked during source-root
 * discovery, in addition to package.json workspaces. `*` matches a single
 * path segment.
 */
const CONVENTIONAL_SPINE_ROOT_PATTERNS = ['src', 'app/src', 'lib', 'packages/*/src', 'apps/*/src'];

/** Nested source directory preferred inside a workspace root (`<ws>/src`). */
const WORKSPACE_SOURCE_DIR = 'src';

/**
 * The fragment every extractor returns: structural nodes/edges plus
 * human-readable coverage notes (frameworks detected, patterns matched,
 * files skipped) for the CLI to print.
 */
export interface ExtractorFragment {
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  coverageNotes: string[];
}

/** Result of walking a repository tree. */
export interface RepoScan {
  /** Repo-relative paths (posix separators) of every file found, sorted. */
  files: string[];
  /** Repo-relative paths of directories that could not be read, sorted. */
  unreadableDirs: string[];
  /**
   * Repo-relative paths of every directory the walk read ('' = the root),
   * sorted. Optional so hand-built scans stay valid; `walkRepo` always fills
   * it. A cache of the walk checks these directories' mtimes — adding or
   * removing an entry changes its directory's — to know the file list still
   * stands without walking again (`storyline-imports.ts`).
   */
  dirs?: string[];
}

/** Convert an OS-specific relative path to posix separators. */
export function toPosixPath(relPath: string): string {
  return relPath.split(sep).join('/');
}

/** Whether a repo-relative path has a source-code extension. */
export function isSourceFile(relPath: string): boolean {
  return SOURCE_FILE_EXTENSIONS.some((extension) => relPath.endsWith(extension));
}

/**
 * Recognized CODE files across languages (#536). Folder STRUCTURE is
 * language-agnostic and cheap (allowed-pattern #13), so the module spine
 * (discoverSpineRoots / collectSourceDirs / the module extractor's file scan)
 * builds from ANY code file — a Python or Go repo still gets its package map with
 * `contains` edges even without graphify. Language-SPECIFIC extraction (imports /
 * calls / endpoints / integrations) stays TS/JS via isSourceFile.
 */
const CODE_FILE_EXTENSIONS = [
  ...SOURCE_FILE_EXTENSIONS,
  '.py', '.pyi', '.go', '.rb', '.java', '.kt', '.kts', '.cs', '.php', '.rs',
  '.sql', '.swift', '.scala', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.m', '.mm', '.ex', '.exs', '.clj', '.cljs', '.dart', '.lua', '.r',
];

export function isCodeFile(relPath: string): boolean {
  return CODE_FILE_EXTENSIONS.some((extension) => relPath.endsWith(extension));
}

/**
 * Whether a source file is a TEST / SPEC / FIXTURE / MOCK by convention (#538).
 * The integration + endpoint extractors skip these — a mock URL like
 * `https://registry.test.com/…` in a `*.server.test.ts` fixture must not become a
 * real `integration:test.com` node (and a crit "new external integration"). The
 * module spine still counts them as files; only the URL/route extractors exclude.
 * Path-separator agnostic (POSIX-normalized first).
 */
export function isTestFile(relPath: string): boolean {
  const posix = toPosixPath(relPath);
  return (
    /(?:^|\/)(?:__tests__|__mocks__|e2e|fixtures|test|tests|spec|specs)\//.test(posix) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(posix)
  );
}

/**
 * The four TRUST TIERS every repo file classifies into (trust-tiers Phase 1):
 * - `code` — ground truth: executable source plus diff-visible config/build
 *   files. What the repo actually does.
 * - `own` — plan-flow's verified store (`flow/**`, `.claude/**`): content this
 *   system wrote and maintains.
 * - `claim` — foreign docs and images: statements ABOUT the code that nothing
 *   verifies until an adjudication verdict says otherwise.
 * - `other` — everything else (binaries, data blobs, unknown extensions).
 */
export type FileTier = 'code' | 'own' | 'claim' | 'other';

/** Repo-root directories owned by plan-flow — everything under them is `own`. */
const OWN_TIER_DIRS = ['flow', '.claude'];

/**
 * Config/build extensions counted as `code` alongside `isCodeFile` — they are
 * diff-visible and executable-adjacent (a lockfile or tsconfig change changes
 * behavior the way source does).
 */
const CONFIG_FILE_EXTENSIONS = ['.json', '.yaml', '.yml', '.toml', '.lock'];

/** Doc extensions classified as `claim` when not under an own directory. */
const CLAIM_DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.txt'];

/** Image extensions classified as `claim` when not under an own directory. */
const CLAIM_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];

/**
 * Classify a repo-relative path into its trust tier. Precedence: `own`
 * (location beats extension — a doc under `flow/` is plan-flow's own store,
 * not a foreign claim) → `code`/`claim` by extension → `other`. Extension
 * matching is case-insensitive (`README.MD` is still a claim); paths are
 * POSIX-normalized first, and the bare own directories themselves classify
 * as `own`.
 */
export function classifyTier(relPath: string): FileTier {
  const posix = toPosixPath(relPath);
  if (OWN_TIER_DIRS.some((dir) => posix === dir || posix.startsWith(`${dir}/`))) {
    return 'own';
  }
  const lowered = posix.toLowerCase();
  if (isCodeFile(lowered) || CONFIG_FILE_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
    return 'code';
  }
  if (
    CLAIM_DOC_EXTENSIONS.some((extension) => lowered.endsWith(extension)) ||
    CLAIM_IMAGE_EXTENSIONS.some((extension) => lowered.endsWith(extension))
  ) {
    return 'claim';
  }
  return 'other';
}

/**
 * Whether a directory name should be skipped during the walk:
 * hidden directories (leading dot) and well-known artifact directories.
 */
function isIgnoredDirName(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIR_NAMES.has(name);
}

/**
 * Directories the repo's own `.gitignore` rules exclude, repo-relative.
 *
 * THE HARDCODED LIST CANNOT BE THE WHOLE ANSWER: it names seven directories,
 * and every generated directory that is not one of them became a module node.
 * Playwright's failure output was the live instance — `app/test-results` and a
 * node named after one specific failing test, counted against feature coverage
 * so it could never reach 100%. The repo already states which directories are
 * artifacts, in the file whose job that is, so this asks git instead of
 * guessing.
 *
 * ONE subprocess per walk, not one per directory: `--directory` collapses a
 * wholly-ignored tree to its root, so the walk never descends it at all.
 *
 * FAIL-SOFT, deliberately. No git, no repo, or a git that errors leaves the
 * hardcoded list in charge — exactly today's behaviour. A blueprint derive must
 * degrade to a coarser map, never refuse to draw one.
 *
 * EXPORTED BECAUSE STRUCTURE HAS TWO SOURCES. The native walk was the only
 * caller while it was the only thing proposing modules; the graphify backbone
 * proposes them too, and it was not asking (#1800). A second structural source
 * is not an exemption from the repo's own statement about what is an artifact.
 */
export function gitIgnoredDirs(repoRoot: string): Set<string> {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const dirs = new Set<string>();
    for (const line of out.split('\n')) {
      // Only entries git marked as whole directories; a bare ignored FILE is
      // not a walk boundary and dropping it here keeps this about descent.
      const trimmed = line.trim();
      if (trimmed.endsWith('/')) dirs.add(trimmed.slice(0, -1));
    }
    return dirs;
  } catch {
    return new Set();
  }
}

/**
 * Whether a repo-relative path sits inside a directory git ignores.
 *
 * THE WALK NEVER NEEDED THIS because it tests one directory name at a time as
 * it descends, so it stops at the boundary and never sees what is below. A
 * consumer handed a flat list of paths — the graphify backbone's file set — has
 * no descent to stop, so it has to ask about the whole path.
 */
export function isUnderIgnoredDir(relPath: string, ignoredDirs: ReadonlySet<string>): boolean {
  if (ignoredDirs.size === 0) return false;
  const segments = relPath.split('/');
  // Every ancestor directory of the path, shallowest first — the file itself is
  // not a directory, so the last segment never forms one.
  for (let end = 1; end < segments.length; end += 1) {
    if (ignoredDirs.has(segments.slice(0, end).join('/'))) return true;
  }
  return false;
}

/**
 * Walk the repository tree rooted at `repoRoot` and return every file as a
 * sorted repo-relative posix path. Directories that cannot be read are
 * skipped and reported in `unreadableDirs` rather than throwing.
 */
export function walkRepo(repoRoot: string): RepoScan {
  const files: string[] = [];
  const unreadableDirs: string[] = [];
  const dirs: string[] = [];
  const pendingDirs: string[] = ['']; // repo-relative, '' = root
  const ignoredDirs = gitIgnoredDirs(repoRoot);

  while (pendingDirs.length > 0) {
    const relDir = pendingDirs.pop() as string;
    const absDir = relDir === '' ? repoRoot : join(repoRoot, relDir);

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      // Unreadable directory — skip it, but surface it in the scan result
      unreadableDirs.push(relDir === '' ? '.' : relDir);
      continue;
    }
    dirs.push(relDir);

    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isIgnoredDirName(entry.name) && !ignoredDirs.has(relPath)) {
          pendingDirs.push(relPath);
        }
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  files.sort();
  unreadableDirs.sort();
  dirs.sort();
  return { files, unreadableDirs, dirs };
}

/**
 * Read a file as UTF-8, returning null when it cannot be read.
 * Callers count nulls as skipped files for coverage reporting.
 */
export function readFileSafe(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf-8');
  } catch {
    // Unreadable file — the caller records it in its skip counter
    return null;
  }
}

/**
 * Read a file as raw bytes, returning null when it cannot be read. For
 * callers that hash AND parse the same file: hash the buffer, then decode it
 * once — one read instead of two.
 */
export function readFileBytesSafe(absPath: string): Buffer | null {
  try {
    return readFileSync(absPath);
  } catch {
    // Unreadable file — the caller records it in its skip counter
    return null;
  }
}

/**
 * Read and parse the repo's root package.json.
 * Returns null when the file is missing or contains invalid JSON.
 */
export function readPackageJsonSafe(repoRoot: string): Record<string, unknown> | null {
  const content = readFileSafe(join(repoRoot, 'package.json'));
  if (content === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Invalid JSON — treat as absent; callers note this in coverage
    return null;
  }
}

/**
 * Collect declared dependency names from a parsed package.json
 * (dependencies, optionalDependencies, and peerDependencies), sorted.
 */
export function collectDependencyNames(packageJson: Record<string, unknown>): string[] {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const names = new Set<string>();

  for (const section of sections) {
    const value = packageJson[section];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const name of Object.keys(value)) {
        names.add(name);
      }
    }
  }

  return [...names].sort();
}

/**
 * All repo-relative directories that contain at least one source file
 * somewhere in their subtree, derived from a walk's file list. The walk
 * already applies the ignore rules, so build-output and hidden directories
 * never appear here.
 */
function collectSourceDirs(files: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const relPath of files) {
    if (!isCodeFile(relPath)) { // #536: spine is language-agnostic
      continue;
    }
    const segments = relPath.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      dirs.add(segments.slice(0, end).join('/'));
    }
  }
  return dirs;
}

/**
 * Compile a directory glob pattern to a regex. Only `*` is supported and it
 * matches within a single path segment (`packages/*` matches `packages/a`,
 * not `packages/a/b`) — the shape npm workspaces overwhelmingly use.
 */
function dirPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

/** Expand a directory pattern against a sorted list of known directories. */
function expandDirPattern(pattern: string, sortedDirs: string[]): string[] {
  if (!pattern.includes('*')) {
    return sortedDirs.includes(pattern) ? [pattern] : [];
  }
  const regex = dirPatternToRegex(pattern);
  return sortedDirs.filter((dir) => regex.test(dir));
}

/**
 * Read the workspace glob patterns from a parsed package.json — either the
 * `workspaces: string[]` shorthand or the `workspaces: { packages: string[] }`
 * object form. Non-string entries, `.` and empty patterns are dropped;
 * leading `./` and trailing slashes are normalized away.
 */
function workspaceGlobPatterns(packageJson: Record<string, unknown>): string[] {
  const workspaces = packageJson.workspaces;
  let raw: unknown[] = [];
  if (Array.isArray(workspaces)) {
    raw = workspaces;
  } else if (typeof workspaces === 'object' && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      raw = packages;
    }
  }

  const patterns: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized !== '' && normalized !== '.') {
      patterns.push(normalized);
    }
  }
  return patterns;
}

/** Number of path segments in a repo-relative posix path. */
function segmentCountOf(dir: string): number {
  return dir.split('/').length;
}

/**
 * Discover the repository's SPINE ROOTS — the source directories the module
 * extractor builds its folder trees from. Deterministic; returns sorted
 * repo-relative posix paths.
 *
 * Candidates, in gathering order:
 * 1. package.json `workspaces` globs (`string[]` or `{ packages }`): each
 *    matched directory contributes `<match>/src` when that directory contains
 *    source files in its subtree, else the match itself.
 * 2. Conventional roots: `src`, `app/src`, `lib`, plus the starred
 *    `packages` / `apps` per-package src patterns
 *    (see `CONVENTIONAL_SPINE_ROOT_PATTERNS`).
 *
 * Selection: a candidate must exist and contain at least one source file in
 * its subtree (the walk's ignore rules apply, so build outputs and hidden
 * dirs are excluded); candidates nested inside an already-selected root are
 * dropped (outermost-shallowest wins); duplicates collapse.
 *
 * Fallback: when nothing matches, every repo-root directory containing
 * source files becomes a root — the legacy single-spine behavior.
 *
 * `repoScan` (optional) reuses a pre-computed `walkRepo` result — the derive
 * pipeline walks ONCE and threads the scan through; omitted, this walks
 * itself (other callers/tests).
 */
export function discoverSpineRoots(repoRoot: string, repoScan?: RepoScan): string[] {
  const scan = repoScan ?? walkRepo(repoRoot);
  const sourceDirs = collectSourceDirs(scan.files);
  const sortedSourceDirs = [...sourceDirs].sort();

  const candidates: string[] = [];

  const packageJson = readPackageJsonSafe(repoRoot);
  if (packageJson !== null) {
    for (const pattern of workspaceGlobPatterns(packageJson)) {
      for (const match of expandDirPattern(pattern, sortedSourceDirs)) {
        const nestedSourceDir = `${match}/${WORKSPACE_SOURCE_DIR}`;
        candidates.push(sourceDirs.has(nestedSourceDir) ? nestedSourceDir : match);
      }
    }
  }

  for (const pattern of CONVENTIONAL_SPINE_ROOT_PATTERNS) {
    candidates.push(...expandDirPattern(pattern, sortedSourceDirs));
  }

  // Dedupe, then keep only outermost roots: shallower (fewer segments) first
  // so a root always precedes anything nested inside it.
  const unique = [...new Set(candidates)].sort(
    (a, b) => segmentCountOf(a) - segmentCountOf(b) || a.localeCompare(b),
  );
  const roots: string[] = [];
  for (const candidate of unique) {
    if (!roots.some((root) => candidate.startsWith(`${root}/`))) {
      roots.push(candidate);
    }
  }

  if (roots.length === 0) {
    for (const dir of sortedSourceDirs) {
      if (!dir.includes('/')) {
        roots.push(dir); // Legacy fallback: repo-root dirs with source files
      }
    }
  }

  return roots.sort();
}

/** Stable sort of nodes by id (in place on a copy; input is not mutated). */
export function sortNodes(nodes: BlueprintNode[]): BlueprintNode[] {
  return [...nodes].sort((a, b) => a.id.localeCompare(b.id));
}

/** Stable sort of edges by source, target, then relation (copy; no mutation). */
export function sortEdges(edges: BlueprintEdge[]): BlueprintEdge[] {
  return [...edges].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target) ||
      a.relation.localeCompare(b.relation),
  );
}
