/**
 * Merge-decision guard (#1135).
 *
 * Resolving a conflict is the ENGINEER's decision, not the agent's. An agent
 * asked to resolve conflicts will happily finish the job — `git add`, `git
 * commit`, `git merge --continue` — and once it has, the user's chance to
 * inspect the resolution is gone (live report 2026-07-30: "the agent did
 * everything: added, staged, and committed").
 *
 * A prompt that says "don't commit" is convention, and convention drifts
 * (allowed-pattern #14). This module is the code path: while a merge / rebase /
 * cherry-pick is IN PROGRESS, the commands that ACCEPT or COMPLETE a resolution
 * are never silently auto-allowed by a saved permission rule — they always ask.
 * Outside a conflict state nothing changes, so ordinary commit flows (including
 * /execute-plan's per-task commits) are untouched.
 *
 * Pure and deterministic: the caller supplies the repo state.
 */

/** Shell separators that start a NEW command within one bash invocation. */
const COMMAND_SEPARATORS = /(?:&&|\|\||[;\n|])/

/**
 * Subcommand → the flags that make it a resolution DECISION. An empty set
 * means the subcommand always counts (e.g. `git commit`, `git add`).
 */
const GUARDED_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Records the merge — the irreversible one the report was about.
  ['commit', new Set<string>()],
  // Staging a conflicted file is how git is told "this resolution is accepted".
  ['add', new Set<string>()],
  ['stage', new Set<string>()],
  // Un-resolving / discarding is equally the user's call.
  ['reset', new Set<string>()],
  ['rm', new Set<string>()],
  // Completing or throwing away the whole operation.
  ['merge', new Set(['--continue', '--abort', '--quit'])],
  ['rebase', new Set(['--continue', '--abort', '--skip', '--quit'])],
  ['cherry-pick', new Set(['--continue', '--abort', '--quit'])],
  ['revert', new Set(['--continue', '--abort', '--quit'])],
  ['am', new Set(['--continue', '--abort', '--skip', '--quit'])],
  // Taking a whole side without the user seeing it.
  ['checkout', new Set(['--ours', '--theirs'])],
  ['restore', new Set(['--ours', '--theirs', '--staged'])],
])

/** Leading `VAR=value` assignments and `env`, stripped before reading argv[0]. */
function stripCommandPrefix(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || tokens[index] === 'env')) {
    index += 1
  }
  return tokens.slice(index)
}

/** Whether ONE command segment is a guarded git resolution decision. */
function segmentIsGuarded(segment: string): boolean {
  const tokens = stripCommandPrefix(segment.trim().split(/\s+/).filter((token) => token.length > 0))
  if (tokens.length === 0) return false
  // `git`, `/usr/bin/git`, `git.exe` — match the executable, not a substring
  // (`gitk`, `git-crypt` and friends must not trip the guard).
  const executable = tokens[0].split(/[/\\]/).pop() ?? tokens[0]
  if (executable !== 'git' && executable !== 'git.exe') return false

  // Skip git's own pre-subcommand options (`-C <dir>`, `--no-pager`, …). The
  // ones that take a value consume the next token too.
  const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
  let index = 1
  while (index < tokens.length && tokens[index].startsWith('-')) {
    if (VALUE_FLAGS.has(tokens[index])) index += 1
    index += 1
  }
  const subcommand = tokens[index]
  if (subcommand === undefined) return false

  const triggers = GUARDED_SUBCOMMANDS.get(subcommand)
  if (triggers === undefined) return false
  if (triggers.size === 0) return true
  return tokens.slice(index + 1).some((token) => triggers.has(token.split('=')[0]))
}

/**
 * True when a bash command would ACCEPT or COMPLETE a conflict resolution.
 * Every chained segment is inspected, so `echo ok && git commit -m x` counts —
 * a guard that only reads the first command is trivially side-stepped.
 */
export function isMergeDecisionCommand(command: string): boolean {
  return command
    .split(COMMAND_SEPARATORS)
    .some((segment) => segmentIsGuarded(segment))
}

/** One-line reason shown on the permission card when the guard fires. */
export const MERGE_GUARD_TITLE =
  'Agent wants to accept or complete the merge — resolving conflicts is your call'
