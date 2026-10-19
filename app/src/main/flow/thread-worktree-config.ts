// Per-project reads of the two worktree settings main needs at run time
// (thread-worktrees Phase 5, task 5.4; thread_remote_binding).
//
// A thread's own checkout is a git worktree, and a git worktree is a second
// directory holding the same project. Most toolchains do not notice. Some do,
// and they break in ways the app cannot repair from the outside: absolute paths
// baked into a build, an Xcode workspace that resolves its own root, a monorepo
// whose package manager refuses a linked `node_modules`. For those projects the
// right answer is not a workaround — it is off.
//
// DEFAULT ON, and the default is the point: a project that has never heard of
// this setting gets thread worktrees, and a project that has turned it off is
// byte-identical to the app before the feature existed (nothing is created, so
// `worktree_path` stays null, so every downstream consumer takes the path it
// already took).
//
// THESE ARE NOW VIEWS, NOT RULES. Both questions are answered by
// `worktree-settings.ts`, which knows about all three layers — the project's
// file, the person's app-wide defaults, and the built-in behaviour — so a
// default set once in the settings panel reaches the session path and the base
// refresh without either of them learning a second precedence rule
// (allowed-pattern #14). The signatures are unchanged; only where the answer
// comes from is.
//
// The key names are INTERNAL. They appear in `worktree-settings.ts` and nowhere
// a person reads (forbidden-pattern #12): the user turns this off with a
// labelled switch in Flow settings, never by being told to type a config key.

import {
  DEFAULT_REMOTE,
  WORKTREE_FLOWCONFIG_KEYS,
  resolveWorktreeSettings,
  readWorktreeSettings,
} from './worktree-settings'
import type { WorktreeDefaults } from '../../shared/ipc-contract'

/** The `flow/.flowconfig` key. Internal — never rendered. */
export const THREAD_WORKTREES_KEY = WORKTREE_FLOWCONFIG_KEYS.threadWorktrees

/** The `flow/.flowconfig` key naming the remote a project publishes to. */
export const REMOTE_KEY = WORKTREE_FLOWCONFIG_KEYS.remote

export { DEFAULT_REMOTE }

/**
 * Whether thread worktrees are enabled given an already-parsed flowconfig.
 *
 * The PROJECT LAYER ONLY — this overload exists for callers that already hold a
 * project's config and have no store to ask, so it resolves against the
 * built-ins alone. Only the literal `false` turns worktrees off; an absent key,
 * a blank value, a typo, or a `no` all mean on, because the failure mode of
 * guessing "off" is a feature that silently stops working for a project that
 * never asked.
 */
export function threadWorktreesEnabledIn(config: Record<string, string>): boolean {
  return resolveWorktreeSettings({ projectRaw: config, globalDefaults: {} }).settings
    .threadWorktrees.value
}

/** The configured remote given an already-parsed flowconfig (project layer only). */
export function remoteIn(config: Record<string, string>): string {
  return resolveWorktreeSettings({ projectRaw: config, globalDefaults: {} }).settings.remote.value
}

/** Injectable reader so tests never touch a real project directory. */
export interface ThreadWorktreeConfigDeps {
  readFile?: (path: string) => Promise<string>
  /**
   * The person's app-wide worktree defaults.
   *
   * Passed in rather than reached for: these functions are called from the
   * session path and the base refresh, both of which already receive their
   * collaborators from `index.ts`, and a module-level handle on the settings
   * store would make every test that forgets to stub it read the real database.
   * Absent → the project and the built-ins answer, as they did before defaults
   * existed.
   */
  globalDefaults?: () => Partial<WorktreeDefaults>
}

/** Turn this module's deps into the resolver's, dropping nothing. */
function settingsDepsFrom(deps: ThreadWorktreeConfigDeps): {
  readFile?: (path: string) => Promise<string>
  globalDefaults?: () => Partial<WorktreeDefaults>
} {
  return { readFile: deps.readFile, globalDefaults: deps.globalDefaults }
}

/**
 * Whether the project at `rootPath` wants its threads to own checkouts.
 *
 * Fail-soft on purpose: a missing or unreadable `flow/.flowconfig` is a project
 * that has expressed no opinion, and the layers below answer.
 */
export async function readThreadWorktreesEnabled(
  rootPath: string,
  deps: ThreadWorktreeConfigDeps = {},
): Promise<boolean> {
  const { settings } = await readWorktreeSettings(rootPath, settingsDepsFrom(deps))
  return settings.threadWorktrees.value
}

/**
 * Which remote the project at `rootPath` talks to.
 *
 * READ, NEVER DECIDED. This answers "where would a refresh look", which is a
 * question about configuration — it is NOT a binding, and nothing here may be
 * mistaken for one: choosing where a thread PUBLISHES is a person's decision
 * made at the first push, and a default that quietly stood in for it would be
 * exactly the guess this feature exists to refuse.
 */
export async function readProjectRemote(
  rootPath: string,
  deps: ThreadWorktreeConfigDeps = {},
): Promise<string> {
  const { settings } = await readWorktreeSettings(rootPath, settingsDepsFrom(deps))
  return settings.remote.value
}
