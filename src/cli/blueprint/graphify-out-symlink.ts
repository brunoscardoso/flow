/**
 * Graphify output containment (#142, hardened for Tailwind/Turbopack).
 *
 * Graphify writes `graphify-out/` relative to its cwd (it has no --out flag), so
 * left alone it drops a ~MB graph + sentinels at the repo root that must never be
 * committed. #142 originally relocated this into the vault by making repo-root
 * `graphify-out/` a SYMLINK to `flow/brain/.structure/graphify-out/` (itself
 * reached through the `flow` vault symlink).
 *
 * That double symlink BREAKS Tailwind v4 / Turbopack projects: Tailwind sees the
 * link's target as project-local (`flow/brain/...`), follows it, then the `flow`
 * symlink jumps outside the project and Turbopack panics ("... leaves the
 * filesystem root") while relativizing the CSS source graph. A real directory
 * cannot escape the filesystem root, so this module now keeps `graphify-out/` a
 * PLAIN, gitignored repo-root directory — never a vault symlink — and MIGRATES
 * any pre-existing relocation symlink back to a real directory (copying the
 * vault's current graph in first, so graphify's incremental `update` still finds
 * it). The blueprint derive reads `<repoRoot>/graphify-out/graph.json` either
 * way, so nothing downstream changes.
 *
 * Idempotent and fail-soft: any FS error yields `skipped` — containment is best
 * effort, never a hard failure (matches the blueprint's fail-soft rule).
 */
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** Vault-relative path the LEGACY relocation symlink pointed at (migration source). */
export const VAULT_GRAPHIFY_OUT_RELPATH = join('flow', 'brain', '.structure', 'graphify-out');
/** The repo-root entry graphify writes to by its own convention. */
export const REPO_GRAPHIFY_OUT = 'graphify-out';
/** The graph file whose presence means the local dir already has a graph. */
const GRAPHIFY_GRAPH_FILENAME = 'graph.json';

export type SymlinkAction = 'created' | 'migrated' | 'noop' | 'skipped';

export interface EnsureSymlinkResult {
  action: SymlinkAction;
  /** One-line notice for the caller to surface (present for migrated/skipped). */
  notice?: string;
}

/** lstat that returns null instead of throwing when the path node is absent. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Copy the vault's graphify output into the local dir when the local dir has no
 * graph of its own. Best effort — an unreadable vault just means graphify does a
 * full rebuild instead of an incremental update.
 *
 * Without this, a local dir that exists but holds no graph (fresh `created`, or
 * a dir left behind by a deleted graph) ORPHANS the vault's built graph: derive
 * reads `<repoRoot>/graphify-out/graph.json`, finds nothing, and silently falls
 * back to native-only structure — a graph with no `imports`/`calls` edges, so
 * the board renders no connection lines at all.
 */
function seedFromVault(vaultTarget: string, repoDir: string): boolean {
  if (existsSync(join(repoDir, GRAPHIFY_GRAPH_FILENAME)) || !existsSync(vaultTarget)) {
    return false;
  }
  // force:false — anything already local wins over the vault copy.
  cpSync(vaultTarget, repoDir, { recursive: true, force: false, errorOnExist: false });
  return true;
}

/**
 * Ensure repo-root `graphify-out/` is a PLAIN local directory (never a vault
 * symlink). Creates the directory when absent, converts a legacy relocation
 * symlink back into a real directory, and no-ops when a real directory already
 * exists. In every case the vault's current graph is seeded in when the local
 * dir has none, so a previously built graph is never orphaned.
 */
export function ensureGraphifyOutLocal(repoRoot: string): EnsureSymlinkResult {
  const vaultTarget = join(repoRoot, VAULT_GRAPHIFY_OUT_RELPATH);
  const repoDir = join(repoRoot, REPO_GRAPHIFY_OUT);

  try {
    const node = lstatOrNull(repoDir);

    if (node === null) {
      mkdirSync(repoDir, { recursive: true });
      const seeded = seedFromVault(vaultTarget, repoDir);
      return {
        action: 'created',
        ...(seeded
          ? { notice: 'Graphify: seeded graphify-out from the vault graph.' }
          : {}),
      };
    }

    if (node.isSymbolicLink()) {
      // The legacy #142 relocation symlink (or any stale link) — replace it with
      // a real directory so Tailwind/Turbopack can never follow it out of the
      // project. Copy the vault's current graph in first (best effort) so
      // graphify's incremental update keeps the prior graph rather than
      // full-rebuilding once.
      rmSync(repoDir);
      mkdirSync(repoDir, { recursive: true });
      seedFromVault(vaultTarget, repoDir);
      return {
        action: 'migrated',
        notice:
          'Graphify: converted graphify-out symlink to a local gitignored directory (Tailwind/Turbopack safety).',
      };
    }

    if (node.isDirectory()) {
      const seeded = seedFromVault(vaultTarget, repoDir);
      return {
        action: 'noop',
        ...(seeded
          ? { notice: 'Graphify: seeded graphify-out from the vault graph.' }
          : {}),
      };
    }

    // A plain file sits where the dir should be — don't clobber user data.
    return {
      action: 'skipped',
      notice: 'Graphify: graphify-out exists as a file — containment skipped.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action: 'skipped', notice: `Graphify: output containment skipped — ${message}` };
  }
}

/** Whether repo-root `graphify-out` is a plain local directory (not a symlink). */
export function graphifyOutIsLocalDir(repoRoot: string): boolean {
  const node = lstatOrNull(join(repoRoot, REPO_GRAPHIFY_OUT));
  return node !== null && node.isDirectory() && !node.isSymbolicLink();
}
