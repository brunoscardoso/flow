/**
 * RENAMING THE CHECKOUTS NOBODY NAMED — the upgrade half of separating a
 * worktree from a branch.
 *
 * Every checkout cut before 2026-09-17 lives in `.{repo}-threads/<thread-uuid>`,
 * because the directory's name was the thread's id. That is what a person's
 * shell prompt reads, and no amount of new naming fixes the ones already on
 * disk (user, 2026-09-17: "rename them all on upgrade").
 *
 * THREE RULES, AND THE THIRD IS THE ONE THAT MATTERS:
 *
 *  1. The plan is PURE. What to rename, and to what, is decided without
 *     touching a disk — so it can be reported before anything moves, and
 *     tested without a repository.
 *  2. The move goes through `git worktree move`, never `mv`. Git keeps its own
 *     registry of where a worktree lives (`.git/worktrees/<id>/gitdir`), and a
 *     directory renamed behind its back is a checkout git can no longer find.
 *  3. A PARTIAL MIGRATION IS A SUCCESS. On a real machine some checkouts are
 *     locked, dirty in ways git refuses to move, or simply gone. Each one is
 *     left exactly as it was and reported by name; the app has to be correct
 *     with both kinds of directory present, because that is the state most
 *     people will actually be in.
 *
 * The rename is not the record. `applyCheckoutRenames` writes the store
 * immediately after each successful move, one checkout at a time, so a crash
 * leaves a directory and its record in step rather than a database pointing at
 * a path that moved.
 */

import {
  WORKTREE_FOLDER_PREFIX,
  folderForBranch,
  isUnnamedCheckoutPath,
  uniqueWorktreeName,
  worktreeNameFromTitle,
} from '../../shared/worktree-name'

/** One checkout, as the store knows it. */
export interface RecordedCheckout {
  threadId: string
  title: string | null
  rootPath: string
  worktreePath: string
  kind: 'primary' | 'attached'
}

/** One rename this upgrade would perform. */
export interface CheckoutRename {
  threadId: string
  /** The project this checkout belongs to — where `git worktree move` runs. */
  rootPath: string
  from: string
  to: string
  /** The folder's new name, for anything that wants to say it. */
  name: string
}

