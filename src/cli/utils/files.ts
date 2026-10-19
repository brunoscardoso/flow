/**
 * File operation utilities for the init command
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, relative, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CopyOptions, CopyResult } from '../types.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolves the package root directory by finding the nearest package.json
 * with name "plan-flow" starting from a known internal path.
 *
 * Works with:
 * - Local development (src/cli/utils/)
 * - Built output (dist/cli/utils/)
 * - npx / global install (node_modules/plan-flow/dist/cli/utils/)
 * - Jest/CJS (__dirname available)
 */
export function getPackageRoot(): string {
  // Start from this file's directory and walk up to find package root
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'planflow-ai') {
          return dir;
        }
      } catch {
        // Not valid JSON, continue walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // If we can't find it, fall back to 3 levels up from __dirname
  return resolve(__dirname, '..', '..', '..');
}

/**
 * Recursively copies a directory, preserving structure.
 * Returns a CopyResult with created, skipped, and updated files.
 */
export function copyDir(
  src: string,
  dest: string,
  options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };

  if (!existsSync(src)) {
    return result;
  }

  ensureDir(dest);

  const entries = readdirSync(src);

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      const subResult = copyDir(srcPath, destPath, options);
      result.created.push(...subResult.created);
      result.skipped.push(...subResult.skipped);
      result.updated.push(...subResult.updated);
    } else {
      const fileResult = copyFile(srcPath, destPath, options);
      result.created.push(...fileResult.created);
      result.skipped.push(...fileResult.skipped);
      result.updated.push(...fileResult.updated);
    }
  }

  return result;
}

/**
 * Copies a single file with skip/overwrite logic.
 */
export function copyFile(
  src: string,
  dest: string,
  options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };

  ensureDir(dirname(dest));

  if (existsSync(dest)) {
    if (options.force) {
      copyFileSync(src, dest);
      result.updated.push(dest);
    } else {
      result.skipped.push(dest);
    }
  } else {
    copyFileSync(src, dest);
    result.created.push(dest);
  }

  return result;
}

/**
 * Creates a directory recursively if it doesn't exist.
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Removes a directory recursively if it exists.
 * Returns the list of removed paths.
 */
export function removeDir(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const removed: string[] = [dir];
  rmSync(dir, { recursive: true, force: true });
  return removed;
}

/**
 * Lists all files in a directory recursively, returning paths relative to the dir.
 */
export function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      for (const sub of listFilesRecursive(fullPath)) {
        files.push(join(entry, sub));
      }
    } else {
      files.push(entry);
    }
  }
  return files;
}

/**
 * Moves a file from src to dest, creating parent directories as needed.
 */
export function moveFile(src: string, dest: string): void {
  ensureDir(dirname(dest));
  renameSync(src, dest);
}

/**
 * Removes a single file if it exists.
 */
