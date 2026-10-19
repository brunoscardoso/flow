// worktree-settings — THE ONE read path for how a project's thread worktrees
// are configured (allowed-pattern #14).
//
// Three layers answer the same ten questions, in one order that never varies:
//
//   the project's flow/.flowconfig  →  the person's app-wide defaults  →  built-in
//
// and the built-in layer is not a design choice, it is a PROMISE: every value in
// WORKTREE_BUILTIN_DEFAULTS is what the app already did before any of this
// existed. A project that never opens the settings panel, and a person who never
// sets a default, get byte-for-byte the behaviour they had yesterday.
//
// PROVENANCE COMES FROM KEY PRESENCE. `parseFlowconfigKeys` reports the keys a
// file literally contains, which is the only way to tell "this project chose
// origin" from "nobody has been asked" — two states that produce the same value
// and must not render the same way. `parseFlowConfig` cannot answer that: it
// returns a fully-defaulted object in which both look identical.
//
// The resolver is PURE — text in, decisions out, no filesystem — so the whole
// precedence table is testable without a project on disk. `readWorktreeSettings`
// at the bottom is the only part that touches a file.
//
// RENAMED KEYS ARE READ UNDER BOTH NAMES. Four keys were once `workspace_*`;
// the project layer reads the new spelling and falls back to the old one
// (`worktree-config-aliases.json`, shared with the CLI). Old names are read
// forever; while both are written, the OLD one wins when both are present.

import { promises as fsPromises } from 'fs'
import { join } from 'path'

import { parseFlowconfigKeys } from '../../shared/flowconfig-merge'
import { DEFAULT_WORKTREE_CAP } from '../worktree/worktree-cap'
import { legacyFlowconfigKeyOf } from '../../shared/worktree-config-aliases'
import type {
  ResolvedWorktreeSetting,
  ResolvedWorktreeSettings,
  ResolvedWorktreeSettingsResult,
  WorktreeDefaults,
  WorktreeSettingKey,
  WorktreeSettingSource,
  WorktreeStart,
} from '../../shared/ipc-contract'

/** Where the project layer lives, relative to a project root. */
const FLOWCONFIG_RELPATH = join('flow', '.flowconfig')

/** Every setting, in the order a panel reads best. */
export const WORKTREE_SETTING_KEYS: readonly WorktreeSettingKey[] = [
  'threadWorktrees',
  'remote',
  'remoteBranchPattern',
  'baseBranch',
  'worktreeStart',
  'baseRefresh',
  'baseRefreshTimeoutMs',
  'worktreeCap',
  'worktreeSetup',
  'worktreeSetupTimeoutMs',
]

/**
 * The `.flowconfig` spelling of each setting — the ONLY place the file's key
 * names appear outside the file itself. These are the CURRENT names; the old
 * `workspace_*` spellings live only in the shared alias table.
 *
 * `baseBranch` is stored as `branch` and stays that way. Renaming it would be a
 * one-line change here and a silent behaviour change in every project that has
 * already written the key, which is exactly the trade this feature refuses: the
 * key is a file format, the label is what a person reads, and only the second
 * one is allowed to improve.
 */
export const WORKTREE_FLOWCONFIG_KEYS: Record<WorktreeSettingKey, string> = {
  threadWorktrees: 'thread_worktrees',
  remote: 'remote',
  remoteBranchPattern: 'remote_branch_pattern',
  baseBranch: 'branch',
  worktreeStart: 'worktree_start',
  baseRefresh: 'base_refresh',
  baseRefreshTimeoutMs: 'base_refresh_timeout_ms',
  worktreeCap: 'worktree_cap',
  worktreeSetup: 'worktree_setup',
  worktreeSetupTimeoutMs: 'worktree_setup_timeout_ms',
}

/** The remote every git conversation uses when nobody has said otherwise —
 *  `origin`, because that is what `git clone` writes. */
export const DEFAULT_REMOTE = 'origin'

/**
 * Longest the base refresh may take before the cut goes ahead without it.
 *
 * THE CEILING IS THE WHOLE REASON THAT STEP EXISTS SEPARATELY. `worktree create`
 * is called with `--no-fetch` because a fetch is bounded by nothing the app
 * knows — a slow VPN, a remote that is down, an SSH key waiting on a passphrase
 * — and a worktree that hangs behind one is worse than a worktree cut a few
 * commits behind. Eight seconds is comfortably more than a healthy fetch of one
 * branch takes and comfortably less than a person will wait without being told
 * why. (Lives here rather than beside its use so that making it configurable
 * could not put the number in two places; `thread-worktree.ts` re-exports it.)
 */
