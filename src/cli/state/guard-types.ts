/**
 * Type vocabulary for the guarded-autopilot decision core (#653).
 *
 * A `GuardAction` names one dangerous seam an autonomous `/execute-plan` run
 * is about to cross; `classifyGuardAction` (guard-classifier.ts) judges it by
 * irreversibility/blast-radius into a `GuardDecision`. Pure types — no I/O,
 * no model call: the haiku `consult` lives in the skill, not in this layer.
 */

/**
 * Fields every guard action shares.
 *
 * - `userRequested` — the current plan/task explicitly named this exact
 *   destructive action; downgrades an `ask` to `allow` (never touches an
 *   `allow` or `consult`).
 * - `context` — free-form provenance for logging/escalation records; never
 *   read by the deterministic decision.
 */
interface GuardActionBase {
  userRequested?: boolean;
  context?: string;
}

/** Push to a remote — visible to others, not locally reversible. */
export interface PushGuardAction extends GuardActionBase {
  kind: 'push';
  remote?: string;
  branch?: string;
}

/** Open a Pull Request — same irreversible-remote blast radius as a push. */
export interface PrCreateGuardAction extends GuardActionBase {
  kind: 'pr-create';
  remote?: string;
  branch?: string;
}

/** Local commit — amendable/revertible, never leaves the machine. */
export interface CommitGuardAction extends GuardActionBase {
  kind: 'commit';
  branch?: string;
}

/**
 * Filesystem deletion.
 *
 * "Inside" is a question about a SPECIFIC checkout, and since threads own their
 * own worktrees it is no longer the run's checkout by default: a thread's every
 * write lands in `.{repo}-threads/<slug>`, which reads as "outside" against the
 * project root and would escalate each one. So the caller states the root, and
 * containment is decided HERE (allowed-pattern #14) instead of being eyeballed
 * per call site:
 *
 * - `worktreeRoot` — the checkout "inside" resolves against: the thread's
 *   worktree when the action belongs to a thread, else the run's own checkout.
 *   Preferred; when present, `insideWorktree` is ignored.
 * - `insideWorktree` — the pre-worktree spelling, kept so callers that already
 *   computed containment keep their exact verdict. With NEITHER field the
 *   classifier fails closed (`ask`) rather than guessing recoverable.
 */
export interface DeleteGuardAction extends GuardActionBase {
  kind: 'delete';
  path: string;
  worktreeRoot?: string;
  insideWorktree?: boolean;
}

/** Arbitrary shell command — classified via the permissions-hygiene families. */
export interface BashGuardAction extends GuardActionBase {
  kind: 'bash';
  command: string;
}

/** Discriminated union of every dangerous seam the guard judges. */
export type GuardAction =
  | PushGuardAction
  | PrCreateGuardAction
  | CommitGuardAction
  | DeleteGuardAction
  | BashGuardAction;

/**
 * The three verdicts:
 * - `allow` — reversible/routine, run silently
 * - `ask` — irreversible/other-affecting, pause and confirm
 * - `consult` — not decidable deterministically, defer to a haiku classifier
 */
export type GuardVerdict = 'allow' | 'ask' | 'consult';

/** A deterministic decision: verdict plus a stable category + human reason. */
export interface GuardDecision {
  verdict: GuardVerdict;
  category: string;
  reason: string;
}
