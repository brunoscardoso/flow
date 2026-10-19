// Thread change review read model (Cursor-style, #1906).
//
// The pure union that answers "what did this thread change": the thread
// worktree's git working-tree status (the source of truth for what is
// keep/rejectable) enriched by the thread's persisted tool-call paths (so a
// file the agent touched but left with no net change is still visible — but
// informational, never keep/rejectable). No diff engine and no second change
// store — this is git status, re-shaped for the in-chat review card.
//
// `buildThreadChangeReview` is PURE (path math only, deps injected) so it is
// unit-testable without Electron. `resolveThreadChangeReview` is the thin
// impure assembly over structural slices of GitManager + ThreadStore.

import { lstat, readFile, realpath } from 'fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'

import type {
  ChangeReviewFile,
  GitStatus,
  ThreadChangeReview,
} from '../../shared/ipc-contract'
import { FILE_EDIT_TOOLS, isFlowArtifactPath } from '../agent/flow-artifacts'

/** Lines added/deleted vs HEAD for one file (from `GitManager.changeCounts`). */
export interface ChangeCounts {
  added: number | null
  deleted: number | null
  binary: boolean
}

/** One tool call reduced to the file it touched (from `listToolCallPaths`). */
export interface TouchedPath {
  toolName: string
  filePath: string | null
}

export interface BuildThreadChangeReviewInput {
  threadId: string
  /** The absolute root whose working tree is being reviewed. */
  rootId: string
  /** True when that root is the thread's OWN copy, false when it is the project
   *  everyone shares. The file list is identical either way — what changes is
   *  what the words on screen may honestly claim (see `ThreadChangeReview`). */
  ownWorktree: boolean
  /** The worktree's git status, or null when it is not a repository. */
  gitStatus: GitStatus | null
  /** The thread's persisted tool-call paths (absolute file paths). */
  touchedPaths: readonly TouchedPath[]
  /** Root-relative path → line counts. Optional; absent → null counts. */
  counts?: ReadonlyMap<string, ChangeCounts>
  /**
   * The files carried by commits the branch has and its upstream does not.
   *
   * Consulted ONLY when the working tree has nothing — a repo with both
   * uncommitted changes and unpushed commits is still, to the person looking at
   * it, a repo with uncommitted changes, and that is the state where the
   * keep/reject controls mean something. Absent or empty leaves the review in
   * its ordinary `uncommitted` state, empty or not.
   */
  aheadFiles?: readonly AheadFile[]
  /** Commits ahead of upstream (git's own count); 0 when unknowable. */
  aheadCommits?: number
  /**
   * Whether git has an upstream configured for this checkout's branch.
   *
   * Git's own configuration, read from the tree — not the thread store's
   * mirror of where the thread publishes; git wins when the two disagree. Like
   * `aheadCommits`, absent reads as the cautious answer (`false`): a caller
   * that did not look has not established that the branch is aimed anywhere.
   */
  bound?: boolean
}

/** One file carried by an unpushed commit. */
export interface AheadFile {
  filePath: string
  added: number | null
  deleted: number | null
  binary: boolean
}

/** Normalize an OS path to git's forward-slash spelling for comparison. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/**
 * Union the worktree's git status with the thread's touched paths into the
 * review card's file list. Git status is authoritative: a `touchedOnly` file
 * (edited by the agent, no net git change) is emitted with `touchedOnly: true`
 * and never a keep/rejectable state. `flow/` artifacts are filtered out on both
 * sides (they are auto-written and never enter the review, matching
 * EditTracker). Pure — no fs/clock/spawn.
 */