export const BASE_REFRESH_TIMEOUT_MS = 8_000

/**
 * The bounds no configured wait may leave.
 *
 * CLAMPED HERE, NOT WHERE IT IS TYPED. The CLI refuses an out-of-range number
 * and the settings panel will bound its input, and neither of those protects
 * the fetch: `.flowconfig` is hand-editable by design, so a `600000` typed into
 * it in a text editor reaches this code having passed no validator at all. The
 * clamp is the last gate before a timeout becomes a `setTimeout`, which makes it
 * the only one that cannot be bypassed — and reopening an unbounded wait is the
 * one failure this setting must never be able to cause.
 */
export const MIN_BASE_REFRESH_TIMEOUT_MS = 1_000
export const MAX_BASE_REFRESH_TIMEOUT_MS = 30_000

/**
 * The bounds no configured worktree limit may leave.
 *
 * ZERO IS THE ONE THAT MATTERS. A ceiling of 0 does not mean "keep none", it
 * means every landed copy is above the line on every sweep — a setting that
 * quietly turns the reclaimer into a deleter of everything it is allowed to
 * touch. One is the smallest number that still describes a ceiling. The upper
 * bound is not a disk policy: past a hundred copies the ceiling has stopped
 * being the thing keeping the disk in order, and a typo with three extra zeroes
 * should not read as a considered choice. `.flowconfig` is hand-editable by
 * design, so like the refresh wait this is clamped where it is READ.
 */
export const MIN_WORKTREE_CAP = 1
export const MAX_WORKTREE_CAP = 100

/**
 * Longest a project's setup command may take before the worktree is used
 * without it.
 *
 * MINUTES, NOT SECONDS, and that is the whole difference from the refresh
 * ceiling above. `npm ci` on a real project legitimately takes minutes, so a
 * ceiling sized like the fetch's eight seconds would turn a working setup into
 * a timeout on every cut. Five is comfortably more than a cold install and
 * comfortably less than a person will sit through without concluding the app
 * has hung; the floor is one second because a ceiling below that cannot
 * complete any command at all.
 *
 * Clamped where it is READ, like the refresh wait, because `.flowconfig` is
 * hand-editable by design and a number typed into it has passed no validator.
 */
export const SETUP_TIMEOUT_MS = 5 * 60_000
export const MIN_SETUP_TIMEOUT_MS = 1_000
export const MAX_SETUP_TIMEOUT_MS = 30 * 60_000

/** The ten answers, without their provenance. */
export interface WorktreeSettingValues {
  threadWorktrees: boolean
  remote: string
  remoteBranchPattern: string | null
  baseBranch: string | null
  worktreeStart: WorktreeStart
  baseRefresh: boolean
  baseRefreshTimeoutMs: number
  worktreeCap: number
  worktreeSetup: string | null
  worktreeSetupTimeoutMs: number
}

/**
 * What the app did before any of these settings existed.
 *
 * Read this table as the regression test it is: worktrees on (thread-worktrees
 * shipped on by default), `origin` (git's own), no naming pattern (a thread
 * suggests its own branch name), no base branch (whatever the project has open),
 * start `here` (the worktree begins where the project already is), refresh on
 * at eight seconds. Change a line and you have changed what an untouched
 * project does.
 */
export const WORKTREE_BUILTIN_DEFAULTS: WorktreeSettingValues = {
  threadWorktrees: true,
  remote: DEFAULT_REMOTE,
  remoteBranchPattern: null,
  baseBranch: null,
  // FROM THE BASE BRANCH, NOT FROM WHEREVER THE CHECKOUT HAPPENS TO BE.
  //
  // This was `here`, so a new conversation inherited the branch the project
  // folder was sitting on — which is usually another conversation's branch, or
  // a branch somebody checked out to read something. A thread's branch belongs
  // to that thread (user, 2026-09-17: "if the user are in a thread and switch
  // the branch, that branch should be only on that thread, new thread should
  // always start from main"). `trunk` is the project's base branch — the
  // `branch` key when set, the repository's own default otherwise — which is
  // the only starting point that means the same thing tomorrow.
  worktreeStart: { kind: 'trunk' },
  baseRefresh: true,
  baseRefreshTimeoutMs: BASE_REFRESH_TIMEOUT_MS,
  worktreeCap: DEFAULT_WORKTREE_CAP,
  // NOTHING, AND THAT IS THE PROMISE. A project that never sets this runs no
  // command, waits no longer, and keeps its `node_modules` symlink — the whole
  // feature is invisible until somebody asks for it.
  worktreeSetup: null,
  worktreeSetupTimeoutMs: SETUP_TIMEOUT_MS,
}

