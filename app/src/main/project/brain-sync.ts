// brain-sync — team-knowledge-sharing Phase 4. When a project is in `separate`
// mode (flow/ is its own nested git repo, gitignored by the parent), the app
// clones the brain on first open, pulls it on later opens, and pushes it on a
// cadence — so the user never runs a git command for the knowledge repo.
//
// The DECISION is pure and unit-tested (decideBrainSync); git is INJECTED
// (allowed-pattern #12) so the clone/pull/push sequence is assertable without a
// real remote. The brain-repo URL comes from the COMMITTED root .gitignore
// header — the only channel a fresh clone reads (flow/.flowconfig is gitignored
// in separate mode). Fail-soft: a sync failure returns { ok:false } and never
// throws, mirroring the provisioner's one-toast-and-move-on contract.

import { existsSync, readFileSync } from 'fs'
import { lstat, readdir, readFile } from 'fs/promises'
import { join } from 'path'

import { parseGitRemote, parseKnowledgeBranch, type GitRemoteRefusal } from '../../shared/git-remote'

export interface BrainPointer {
  url: string
  branch?: string
}

/**
 * The committed pointer, JUDGED. The `.gitignore` it comes from is committed
 * to the code repo, so anyone who can land a commit there writes it — it is
 * untrusted input, and Flow acts on it automatically on open. Only a pointer
 * whose address passes the shared grammar (shared/git-remote.ts) and whose
 * branch is a plain branch name is `valid`; anything else is reported as
 * invalid and must never reach git.
 */
export type ValidatedBrainPointer =
  | { valid: true; url: string; branch?: string }
  | { valid: false; reason: GitRemoteRefusal | 'invalid-branch' }

export function validateBrainPointer(pointer: BrainPointer): ValidatedBrainPointer {
  const remote = parseGitRemote(pointer.url)
  if (!remote.ok) return { valid: false, reason: remote.reason }
  if (pointer.branch === undefined) return { valid: true, url: remote.url }
  const branch = parseKnowledgeBranch(pointer.branch)
  if (!branch.ok) return { valid: false, reason: 'invalid-branch' }
  return { valid: true, url: remote.url, branch: branch.branch }
}

/** The `# Brain repo: <url> [branch]` header the CLI writes in separate mode. */
const BRAIN_POINTER_LINE = /^# Brain repo: (\S+)(?:[ \t]+(\S+))?[ \t\r]*$/m

/**
 * THE pointer grammar — every reader below parses with this, so the app has one
 * definition of the line the CLI writes (src/cli/handlers/shared.ts).
 */
export function parseBrainPointer(gitignoreText: string): BrainPointer | null {
  const match = gitignoreText.match(BRAIN_POINTER_LINE)
  if (!match) return null
  return match[2] ? { url: match[1], branch: match[2] } : { url: match[1] }
}

/** Parse the `# Brain repo: <url> [branch]` line from the committed root
 *  `.gitignore` — the same header the CLI writes in separate mode. Null when
 *  absent (not a separate-mode project, or no pointer yet). Synchronous: for
 *  callers outside main's hot paths; main itself uses `readBrainPointer`. */
