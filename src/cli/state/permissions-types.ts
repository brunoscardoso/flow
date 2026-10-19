/**
 * Types for the permissions-suggest verb (`planflow-ai permissions suggest`).
 *
 * These interfaces define the shared vocabulary between the approval-history
 * miners (IDE DB permission rules + tool calls, Claude Code transcripts) and
 * the suggestion report. The pipeline is: sources emit `ApprovalObservation`s
 * (already normalized into a command family), the aggregator folds them into
 * `SuggestCandidate`s (threshold: >= 2 distinct approvals per family), and the
 * hygiene gate demotes rejects into `SkippedCandidate`s — every skip carries
 * its reason so the dry-run report is fully explainable. Sources that cannot
 * be read fail soft and are listed in `unavailableSources`, never thrown.
 */

/** Where an approval observation was mined from. */
export type ApprovalSource = 'permission-rules' | 'tool-calls' | 'transcripts';

/**
 * A single approved tool invocation observed in history, normalized into a
 * command family (e.g. raw `git status -sb` -> family `git status`).
 */
export interface ApprovalObservation {
  /** Tool name as recorded in history (e.g. `Bash`, `WebFetch`). */
  tool: string;
  /** Normalized command family the raw invocation belongs to. */
  family: string;
  /** The original, un-normalized invocation — kept for the report. */
  raw: string;
  /** Which miner produced this observation. */
  source: ApprovalSource;
  /** ISO-8601 timestamp of the approval, as recorded by the source. */
  at: string;
}

/**
 * A command family that cleared the approval threshold and the hygiene gate,
 * rendered as a concrete `.claude/settings.json` allow rule.
 */
export interface SuggestCandidate {
  /** Tool the rule applies to (e.g. `Bash`). */
  tool: string;
  /** Normalized command family (e.g. `git status`). */
  family: string;
  /** Rendered allow rule (e.g. `Bash(git status *)`). */
  rule: string;
  /** Count of distinct approvals backing this candidate. */
  approvals: number;
  /** Distinct sources that observed approvals for this family. */
  sources: string[];
}

/** A candidate rejected by the hygiene gate, with its human-readable reason. */
export interface SkippedCandidate {
  /** The rendered rule (or family) that was considered and rejected. */
  candidate: string;
  /** Why the hygiene gate refused it — always reported, never silent. */
  reason: string;
}

/** The full dry-run/write report — deterministic for the same inputs. */
export interface SuggestReport {
  /** Candidates that survived threshold + hygiene, ready to merge. */
  suggested: SuggestCandidate[];
  /** Every rejected candidate with its hygiene reason. */
  skipped: SkippedCandidate[];
  /** Sources that could not be read (fail-soft, e.g. missing IDE DB). */
  unavailableSources: string[];
}