// ── Warnings ──────────────────────────────────────────────────────────────

/**
 * How each setting is NAMED TO A PERSON.
 *
 * Not its config key and not its field name (forbidden-pattern #12): a warning
 * that said "worktree_start could not be read" would hand the reader the app's
 * internals and ask them to finish the job in a text editor.
 */
const WORKTREE_SETTING_LABELS: Record<WorktreeSettingKey, string> = {
  threadWorktrees: 'the setting that lets a conversation work on its own branch',
  remote: 'the remote',
  remoteBranchPattern: 'the branch name pattern',
  baseBranch: 'the base branch',
  worktreeStart: "where a new conversation's branch starts",
  baseRefresh: 'the base refresh setting',
  baseRefreshTimeoutMs: 'the base refresh wait',
  worktreeCap: 'the limit on conversations with their own branch',
  worktreeSetup: 'the command that prepares a new conversation',
  worktreeSetupTimeoutMs: 'the wait for preparing a new conversation',
}

/** The two layers a person can have written; the third is the app itself. */
type WrittenLayer = 'project' | 'global'

/**
 * What was used instead — the layer that ANSWERED, not the one below the one
 * that failed. A project value nobody can read falls to the person's default
 * only when they have one; telling someone with no default that Flow used it
 * is a sentence about a setting that does not exist.
 */
const FELL_BACK_TO: Record<WorktreeSettingSource, string> = {
  project: 'the value set for this project',
  global: 'your default',
  default: 'the built-in behaviour',
}

/** Where the unusable value was written, in a person's words. */
const WRITTEN_IN: Record<WrittenLayer, string> = {
  project: 'for this project',
  global: 'in your defaults',
}

function unreadableWarning(
  key: WorktreeSettingKey,
  layer: WrittenLayer,
  usedInstead: WorktreeSettingSource,
): string {
  return `Flow doesn't understand ${WORKTREE_SETTING_LABELS[key]} set ${WRITTEN_IN[layer]}, so it's using ${FELL_BACK_TO[usedInstead]} instead.`
}

// ── Value grammar (mirrors the CLI parser, deliberately) ──────────────────

/**
 * Booleans are the two literal words and nothing else.
 *
 * The same grammar `extractBoolean` uses in `src/cli/state/flowconfig-parser.ts`
 * — one file, two readers, and a `yes` that meant one thing to the CLI and
 * another to the app would be a setting nobody could reason about. Anything else
 * is unreadable rather than falsey: a project that typed `no` gets the layer
 * below plus a sentence saying so, which is the honest outcome and the one that
 * preserves today's behaviour (`thread_worktrees: no` has always meant on).
 */
function parseBoolean(raw: string): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

/** A name is any non-blank word; blanks never reach a parser (see `rawFor`). */
function parseName(raw: string): string {
  return raw
}

/**
 * `here` | `trunk` | `branch:<name>` — and deliberately not `checkout:<name>`.
 *
 * A `checkout` start TAKES a branch, and a branch can be checked out in exactly
 * one place at a time. As a per-thread choice that is fine; as a DEFAULT it
 * would mean the second thread to start always fails, so the kind that cannot
 * be shared is not offered as the thing every thread does.
 */
function parseWorktreeStart(raw: string): WorktreeStart | undefined {
  if (raw === 'here') return { kind: 'here' }
  if (raw === 'trunk') return { kind: 'trunk' }
  const branch = raw.startsWith('branch:') ? raw.slice('branch:'.length).trim() : ''
  return branch === '' ? undefined : { kind: 'branch', branch }
}

/** Digits only, like the CLI's `extractNumber`. Clamping happens in the resolver. */
function parseMilliseconds(raw: string): number | undefined {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined
}

/** Whole seconds, for a sentence a person reads. */
function seconds(ms: number): string {
  const value = ms / 1_000
  return `${Number.isInteger(value) ? value : value.toFixed(1)} seconds`
}

// ── The resolver ──────────────────────────────────────────────────────────

