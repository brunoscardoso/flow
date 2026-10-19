// THE GIT TAIL, AFTER THE REVIEW — and why it moved.
//
// Today `/execute-plan` commits, pushes and opens the pull request at the end of
// its own run, which means the review that follows runs on work that has already
// been published. The issue this feature came from puts those steps AFTER the
// review, and that is the better order rather than merely a different one. So
// the chain owns the tail: `/execute-plan` keeps its own for manual and headless
// runs, and a chained run is told not to (see `stagePrompt`). ONE BEHAVIOUR, TWO
// TRIGGERS — written down in both places so a reader who finds two push sites
// does not conclude one of them is a bug.
//
// NOTHING HERE PUSHES. Every step is an injected verb, and in the app both are
// wired to the code path that already exists: `worktree push` and `worktree pr`,
// through `ThreadLandingService`, which is what the landing panel and the board
// loop's Review move already call (allowed-pattern #14). That path refuses an
// UNBOUND branch rather than guessing a remote branch name, and this module
// honours the refusal — it reports it and stops. Guessing here would be exactly
// the wrong-but-valid push that whole feature exists to prevent.
//
// TWO OF THE THREE HONOURED PAUSES MEET HERE, AND THEY MEET IN ORDER. The gate
// comes first: an enforced run whose changeset was rated `high` — or was never
// rated at all — does not publish, and the publish verbs are never called, so
// there is no refusal to trust and nothing to undo. The unbound-branch refusal
// is second, and it belongs to the verb rather than to this module. The third
// pause (the guard classifier's `ask`) is inside the run's own turn, where it
// surfaces as a question on the thread and the chain holds for it.
//
// THE GATE IS NOT IMPLEMENTED HERE EITHER. It is `planflow-ai flow risk --check`
// in the CLI, spawned by the app and called by the `/execute-plan` skill on a
// manual run — ONE code path for both callers (allowed-pattern #14), because a
// gate implemented twice is the bug this feature exists to remove.
//
// Pure orchestration: config in, steps out, no filesystem and no child process.

/** The three project settings the tail reads. */
export interface TailConfig {
  /** Whether the work is committed at all. Owned by the build rung, not here. */
  commit: boolean
  /** Publish the branch. */
  push: boolean
  /** Open a pull request for it. */
  pr: boolean
}

/** Only the literal `true` turns one on — an absent key means "no". */
export function tailConfigFrom(flowconfig: Record<string, string>): TailConfig {
  const on = (key: string): boolean => flowconfig[key]?.trim() === 'true'
  return { commit: on('commit'), push: on('push'), pr: on('pr') }
}

/** What one verb did. `detail` is a sentence somebody reads. */
export interface TailStep {
  ok: boolean
  detail: string
  /** The pull request that is now open, when one is. */
  url?: string
}

export interface TailDeps {
  /**
   * May this work be published? Reads the run's recorded risk assessment; never
   * judges risk itself, and never publishes anything.
   *
   * Wired to the bundled CLI's publish gate. A refusal here means the publish
   * verbs are not called at all.
   */
  checkRisk: (input: RiskGateInput) => Promise<TailStep>
  /** Publish the thread's branch where it is bound. Refuses when unbound. */
  push: (threadId: string) => Promise<TailStep>
  /** Commit, publish and open the pull request. Refuses when unbound. */
  openPullRequest: (threadId: string) => Promise<TailStep>
}

/** What the gate needs to scope its read of the record to THIS run. */
export interface RiskGateInput {
  threadId: string
  /**
   * The chain driving. Its presence is the enforcement: with it a missing or
   * `high` assessment refuses, without it the same verdict is only reported.
   */
  chainId: string
  /**
   * When this chain began, as an instant.
   *
   * THE CHAIN DRIVES A THREAD, NOT A PLAN SLUG, so it cannot name the feature
   * whose assessment it wants — and an unscoped read of a per-project record
   * would let one plan's rating gate, or clear, another's. The instant is the
   * scope: the gate resolves the feature from the newest entry at or after it.
   */
  since: string
}

/** What the tail did, as the chain records and reports it. */
export interface TailOutcome {
  /** True when nothing was asked for, or everything asked for worked. */
  ok: boolean
  /** One sentence, or null when the project asked for nothing. */
  detail: string | null
  /** The pull request, when one was opened. */
  url: string | null
  /**
   * True when the publish was withheld by the gate rather than attempted and
   * failed. The two are different facts and a surface that blurs them tells a
   * person their work broke when in fact it is waiting on their say-so.
   */
  gated: boolean
}

/** The sentence for a project that publishes nothing automatically. */
export const TAIL_NOT_ASKED_FOR = null

/**
 * Run the tail the project asked for.
 *
 * `pr` WINS OVER `push` rather than running both: opening a pull request
 * commits and publishes on the way, so doing the push first would be the same
 * work twice and a second chance to fail. A project with `push` and no `pr`
 * publishes and stops there, which is what it asked for.
 *
 * `commit` IS READ AND NOT ACTED ON. There is no commit verb to call — the
 * work is committed by the rung that did it — so the flag's only job here is to
 * be honest about what this step is: with it off, nothing below has anything to
 * publish, and saying so beats pushing an empty branch.
 */
export async function runGitTail(
  deps: TailDeps,
  input: { threadId: string; config: TailConfig; chainId: string; since: string },
): Promise<TailOutcome> {
  const { config, threadId } = input
  if (!config.push && !config.pr) {
    return { ok: true, detail: TAIL_NOT_ASKED_FOR, url: null, gated: false }
  }
  if (!config.commit) {
    return {
      ok: true,
      detail: 'This project keeps its work local, so nothing was published.',
      url: null,
      gated: false,
    }
  }
  // THE GATE RUNS ONLY WHEN SOMETHING WOULD ACTUALLY BE PUBLISHED. A project
  // that publishes nothing has no seam to guard, and asking anyway would refuse
  // runs that were never going to cross it.
  const gate = await deps.checkRisk({ threadId, chainId: input.chainId, since: input.since })
  if (!gate.ok) {
    return { ok: false, detail: gate.detail, url: null, gated: true }
  }
  const step = config.pr ? await deps.openPullRequest(threadId) : await deps.push(threadId)
  return { ok: step.ok, detail: step.detail, url: step.url ?? null, gated: false }
}