export function buildThreadChangeReview(input: BuildThreadChangeReviewInput): ThreadChangeReview {
  const { threadId, rootId, ownWorktree, gitStatus, touchedPaths, counts } = input
  const files: ChangeReviewFile[] = []
  const seen = new Set<string>()

  for (const change of gitStatus?.changes ?? []) {
    // git filePaths are project-relative; resolve to absolute for the flow gate.
    if (isFlowArtifactPath(rootId, resolve(rootId, change.filePath))) continue
    const count = counts?.get(change.filePath)
    const binary = count?.binary === true
    files.push({
      filePath: change.filePath,
      status: change.state,
      staged: change.staged,
      added: binary ? null : count?.added ?? null,
      deleted: binary ? null : count?.deleted ?? null,
      ...(change.renamedFrom !== undefined ? { renamedFrom: change.renamedFrom } : {}),
      binary,
      touchedOnly: false,
    })
    seen.add(change.filePath)
  }

  // Touched-but-unchanged: the agent edited it, git shows no net change. Only
  // file-editing tools, only inside this root, never a flow/ artifact, never a
  // path git already reported (that one is the real, keep/rejectable entry).
  for (const touched of touchedPaths) {
    if (touched.filePath === null) continue
    if (!FILE_EDIT_TOOLS.has(touched.toolName)) continue
    if (isFlowArtifactPath(rootId, touched.filePath)) continue
    const rel = relative(resolve(rootId), resolve(touched.filePath))
    if (rel === '' || rel.startsWith('..')) continue // outside this worktree
    const posix = toPosix(rel)
    if (seen.has(posix)) continue
    seen.add(posix)
    files.push({
      filePath: posix,
      status: 'modified',
      staged: false,
      added: null,
      deleted: null,
      binary: false,
      touchedOnly: true,
    })
  }

  // Detached HEAD reports an empty branch (`GitStatus.detached`); null is the
  // honest answer there, and the toolbar says so rather than printing a blank.
  const branch =
    gitStatus === null || gitStatus.detached === true || gitStatus.branch.trim() === ''
      ? null
      : gitStatus.branch

  // NOTHING LOOSE, BUT SOMETHING UNPUSHED. The same work one step further
  // along: shown, and shown as finished — the caller renders this state without
  // the keep/reject controls, because there is nothing left to keep or reject.
  const ahead = input.aheadFiles ?? []
  if (files.length === 0 && ahead.length > 0) {
    return {
      threadId,
      rootId,
      ownWorktree,
      branch,
      state: 'committed',
      aheadCommits: input.aheadCommits ?? 0,
      bound: input.bound ?? false,
      files: ahead.map((file) => ({
        filePath: file.filePath,
        status: 'modified' as const,
        staged: true,
        added: file.binary ? null : file.added,
        deleted: file.binary ? null : file.deleted,
        binary: file.binary,
        touchedOnly: false,
      })),
    }
  }

  return {
    threadId,
    rootId,
    ownWorktree,
    branch,
    state: 'uncommitted',
    aheadCommits: input.aheadCommits ?? 0,
    bound: input.bound ?? false,
    files,
  }
}

/** The git surface the assembly needs — a structural slice of GitManager. */
export interface ChangeReviewGit {
  status(rootPath: string): Promise<GitStatus | null>
  changeCounts(rootPath: string): Promise<Map<string, ChangeCounts>>
  /** Files in commits the branch has and its upstream does not. */
  aheadFiles(rootPath: string): Promise<AheadFile[]>
  /** The upstream ref this checkout's branch is aimed at, or null for none. */
  upstreamOf(rootPath: string): Promise<string | null>
  /**
   * Every untracked file under one untracked DIRECTORY (#1040's own helper).
   *
   * Git reports a wholly-untracked directory as a single `?? dir/` entry, which
   * this surface drew as one row with no counts — and ticking it staged files
   * that had never been on screen. The Source Control panel can expand such a
   * row on demand; a review cannot wait to be asked, because the list a person
   * audits has to be the list they commit.
   */
  listUntrackedInDir(rootPath: string, dirPath: string): Promise<string[]>
}

/** The thread surface the assembly needs — a structural slice of ThreadStore. */
export interface ChangeReviewThreads {
  /**
   * The tree this thread's work lands in, and whether it is the thread's OWN
   * copy. Null only when the thread names no root at all.
   *
   * IT USED TO BE `worktreePathFor`, RETURNING NULL FOR A THREAD WITHOUT A COPY,
   * and that was correct for exactly as long as every thread got one. The
   * worktree gate (loops only) made the no-copy thread the NORMAL case
   * overnight, and this quietly became "no review for almost every
   * conversation" — the review surface reporting nothing to review while the
   * Source Control panel two columns away listed the same files.
   */
  reviewRootFor(threadId: string): { rootPath: string; ownWorktree: boolean } | null
  listToolCallPaths(threadId: string): Array<{ toolName: string; filePath: string | null }>
}

/**
 * Resolve a thread's change review: find the tree its work lands in, read that
 * tree's git status + line counts + the thread's touched paths, and union them.
 * Returns null only when the thread names no root at all. Bounded — a fixed
 * handful of git reads issued in ONE round, never one per file
 * (allowed-pattern #19). Fail-soft on the git side: every one of them degrades
 * to its own "cannot say" answer rather than failing the review.
 */
export async function resolveThreadChangeReview(
  git: ChangeReviewGit,
  threads: ChangeReviewThreads,
  threadId: string,
): Promise<ThreadChangeReview | null> {
  const target = threads.reviewRootFor(threadId)
  if (target === null) return null
  const { rootPath, ownWorktree } = target
  // The upstream read joins the round rather than following it: the review's
  // cost stays one wave of git, and `bound` arrives with everything else.
  const [gitStatus, counts, aheadFiles, upstream] = await Promise.all([
    git.status(rootPath).catch(() => null),
    git.changeCounts(rootPath).catch(() => new Map<string, ChangeCounts>()),
    git.aheadFiles(rootPath).catch(() => [] as AheadFile[]),
    git.upstreamOf(rootPath).catch(() => null),
  ])
  // A DIRECTORY IS NOT A CHANGE; THE FILES IN IT ARE. One extra round, and only
  // when git actually rolled something up — there are normally none of these
  // and never many, so the "fixed handful of reads, never one per file" rule
  // above still holds (it is one read per untracked DIRECTORY).
  const expandedStatus = await withoutWorktreeLinks(
    rootPath,
    ownWorktree,
    await expandUntrackedDirs(git, rootPath, gitStatus),
  )
  const touchedPaths = threads.listToolCallPaths(threadId)
  return buildThreadChangeReview({
    threadId,
    rootId: rootPath,
    ownWorktree,
    gitStatus: expandedStatus,
    touchedPaths,
    counts,
    aheadFiles,
    aheadCommits: gitStatus?.ahead ?? 0,
    bound: upstream !== null,
  })
}