export interface WorktreeSettingsInput {
  /**
   * The project layer as KEYS THAT ARE LITERALLY PRESENT (`parseFlowconfigKeys`),
   * not a parsed-and-defaulted config. Presence is the provenance.
   */
  projectRaw: Record<string, string>
  /** The person's app-wide defaults; a missing key is a default nobody set. */
  globalDefaults: Partial<WorktreeDefaults>
}

/**
 * The raw text one layer offers for one setting, or null when it offers none.
 *
 * A BLANK VALUE READS AS ABSENT. `remote:` with nothing after it is a key the
 * parser cannot get a value out of either, so treating it as a written choice
 * would let an empty line override a default with nothing — and would report the
 * project as the source of a value it never supplied.
 */
function rawFor(
  key: WorktreeSettingKey,
  layer: WrittenLayer,
  input: WorktreeSettingsInput,
): string | null {
  if (layer === 'global') return present(input.globalDefaults[key])
  // The OLD spelling first while both are written: this build writes both with
  // the same value, a build older than the rename writes only the old one — so
  // the old key is always current (the same rule as readAliasedKey). A blank
  // key falls through exactly as a missing one does.
  const fileKey = WORKTREE_FLOWCONFIG_KEYS[key]
  const legacy = legacyFlowconfigKeyOf(fileKey)
  const old = legacy === undefined ? null : present(input.projectRaw[legacy])
  return old !== null ? old : present(input.projectRaw[fileKey])
}

/** A value with something in it, trimmed — or null for absent and blank alike. */
function present(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Walk the layers for one setting: the first that supplies a value Flow can
 * read wins; one that supplies a value it cannot read loses AND says so.
 */
function resolveOne<T>(
  key: WorktreeSettingKey,
  parse: (raw: string, layer: WrittenLayer, warnings: string[]) => T | undefined,
  builtin: T,
  input: WorktreeSettingsInput,
  warnings: string[],
): ResolvedWorktreeSetting<T> {
  // A warning names what was used INSTEAD, and that is not known until the
  // walk is over — so the layers that failed are remembered and told last.
  const unreadable: WrittenLayer[] = []
  const answer = (resolved: ResolvedWorktreeSetting<T>): ResolvedWorktreeSetting<T> => {
    for (const layer of unreadable) warnings.push(unreadableWarning(key, layer, resolved.source))
    return resolved
  }
  for (const layer of ['project', 'global'] as const) {
    const raw = rawFor(key, layer, input)
    if (raw === null) continue
    const parsed = parse(raw, layer, warnings)
    if (parsed === undefined) {
      unreadable.push(layer)
      continue
    }
    return answer({ value: parsed, source: layer })
  }
  return answer({ value: builtin, source: 'default' })
}

/**
 * Every worktree setting in effect for one project, with per-key provenance.
 *
 * Pure. Give it the project's present keys and the person's defaults and it
 * decides; it reads nothing, writes nothing, and cannot fail.
 */
export function resolveWorktreeSettings(
  input: WorktreeSettingsInput,
): ResolvedWorktreeSettingsResult {
  const warnings: string[] = []

  /** Clamped where it is read, and warned about where it was written. */
  const boundedMilliseconds = (
    raw: string,
    layer: WrittenLayer,
    into: string[],
  ): number | undefined => {
    const parsed = parseMilliseconds(raw)
    if (parsed === undefined) return undefined
    const clamped = Math.min(
      MAX_BASE_REFRESH_TIMEOUT_MS,
      Math.max(MIN_BASE_REFRESH_TIMEOUT_MS, parsed),
    )
    if (clamped !== parsed) {
      into.push(
        `The base refresh wait set ${WRITTEN_IN[layer]} is outside what Flow allows, so it waits ${seconds(clamped)} instead.`,
      )
    }
    return clamped
  }

  /** Clamped where it is read, and warned about where it was written. */
  const boundedCap = (raw: string, layer: WrittenLayer, into: string[]): number | undefined => {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(parsed)) return undefined
    const clamped = Math.min(MAX_WORKTREE_CAP, Math.max(MIN_WORKTREE_CAP, parsed))
    if (clamped !== parsed) {
      into.push(
        `The limit on conversations with their own branch set ${WRITTEN_IN[layer]} is outside what Flow allows, so it keeps ${clamped === 1 ? '1 copy' : `${clamped} copies`} instead.`,
      )
    }
    return clamped
  }

  /** Clamped where it is read, and warned about where it was written. */
  const boundedSetupWait = (raw: string, layer: WrittenLayer, into: string[]): number | undefined => {
    const parsed = parseMilliseconds(raw)
    if (parsed === undefined) return undefined
    const clamped = Math.min(MAX_SETUP_TIMEOUT_MS, Math.max(MIN_SETUP_TIMEOUT_MS, parsed))
    if (clamped !== parsed) {
      into.push(
        `The wait for preparing a new conversation set ${WRITTEN_IN[layer]} is outside what Flow allows, so it waits ${seconds(clamped)} instead.`,
      )
    }
    return clamped
  }

  const settings: ResolvedWorktreeSettings = {
    threadWorktrees: resolveOne(
      'threadWorktrees',
      parseBoolean,
      WORKTREE_BUILTIN_DEFAULTS.threadWorktrees,
      input,
      warnings,
    ),
    remote: resolveOne('remote', parseName, WORKTREE_BUILTIN_DEFAULTS.remote, input, warnings),
    remoteBranchPattern: resolveOne<string | null>(
      'remoteBranchPattern',
      parseName,
      WORKTREE_BUILTIN_DEFAULTS.remoteBranchPattern,
      input,
      warnings,
    ),
    baseBranch: resolveOne<string | null>(
      'baseBranch',
      parseName,
      WORKTREE_BUILTIN_DEFAULTS.baseBranch,
      input,
      warnings,
    ),
    worktreeStart: resolveOne(
      'worktreeStart',
      parseWorktreeStart,
      WORKTREE_BUILTIN_DEFAULTS.worktreeStart,
      input,
      warnings,
    ),
    baseRefresh: resolveOne(
      'baseRefresh',
      parseBoolean,
      WORKTREE_BUILTIN_DEFAULTS.baseRefresh,
      input,
      warnings,
    ),
    baseRefreshTimeoutMs: resolveOne(
      'baseRefreshTimeoutMs',
      boundedMilliseconds,
      WORKTREE_BUILTIN_DEFAULTS.baseRefreshTimeoutMs,
      input,
      warnings,
    ),
    worktreeCap: resolveOne(
      'worktreeCap',
      boundedCap,
      WORKTREE_BUILTIN_DEFAULTS.worktreeCap,
      input,
      warnings,
    ),
    // `parseName` is the identity, and that is the point: Flow runs this string,
    // it does not read it (NFR-2). A blank value never reaches a parser — `rawFor`
    // already treats it as absent — so a key written empty inherits rather than
    // configuring a command that is nothing.
    worktreeSetup: resolveOne<string | null>(
      'worktreeSetup',
      parseName,
      WORKTREE_BUILTIN_DEFAULTS.worktreeSetup,
      input,
      warnings,
    ),
    worktreeSetupTimeoutMs: resolveOne(
      'worktreeSetupTimeoutMs',
      boundedSetupWait,
      WORKTREE_BUILTIN_DEFAULTS.worktreeSetupTimeoutMs,
      input,
      warnings,
    ),
  }

  return { settings, warnings }
}