export function removeFile(filePath: string): void {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

/**
 * Checks if a file or directory exists.
 */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * Formats a file path relative to a base for display.
 */
export function relativePath(filePath: string, base: string): string {
  return relative(base, filePath);
}

/**
 * Returns the central vault directory path.
 * Checks PLAN_FLOW_VAULT_DIR env var first, falls back to ~/plan-flow/brain/
 */
export function getVaultDir(): string {
  return process.env.PLAN_FLOW_VAULT_DIR || join(homedir(), 'plan-flow', 'brain');
}

/** The Flow folder's name in the home folder — the vault has always lived inside it. */
const FLOW_FOLDER_NAME = 'plan-flow';

/** The vault's own folder name inside the Flow folder. */
const VAULT_FOLDER_NAME = 'brain';

/**
 * THE Flow folder — the parent that holds `settings/`, `workspaces/` and
 * `projects.local.json` (and, by default, the vault at `brain/`). One resolver,
 * read by every CLI verb; the app mirrors THIS rule rather than inventing one.
 *
 * Precedence, decided 2026-10-06 (workspaces-knowledge-hub, Phase 1):
 *
 *   1. `PLAN_FLOW_HOME` — the explicit override for the Flow folder itself.
 *      New, because a Workspace is not a vault concept: a test, the hidden e2e
 *      run, or a person who moved the Flow folder names it directly.
 *   2. `PLAN_FLOW_VAULT_DIR` — kept working. The Flow folder follows the vault
 *      so an isolated vault (every existing test sandbox, the app's real-CLI
 *      tests) isolates the Workspaces with it: the vault's parent when the
 *      vault is the conventional `…/brain`, otherwise the vault folder itself —
 *      never the unrelated parent of a vault someone put somewhere else.
 *   3. `~/plan-flow` — where the vault (`~/plan-flow/brain`) has always lived,
 *      so the default Flow folder is the folder people already have.
 */
export function resolveFlowFolder(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PLAN_FLOW_HOME;
  if (home !== undefined && home.trim() !== '') return resolve(home);
  const vault = env.PLAN_FLOW_VAULT_DIR;
  if (vault !== undefined && vault.trim() !== '') {
    const resolvedVault = resolve(vault);
    return basename(resolvedVault) === VAULT_FOLDER_NAME ? dirname(resolvedVault) : resolvedVault;
  }
  return join(homedir(), FLOW_FOLDER_NAME);
}

/**
 * How the stored link target is spelled. Grammar only — no filesystem access,
 * so the Windows branch is testable from a Mac and vice versa.
 */
export type LinkTargetGrammar = 'posix' | 'windows' | 'relative' | 'unreadable';

/** Which environment created a link that does not resolve here. */
export type FlowLinkOrigin = 'wsl' | 'windows' | 'unknown';

export type FlowLinkStatus = 'absent' | 'not-a-link' | 'resolves' | 'dangling';

export interface FlowLinkReport {
  status: FlowLinkStatus;
  linkPath: string;
  /** Raw stored target, or null when this environment cannot read the reparse point. */
  target: string | null;
  origin: FlowLinkOrigin;
  /** Remediation text. Non-null only when `status === 'dangling'`. */
  message: string | null;
}

/** `C:\…`, `C:/…`, or a UNC `\\server\share` path. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Classifies a stored link target by its path grammar. Pure.
 */
export function classifyLinkTarget(target: string | null): LinkTargetGrammar {
  if (target === null || target === '') return 'unreadable';
  if (WINDOWS_ABSOLUTE_PATH.test(target)) return 'windows';
  if (target.startsWith('/')) return 'posix';
  return 'relative';
}

/**
 * Given the grammar of a target that does NOT resolve, name the environment
 * that must have created the link. Pure — `platform` is a parameter so both
 * branches are testable on either host.
 *
 * Only a cross-environment link gets a confident origin: a Windows-shaped
 * target seen from Windows is just a link to something that moved, not a WSL
 * artifact, and vice versa.
 */
export function danglingLinkOrigin(
  grammar: LinkTargetGrammar,
  platform: NodeJS.Platform = process.platform
): FlowLinkOrigin {
  if (platform === 'win32') {
    // A POSIX-absolute target means nothing to Windows; an unreadable reparse
    // point means WSL wrote a tag Windows does not understand. Both are WSL.
    if (grammar === 'posix' || grammar === 'unreadable') return 'wsl';
    return 'unknown';
  }
  if (grammar === 'windows') return 'windows';
  return 'unknown';
}

/**
 * The loud, actionable message for a `flow` link that does not resolve.
 * Pure — takes the platform so the Windows wording is testable off-Windows.
 */
export function describeDanglingLink(
  linkPath: string,
  target: string | null,
  origin: FlowLinkOrigin,
  platform: NodeJS.Platform = process.platform
): string {
  const shown = target ?? '(unreadable reparse point)';
  // A link is removed with rmdir on Windows (junctions and directory symlinks
  // are directory entries there); nothing inside the target is deleted.
  const remove = platform === 'win32' ? `rmdir "${linkPath}"` : `rm "${linkPath}"`;
  const recreate = platform === 'win32' ? 'npx planflow-ai init' : 'planflow-ai init';

  const head = `flow link does not resolve: ${linkPath} -> ${shown}`;

  if (origin === 'wsl') {
    return [
      head,
      'It was created under WSL — a POSIX symlink Windows cannot follow.',
      'One checkout cannot serve both environments: the link is a different',
      'object in each, so re-create it in the environment you are using.',
      `  ${remove}`,
      `  ${recreate}`,
      'Or keep using this checkout from WSL, where the link already resolves.',
    ].join('\n');
  }

  if (origin === 'windows') {
    return [
      head,
      'It was created from Windows — a junction pointing at a Windows path',
      'this environment cannot follow.',
      'One checkout cannot serve both environments: the link is a different',
      'object in each, so re-create it in the environment you are using.',
      `  ${remove}`,
      `  ${recreate}`,
      'Or keep using this checkout from Windows, where the link already resolves.',
    ].join('\n');
  }

  return [
    head,
    'The target does not exist in this environment. Re-create the link:',
    `  ${remove}`,
    `  ${recreate}`,
  ].join('\n');
}

/**
 * Reads a link target without throwing. Returns null when the path is not a
 * link OR when this environment cannot decode the reparse point (Windows
 * reading a WSL-created symlink is exactly that case).
 */
function readLinkTargetSafe(linkPath: string): string | null {
  try {
    return readlinkSync(linkPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Is this entry still listed by its parent directory? Used only when `lstat`
 * itself fails — the parent listing is the last witness that something is
 * there before we call a path absent.
 */
function existsInParentListing(linkPath: string): boolean {
  try {
    return readdirSync(dirname(linkPath)).includes(basename(linkPath));
  } catch {
    return false;
  }
}

/**
 * Inspects a `flow` link (or any link) and reports whether it resolves here.
 *
 * The dangling test is deliberately `lstat` sees it / `stat` does not, rather
 * than `isSymbolicLink()`: Windows reports a WSL-created reparse point with an
 * unknown tag, which is neither a readable symlink nor a real directory. That
 * combination is precisely the silent failure this exists to make loud.
 */
export function inspectFlowLink(
  linkPath: string,
  platform: NodeJS.Platform = process.platform
): FlowLinkReport {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    // Verified live on Windows 11: a WSL-created flow link shows up as
    // `Archive, ReparsePoint` with no readable target, so even lstat can
    // refuse it. An entry the parent directory still lists is present and
    // broken, never absent — reporting "no flow/" there is the silent failure.
    if (existsInParentListing(linkPath)) {
      const origin = danglingLinkOrigin('unreadable', platform);
      return {
        status: 'dangling',
        linkPath,
        target: null,
        origin,
        message: describeDanglingLink(linkPath, null, origin, platform),
      };
    }
    return { status: 'absent', linkPath, target: null, origin: 'unknown', message: null };
  }

  if (existsSync(linkPath)) {
    return {
      status: stat.isSymbolicLink() ? 'resolves' : 'not-a-link',
      linkPath,
      target: stat.isSymbolicLink() ? readLinkTargetSafe(linkPath) : null,
      origin: 'unknown',
      message: null,
    };
  }

  const target = readLinkTargetSafe(linkPath);
  const origin = danglingLinkOrigin(classifyLinkTarget(target), platform);
  return {
    status: 'dangling',
    linkPath,
    target,
    origin,
    message: describeDanglingLink(linkPath, target, origin, platform),
  };
}

/** Removes a link entry, trying both the file and directory syscalls. */
function removeLinkEntry(linkPath: string): boolean {
  try {
    unlinkSync(linkPath);
    return true;
  } catch {
    // A junction / directory symlink on Windows is a directory entry.
  }
  try {
    rmdirSync(linkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a symlink. Uses 'junction' on Windows (no admin rights needed), 'dir' on Unix.
 * If a link already exists — resolvable OR dangling — it is removed first.
 *
 * Returns the report of a DANGLING link it replaced (so the caller can tell the
 * user a cross-environment link was found), or null. Throws with the full
 * remediation message when a dangling link cannot be removed, rather than
 * letting `symlinkSync` fail with a bare EEXIST.
 */
export function createSymlink(target: string, linkPath: string): FlowLinkReport | null {
  ensureDir(dirname(linkPath));

  const existing = inspectFlowLink(linkPath);
  const replaced = existing.status === 'dangling' ? existing : null;

  // ALREADY RIGHT → TOUCH NOTHING. Re-making a correct link (remove, then
  // create) left `flow` missing for a moment while the app read through it
  // (live 2026-10-06: ENOTDIR / ENOENT bursts on orbit-app during a re-link).
  if (existing.status === 'resolves' && readSymlinkTarget(linkPath) === target) return null;

  // A NEW TARGET IS SWAPPED IN ATOMICALLY on POSIX: build the new link beside
  // the old one and rename it over — there is never a moment without a link.
  if (process.platform !== 'win32' && (existing.status === 'resolves' || existing.status === 'dangling')) {
    const temp = join(dirname(linkPath), `.${basename(linkPath)}.relink-${process.pid}-${Date.now()}`);
    symlinkSync(target, temp, 'dir');
    try {
      renameSync(temp, linkPath);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // the temporary link is gone already
      }
      throw error;
    }
    return replaced;
  }

  if (existing.status === 'resolves' || existing.status === 'dangling') {
    if (!removeLinkEntry(linkPath) && inspectFlowLink(linkPath).status !== 'absent') {
      throw new Error(
        existing.message ?? `could not replace the existing link at ${linkPath}`
      );
    }
  }

  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(target, linkPath, type);
  return replaced;
}

/**
 * Reads the target of a symlink. Returns null if the path is not a symlink or doesn't exist.
 */
export function readSymlinkTarget(linkPath: string): string | null {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      return readlinkSync(linkPath, 'utf-8');
    }
  } catch {
    // Path doesn't exist or can't be read
  }
  return null;
}

/**
 * Derives a project name from a target directory path.
 */
export function getProjectName(target: string): string {
  return basename(resolve(target));
}

/**
 * Checks if a path is a symbolic link.
 * Returns false if the path doesn't exist.
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Moves all files and directories from src INTO dest.
 * Uses renameSync when possible, falls back to copy+delete for cross-device moves.
 * Does NOT delete the source directory itself.
 */
export function moveContents(
  src: string,
  dest: string
): { moved: number; errors: string[] } {
  const errors: string[] = [];
  let moved = 0;

  ensureDir(dest);

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcItem = join(src, entry.name);
    const destItem = join(dest, entry.name);

    try {
      renameSync(srcItem, destItem);
      moved++;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'EXDEV') {
        try {
          if (entry.isDirectory()) {
            copyDir(srcItem, destItem, { force: true });
            removeDir(srcItem);
          } else {
            ensureDir(dirname(destItem));
            copyFileSync(srcItem, destItem);
            unlinkSync(srcItem);
          }
          moved++;
        } catch (fallbackErr: unknown) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          errors.push(`Failed to move ${entry.name}: ${msg}`);
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to move ${entry.name}: ${msg}`);
      }
    }
  }

  return { moved, errors };
}

/**
 * Recursively move entries from `src` into `dest` WITHOUT overwriting (#908):
 * an entry missing in dest moves wholesale; a directory existing in both
 * recurses; a file existing in both stays put (dest wins — never clobber
 * newer data). Used when re-targeting the flow/ vault symlink so the old
 * target's precious stores (learning-state, investigations, brain docs)
 * follow the move instead of being silently abandoned.
 */
export function mergeMissingContents(
  src: string,
  dest: string
): { moved: number; kept: number; errors: string[] } {
  const errors: string[] = [];
  let moved = 0;
  let kept = 0;
  if (!existsSync(src)) return { moved, kept, errors };
  ensureDir(dest);

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcItem = join(src, entry.name);
    const destItem = join(dest, entry.name);
    try {
      if (!existsSync(destItem)) {
        try {
          renameSync(srcItem, destItem);
          moved++;
        } catch (err: unknown) {
          if ((err as { code?: string }).code === 'EXDEV') {
            if (entry.isDirectory()) {
              copyDir(srcItem, destItem, { force: true });
              removeDir(srcItem);
            } else {
              ensureDir(dirname(destItem));
              copyFileSync(srcItem, destItem);
              unlinkSync(srcItem);
            }
            moved++;
          } else {
            throw err;
          }
        }
      } else if (entry.isDirectory() && statSync(destItem).isDirectory()) {
        const nested = mergeMissingContents(srcItem, destItem);
        moved += nested.moved;
        kept += nested.kept;
        errors.push(...nested.errors);
      } else {
        kept++; // exists in dest — never overwrite
      }
    } catch (err: unknown) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }
  return { moved, kept, errors };
}