/**
 * Replace every rolled-up `?? dir/` entry with the files inside it.
 *
 * Fail-soft, like every other git read here: a directory whose listing fails
 * keeps its rolled-up row rather than vanishing from the review — a row that
 * over-states one change is recoverable, a change that is not on screen at all
 * is not.
 */
async function expandUntrackedDirs(
  git: ChangeReviewGit,
  rootPath: string,
  status: GitStatus | null,
): Promise<GitStatus | null> {
  if (status === null) return null
  const rollups = status.changes.filter(
    (change) => change.state === 'untracked' && change.filePath.endsWith('/'),
  )
  if (rollups.length === 0) return status

  const listed = await Promise.all(
    rollups.map((change) =>
      git
        .listUntrackedInDir(rootPath, change.filePath)
        .catch(() => [] as string[])
        .then((files) => ({ change, files })),
    ),
  )
  const expansions = new Map(listed.map(({ change, files }) => [change.filePath, files]))

  const changes = status.changes.flatMap((change) => {
    const files = expansions.get(change.filePath)
    if (files === undefined || files.length === 0) return [change]
    return files.map((filePath) => ({ ...change, filePath }))
  })
  return { ...status, changes }
}


/**
 * Drop the untracked links the worktree's own link step put there.
 *
 * Every thread worktree has `node_modules`, `flow`, `.claude` (…) linked in
 * from the main checkout (`linkUntracked` in `src/cli/loop/worktree.ts`). A
 * project whose `.gitignore` does not cover them — or covers `.claude/` with a
 * trailing slash, which matches DIRECTORIES only, and a symlink is not one —
 * reports each as `??`, and this card listed it as something the agent made.
 * It is infrastructure, for the reason `losableWork` gives there: the target is
 * the main checkout's, and nothing about it is this thread's work.
 *
 * NOT "every symlink". A link the agent created (`src/foo -> ../bar`) is work,
 * and stays listed. A link is dropped only when it resolves to the very same
 * entry of the main checkout — `<worktree>/<rel>` and `<main>/<rel>` are one
 * file — which is exactly the shape the link step produces and nothing an agent
 * plausibly writes by accident. (Copied `.env*` files are real files and are
 * not touched here.)
 *
 * Only for a thread's OWN worktree: the project tree has no link step. Cheap
 * and async (allowed-pattern #19) — one `lstat` per untracked entry, and the
 * two `realpath`s only for the entries that are links. Fail-soft toward
 * SHOWING: any read that fails keeps the row.
 */
async function withoutWorktreeLinks(
  rootPath: string,
  ownWorktree: boolean,
  status: GitStatus | null,
): Promise<GitStatus | null> {
  if (status === null || !ownWorktree) return status
  const untracked = status.changes.filter((change) => change.state === 'untracked')
  if (untracked.length === 0) return status
  const mainRoot = await mainCheckoutOf(rootPath)
  if (mainRoot === null) return status

  const linked = await Promise.all(
    untracked.map(async (change) => {
      const rel = change.filePath.replace(/\/$/, '')
      const isLink = await isWorktreeLink(rootPath, mainRoot, rel)
      return isLink ? change.filePath : null
    }),
  )
  const drop = new Set(linked.filter((path): path is string => path !== null))
  if (drop.size === 0) return status
  return { ...status, changes: status.changes.filter((change) => !drop.has(change.filePath)) }
}

/** Whether `<worktree>/<rel>` is a symlink to the main checkout's own `<rel>`. */
async function isWorktreeLink(worktree: string, mainRoot: string, rel: string): Promise<boolean> {
  if (rel.length === 0) return false
  try {
    const here = join(worktree, rel)
    if (!(await lstat(here)).isSymbolicLink()) return false
    const [target, theirs] = await Promise.all([realpath(here), realpath(join(mainRoot, rel))])
    return target === theirs
  } catch {
    // Dangling link, missing main entry, unreadable path: not provably the
    // link step's — keep the row (over-stating beats vanishing).
    return false
  }
}

/**
 * The main checkout a linked git worktree was cut from, or null when `root` is
 * not one. Read from git's own files — `<root>/.git` is a `gitdir:` pointer for
 * a linked worktree, and that gitdir's `commondir` names the shared `.git` —
 * so no process is spawned.
 */
async function mainCheckoutOf(root: string): Promise<string | null> {
  try {
    const pointer = (await readFile(join(root, '.git'), 'utf8')).trim()
    const match = /^gitdir:[ \t]*(.+)$/m.exec(pointer)
    if (match === null) return null
    const gitDir = resolve(root, match[1].trim())
    const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    const commonDir = resolve(gitDir, common)
    return basename(commonDir) === '.git' ? dirname(commonDir) : null
  } catch {
    // `.git` is a directory (a main checkout, not a worktree) or unreadable.
    return null
  }
}
