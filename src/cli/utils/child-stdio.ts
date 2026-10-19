/**
 * How this CLI's verb families run a child process.
 *
 * ONE DECISION, IN ONE PLACE (allowed-pattern #14). Both verb families shell
 * out to git, both catch failures that are expected, and both used to leave
 * `stdio` unset — which meant every child inherited this process's stderr. So a
 * `worktree branches` in a repo with no remote printed three `fatal:` lines and
 * exited 0, and `loop worktree` printed git's checkout chatter immediately
 * before its own success line (#1798). The probes whose failure is CAUGHT are
 * exactly the ones that should say nothing.
 *
 * `pipe` FOR stderr, NOT `ignore`, AND THE DIFFERENCE IS LOAD-BEARING.
 * Discarding it silences the terminal the same way, but it also empties
 * `Error.message`: with `ignore` a failed push throws `Command failed: git push
 * origin a:b` and nothing else, so the reason a refusal carries would lose git's
 * own diagnosis — the very thing #1792 put there. `pipe` captures it, so it
 * reaches the reader as one deliberate line instead of a transcript nobody
 * asked for.
 *
 * `ignore` FOR stdin, because none of these calls is interactive and a child
 * that could block on a terminal read is a verb that could hang.
 */
export const QUIET_CHILD_STDIO = ['ignore', 'pipe', 'pipe'] as const;
