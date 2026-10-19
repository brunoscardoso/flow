// Symlink-aware path containment — shared by the project file channels
// (files.ts), ProjectRegistry.listDirectory, and the LSP channel path
// resolution (lsp/index.ts).
//
// Lexical checks (resolve + relative) reject `..`/absolute escapes but are
// blind to symlinks INSIDE the root that point outside it — and agent bash
// can create such symlinks. These helpers add the physical layer: the
// realpath of the target must stay inside the realpath of the root. Write
// targets may not exist yet, so the deepest EXISTING ancestor is realpath'd
// and the not-yet-existing remainder re-appended before comparing.

import { promises as fsPromises, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative } from 'path'

import { trustedFlowLinkBases } from './flow-folder'

/**
 * plan-flow projects keep their artifacts under `flow/`, which is a SYMLINK to
 * the central vault (see CLAUDE.md). Its realpath legitimately lives outside the
 * project root, so a naive symlink guard rejects every plan/review/discovery
 * file (#56). This is the one project-managed symlink the IDE trusts by name.
 */
const TRUSTED_ROOT_SYMLINK = 'flow'

/** True when `target` is `root` or physically nested inside it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * True when `targetPath` physically resolves inside `rootPath` after
 * following symlinks. `targetPath` may not exist yet (write targets).
 * Callers must have applied lexical containment first — this only guards
 * the symlink dimension.
 *
 * Exception: a target under the project's own `flow/` symlink is allowed even
 * though its realpath is outside the root — `flow/` is a first-class part of
 * every plan-flow project. The exception is honored ONLY when `<root>/flow`
 * resolves inside `<Flow folder>/workspaces` or the vault
 * (`trustedFlowLinkBases`); a `flow` link repointed elsewhere (e.g. → `/` via
 * an in-root `ln -s`) is refused, so it cannot widen file IPC to the whole
 * filesystem (#94). Any other escaping symlink (any other name) is also
 * rejected, so this does not reopen the LOG-10 hole for agent-created links.
 *
 * `ownerCheckout` is the second exception, and it is opt-in: when `rootPath` is
 * a thread's git worktree, this is the main checkout that worktree was cut from
 * (never derived from the path shape — it is the root the thread recorded). A
 * worktree is created with the untracked set LINKED in from that checkout —
 * `node_modules`, `.env*`, `flow/` — so every one of those entries resolves
 * outside the worktree by design, and without this the editor would refuse to
 * open them. A link landing in the worktree's OWN main checkout is the same
 * project's file and is allowed; a link landing anywhere else on disk is still
 * refused, which is the whole reason this guard exists. Pass null (the default)
 * for a root that is not a worktree and the behavior is unchanged.
 */
export async function realPathStaysInsideRoot(
  rootPath: string,
  targetPath: string,
  ownerCheckout: string | null = null,
): Promise<boolean> {
  const [realRoot, realTarget] = await Promise.all([
    realPathOfDeepestExistingAncestor(rootPath),
    realPathOfDeepestExistingAncestor(targetPath),
  ])
  if (isInside(realRoot, realTarget)) return true

  // The worktree's own main checkout — see `ownerCheckout` above. Validated
  // against the checkout's REALPATH, so a project root that is itself reached
  // through a symlink still compares correctly.
  if (ownerCheckout !== null) {
    const realOwner = await realPathOrNull(ownerCheckout)
    if (realOwner !== null && isInside(realOwner, realTarget)) return true
  }

  // The project's own flow/ symlink target and everything under it — but ONLY
  // when flow/ actually resolves STRICTLY inside a folder Flow owns: a
  // Workspace project folder (`<Flow folder>/workspaces/…`, every project since
  // the hard migration) or the vault (before it) (#94). Validate the
  // destination, not the mutable link: a repointed `flow` link is not trusted.
  const realFlow = await realPathOrNull(join(rootPath, TRUSTED_ROOT_SYMLINK))
  if (realFlow === null) return false
  // `<Flow folder>/workspaces` is trusted only STRICTLY inside (a link at the
  // folder itself would be every Workspace at once); the vault keeps its
  // historic rule, inside or at it.
  const [workspacesBase, vaultBase] = await Promise.all(trustedFlowLinkBases().map((base) => realPathOrNull(base)))
  const trusted =
    (workspacesBase !== null && workspacesBase !== realFlow && isInside(workspacesBase, realFlow)) ||
    (vaultBase !== null && isInside(vaultBase, realFlow))
  if (!trusted) return false
  return isInside(realFlow, realTarget)
}

/** realpath(path), or null when it does not exist. */
async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await fsPromises.realpath(path)
  } catch {
    return null
  }
}

/**
 * realpath(path), tolerating paths that do not (fully) exist: walk up to the
 * deepest existing ancestor, realpath it, and re-append the missing
 * remainder untouched. A missing remainder cannot itself be a symlink, so
 * the result is the physical location the path WOULD occupy once created.
 */
async function realPathOfDeepestExistingAncestor(path: string): Promise<string> {
  let current = path
  const missingSegments: string[] = []
  for (;;) {
    try {
      const real = await fsPromises.realpath(current)
      return missingSegments.length === 0 ? real : join(real, ...missingSegments)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error
      }
      const parent = dirname(current)
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        throw error
      }
      missingSegments.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * The synchronous twin of `realPathOfDeepestExistingAncestor`, for the few
 * callers that cannot await (a watcher being aimed, a sink answering inline).
 * One `realpath` per missing segment, so it costs microseconds.
 *
 * NEVER THROWS: with no existing ancestor at all (or an unreadable one) the
 * path comes back as given — the honest "nothing better is known".
 *
 * WHY NOT `realpathSync(path) ?? path`: a path that does not exist YET would
 * come back in its through-the-link form, and `<repo>/flow` is a link. macOS
 * FSEvents reports the PHYSICAL path of every change, so a watcher aimed
 * through the link at a directory created later hears nothing, ever.
 */
export function realPathThroughLinksSync(path: string): string {
  let current = path
  const missingSegments: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return missingSegments.length === 0 ? real : join(real, ...missingSegments)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return path
      const parent = dirname(current)
      if (parent === current) return path
      missingSegments.unshift(basename(current))
      current = parent
    }
  }
}