/** The last path segment, without a trailing slash. */
function segment(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** Everything up to the last segment. */
function parent(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(0, trimmed.lastIndexOf('/'))
}

/**
 * A checkout split into the container it lives in and the name it has there.
 *
 * NESTING MAKES THIS TWO CASES. A checkout nobody named sits directly in
 * `.{repo}-threads/<uuid>`; a named one sits one level deeper, in
 * `.{repo}-threads/worktree/<name>`. Both belong to the SAME container, and
 * treating the `worktree` folder as a container of its own is how two names
 * that collide stop looking like two names in different places.
 */
function split(path: string): { container: string; name: string } {
  const trimmed = path.replace(/\/+$/, '')
  const base = segment(trimmed)
  const above = parent(trimmed)
  const folder = WORKTREE_FOLDER_PREFIX.replace(/\/$/, '')
  return segment(above) === folder
    ? { container: parent(above), name: `${folder}/${base}` }
    : { container: above, name: base }
}

/**
 * The flat folder prefix this feature shipped with for one afternoon.
 *
 * `worktree-<name>` was the first cut; the same day it became `worktree/<name>`,
 * a folder rather than a hyphen (user, 2026-09-17: "we should not split by - -
 * the name, should not be worktree-feature-branch, should be
 * worktree/feature-branch"). Checkouts renamed in between wear the old shape and
 * nothing would ever touch them again: they are not uuids, so the migration's
 * only subject did not match them, and they sat beside the new ones looking
 * almost right (user, 2026-09-18: "I asked to use worktree/feature-branch-name,
 * not worktree-feature-branch-name").
 */
const FLAT_FOLDER_PREFIX = `${WORKTREE_FOLDER_PREFIX.replace(/\/$/, '')}-`

/**
 * What this checkout should be called, or null when its name is already right.
 *
 * TWO SUBJECTS, ONE ANSWER EACH, and the difference between them is where the
 * name comes from:
 *
 *   a thread id  → there is no name to keep, so one is DERIVED from the
 *                  conversation's title, exactly as the ask would have.
 *   the flat form → there IS a name and somebody may have typed it, so it is
 *                  KEPT and only its prefix is re-shaped. Re-deriving here would
 *                  rename folders whose names people already know, which is the
 *                  opposite of what a migration to a readable name is for.
 */
function wantedName(checkout: RecordedCheckout, currentName: string): string | null {
  if (isUnnamedCheckoutPath(checkout.worktreePath)) {
    // The same name the ask would have produced — so a migrated checkout is
    // indistinguishable from one cut today.
    return folderForBranch(worktreeNameFromTitle(checkout.title))
  }
  // A name that already contains a separator is already nested: `split` only
  // reports the two-segment form for a checkout inside the folder.
  if (currentName.includes('/')) return null
  if (!currentName.startsWith(FLAT_FOLDER_PREFIX)) return null
  const stem = currentName.slice(FLAT_FOLDER_PREFIX.length)
  return stem === '' ? null : `${WORKTREE_FOLDER_PREFIX}${stem}`
}

/**
 * What this upgrade would rename, and to what.
 *
 * PURE, so the dry run and the real run cannot disagree about the plan: they
 * are the same function, and only the second one moves anything.
 *
 * NAMES ARE UNIQUE WITHIN A CONTAINER, not globally — two projects may each
 * have a `worktree-fix-the-parser`, and they are different directories. The
 * taken set therefore starts from every name already in that container,
 * including the ones this plan is about to add.
 */
export function planCheckoutRenames(checkouts: readonly RecordedCheckout[]): CheckoutRename[] {
  // Names already spoken for, per container. A checkout that is ALREADY named
  // keeps its name and contributes it — renaming around it is the point.
  const taken = new Map<string, Set<string>>()
  for (const checkout of checkouts) {
    const here = split(checkout.worktreePath)
    const names = taken.get(here.container) ?? new Set<string>()
    names.add(here.name)
    taken.set(here.container, names)
  }

  const renames: CheckoutRename[] = []
  for (const checkout of checkouts) {
    const here = split(checkout.worktreePath)
    const wanted = wantedName(checkout, here.name)
    // ALREADY RIGHT IS LEFT ALONE, however odd the name. Only a directory
    // called after a thread id, or one wearing the flat prefix this feature
    // shipped for an afternoon, is one nobody chose in its current shape.
    if (wanted === null) continue
    const dir = here.container
    const names = taken.get(dir) ?? new Set<string>()
    // Unique against everything else in this container — the nested form counts
    // as one name, not as a folder full of them.
    const name = uniqueWorktreeName(wanted, names)
    names.add(name)
    // The old id stops holding its place the moment this one takes a new one.
    names.delete(here.name)
    taken.set(dir, names)
    renames.push({
      threadId: checkout.threadId,
      rootPath: checkout.rootPath,
      from: checkout.worktreePath.replace(/\/+$/, ''),
      to: `${dir}/${name}`,
      name,
    })
  }
  return renames
}

/** What became of one planned rename. */
export interface CheckoutRenameResult {
  rename: CheckoutRename
  status: 'renamed' | 'refused' | 'skipped'
  /** Git's own words when it refused, or why this was skipped. */
  detail?: string
}

export interface CheckoutRenameDeps {
  /** Runs `git` in a project and reports what happened. */
  runGit: (cwd: string, args: readonly string[]) => Promise<{ ok: boolean; stderr?: string }>
  /** Whether a path is still there — a checkout that is gone is not moved. */
  exists: (path: string) => boolean
  /** Points the store at where a checkout now lives. */
  repoint: (from: string, to: string) => void
  /**
   * Makes sure a checkout's new PARENT exists.
   *
   * `git worktree move` will not create the folder it is moving into, and the
   * whole point of the nested shape is that the folder above is new the first
   * time (`.{repo}-threads/worktree/`).
   */
  ensureParent: (path: string) => void
}

/**
 * Perform the plan, or report it without touching anything.
 *
 * `dryRun` IS THE DEFAULT ARGUMENT NOBODY SHOULD HAVE TO PASS — but it is not
 * defaulted here, because this function moves directories and a destructive
 * default is how a test becomes an incident (forbidden-pattern #15). Every
 * caller says which it wants.
 */
export async function applyCheckoutRenames(
  deps: CheckoutRenameDeps,
  plan: readonly CheckoutRename[],
  options: { dryRun: boolean },
): Promise<CheckoutRenameResult[]> {
  const results: CheckoutRenameResult[] = []
  for (const rename of plan) {
    if (!deps.exists(rename.from)) {
      results.push({
        rename,
        status: 'skipped',
        detail: 'the folder is not there any more',
      })
      continue
    }
    if (deps.exists(rename.to)) {
      results.push({
        rename,
        status: 'skipped',
        detail: 'something is already called that',
      })
      continue
    }
    if (options.dryRun) {
      results.push({ rename, status: 'skipped', detail: 'nothing was moved' })
      continue
    }
    deps.ensureParent(parent(rename.to))
    // GIT'S OWN VERB. `mv` would leave `.git/worktrees/<id>/gitdir` pointing at
    // the old path, which is a checkout git can no longer find — and the
    // failure would surface later, somewhere else, as a repository that has
    // forgotten one of its worktrees.
    const moved = await deps.runGit(rename.rootPath, [
      'worktree',
      'move',
      rename.from,
      rename.to,
    ])
    if (!moved.ok) {
      results.push({
        rename,
        status: 'refused',
        detail: (moved.stderr ?? '').trim() || 'git would not move it',
      })
      continue
    }
    // IMMEDIATELY, AND PER CHECKOUT. A crash between the move and the record is
    // the one outcome that leaves the app pointing at a path that is not there,
    // so the window where that is possible is one checkout wide.
    deps.repoint(rename.from, rename.to)
    results.push({ rename, status: 'renamed' })
  }
  return results
}

/**
 * The upgrade, as a sentence a person could read.
 *
 * NAMES WHAT DID NOT MOVE, because that is the half that needs a reader: a
 * checkout left behind keeps working under its old name, and somebody has to be
 * able to find out which one it was.
 */
export function describeCheckoutRenames(results: readonly CheckoutRenameResult[]): string {
  if (results.length === 0) return 'No checkouts needed renaming.'
  const renamed = results.filter((result) => result.status === 'renamed')
  const left = results.filter((result) => result.status !== 'renamed')
  const lines = [`${renamed.length} of ${results.length} checkouts renamed.`]
  for (const result of left) {
    lines.push(`  ${segment(result.rename.from)} → ${result.rename.name}: ${result.detail ?? ''}`)
  }
  return lines.join('\n')
}