export function readBrainPointerFromGitignore(projectRoot: string): BrainPointer | null {
  const path = join(projectRoot, '.gitignore')
  if (!existsSync(path)) return null
  try {
    return parseBrainPointer(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The same pointer, read without blocking the process every window waits on
 * (allowed-pattern #19) and VALIDATED — what the knowledge sync engine asks on
 * every open. A missing or unreadable `.gitignore` is "no pointer": that
 * project never turned sync on, and it must cost nothing more than this one
 * read. A pointer that is there but fails validation is `valid: false`, which
 * the engine reports and never clones, fetches or pushes.
 */
export async function readBrainPointer(projectRoot: string): Promise<ValidatedBrainPointer | null> {
  let text: string
  try {
    text = await readFile(join(projectRoot, '.gitignore'), 'utf8')
  } catch {
    return null
  }
  const pointer = parseBrainPointer(text)
  return pointer === null ? null : validateBrainPointer(pointer)
}

/** What sits at `<projectRoot>/flow`, as far as cloning knowledge into it goes. */
export type FlowFolderState = 'repo' | 'absent' | 'empty' | 'occupied' | 'link'

/**
 * `repo` — it holds a `.git` (a clone, or the knowledge repo started here);
 * `absent` / `empty` — a clone may go there; `link` — a symbolic link (this
 * computer keeps the project's knowledge in its vault: moving it is the
 * person's decision); `occupied` — something else is there, and nothing may be
 * copied over it. Async, never throws.
 */
export async function inspectFlowFolder(projectRoot: string): Promise<FlowFolderState> {
  try {
    if ((await lstat(join(projectRoot, 'flow'))).isSymbolicLink()) return 'link'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'ENOENT' ? 'absent' : 'occupied'
  }
  let entries: string[]
  try {
    entries = await readdir(join(projectRoot, 'flow'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // ENOTDIR: a FILE named flow — occupied, not absent.
    return code === 'ENOENT' ? 'absent' : 'occupied'
  }
  if (entries.includes('.git')) return 'repo'
  return entries.length === 0 ? 'empty' : 'occupied'
}

/**
 * Is `<projectRoot>/flow` an actual clone — i.e. does it hold a `.git`? That is
 * the ONLY thing "cloned" means here (review F3). A non-empty flow/ WITHOUT a
 * `.git` is not a clone (it is a same-repo project, or a broken half-state); the
 * caller then decides `clone`, and cloning into a non-empty dir fails loudly and
 * fail-soft, which correctly surfaces the broken state rather than silently
 * pulling a non-repo.
 */
export function flowIsCloned(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'flow', '.git'))
}

export type BrainSyncAction = 'clone' | 'pull' | 'none'

/**
 * The pure decision: no pointer → nothing to do; pointer + no clone yet → clone;
 * pointer + already cloned → pull. Kept side-effect-free so the whole matrix is
 * unit-tested without git.
 */
export function decideBrainSync(pointer: BrainPointer | null, alreadyCloned: boolean): BrainSyncAction {
  if (!pointer) return 'none'
  return alreadyCloned ? 'pull' : 'clone'
}

/** An async git runner: run argv in cwd; reject on failure. Injected. */
export interface GitRun {
  (args: string[], cwd: string): Promise<void>
}

export interface BrainSyncDeps {
  git: GitRun
  /** Materialize <cwd>/.claude/rules from the brain's flow/rules (Phase 2). */
  materializeRules?: (flowDir: string, projectRoot: string) => void
}

export interface BrainSyncResult {
  action: BrainSyncAction
  ok: boolean
  error?: string
  /** git argv actually run, in order — for assertions. */
  ran: string[][]
}

/**
 * Sync the brain for a project on open: clone or pull per decideBrainSync, then
 * materialize rules. Fail-soft — returns { ok:false } on any error, never throws.
 */
export async function syncBrainOnOpen(
  projectRoot: string,
  deps: BrainSyncDeps,
): Promise<BrainSyncResult> {
  const ran: string[][] = []
  const run = async (args: string[], cwd: string): Promise<void> => {
    ran.push(args)
    await deps.git(args, cwd)
  }
  const read = readBrainPointerFromGitignore(projectRoot)
  // The committed pointer is untrusted input: an address or branch the shared
  // grammar refuses never reaches git (see validateBrainPointer).
  const judged = read === null ? null : validateBrainPointer(read)
  if (judged !== null && !judged.valid) {
    return { action: 'none', ok: false, error: `refused the committed knowledge address (${judged.reason})`, ran }
  }
  const pointer = judged === null ? null : judged
  const action = decideBrainSync(pointer, flowIsCloned(projectRoot))
  const flowDir = join(projectRoot, 'flow')
  try {
    if (action === 'clone' && pointer) {
      const args = ['clone']
      if (pointer.branch) args.push('--branch', pointer.branch)
      args.push('--', pointer.url, 'flow')
      await run(args, projectRoot)
    } else if (action === 'pull') {
      await run(['pull', '--ff-only'], flowDir)
    }
    if (action !== 'none') deps.materializeRules?.(flowDir, projectRoot)
    return { action, ok: true, ran }
  } catch (error) {
    return { action, ok: false, error: error instanceof Error ? error.message : String(error), ran }
  }
}

/** Push the brain (turn-complete / on close). No force. Fail-soft. */
export async function pushBrain(projectRoot: string, deps: BrainSyncDeps): Promise<BrainSyncResult> {
  const ran: string[][] = []
  const flowDir = join(projectRoot, 'flow')
  if (!flowIsCloned(projectRoot)) {
    return { action: 'none', ok: true, ran }
  }
  try {
    ran.push(['push'])
    await deps.git(['push'], flowDir)
    return { action: 'none', ok: true, ran }
  } catch (error) {
    return { action: 'none', ok: false, error: error instanceof Error ? error.message : String(error), ran }
  }
}