// ── Reading a real project ────────────────────────────────────────────────

export interface WorktreeSettingsDeps {
  /** Injectable so tests never touch a real project directory. */
  readFile?: (path: string) => Promise<string>
  /**
   * The person's app-wide defaults.
   *
   * A FUNCTION, AND OPTIONAL. The store lives in main and the settings row is a
   * synchronous SQLite read, so a caller that has one passes it and a caller
   * that does not (a test, or a code path that runs before the store exists)
   * resolves against the project and the built-ins alone — which is exactly the
   * behaviour that shipped before defaults existed.
   */
  globalDefaults?: () => Partial<WorktreeDefaults>
}

/**
 * Resolve the worktree settings for the project at `rootPath`.
 *
 * Fail-soft on the file: a missing or unreadable `.flowconfig` is a project that
 * has expressed no opinion, not an error — the defaults answer and the app
 * carries on, the same way every other reader of this file behaves.
 */
export async function readWorktreeSettings(
  rootPath: string,
  deps: WorktreeSettingsDeps = {},
): Promise<ResolvedWorktreeSettingsResult> {
  const readFile = deps.readFile ?? ((path: string) => fsPromises.readFile(path, 'utf-8'))
  let projectRaw: Record<string, string> = {}
  try {
    projectRaw = parseFlowconfigKeys(await readFile(join(rootPath, FLOWCONFIG_RELPATH)))
  } catch {
    // Sanctioned fail-soft — no config, or one we cannot read, is no opinion.
  }
  return resolveWorktreeSettings({
    projectRaw,
    globalDefaults: deps.globalDefaults?.() ?? {},
  })
}
