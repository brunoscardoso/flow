/**
 * Types for the deterministic state script (`planflow-ai state`).
 *
 * These interfaces define the JSON output shape produced by parsing
 * plan-flow config files, session state, heartbeat events, and plans.
 *
 * Blueprint anchors: shared-context payloads (`ContractData`, `DecisionData`)
 * may carry an optional `anchors` array attaching them to blueprint graph
 * nodes. Rounds entries in `flow/.rounds.jsonl` (`plan_decision`,
 * `review_verdict`, `risk`, `escalation`) may carry the same optional
 * `anchors` field — rounds shapes are doc-defined
 * (`.claude/resources/skills/execute-plan-skill.md`), not typed here.
 * Records without anchors parse unchanged.
 */

import type { ChangeNote, ChangeNoteKind, NoteCounts, NoteStatus } from './change-notes.js';
import type { Anchor } from '../blueprint/types.js';

/**
 * Engine consent state recorded in `flow/.flowconfig`.
 * `pending` is transitional: the engine is required but not yet installed —
 * dependent steps run native-only with a persistent notice until it resolves.
 */
export type EngineStatus = 'enabled' | 'declined' | 'pending';

export interface FlowConfig {
  /** Whether the workflow chain runs itself. Resolved from the `autopilot`
   *  key, or the legacy `flow/.autopilot` marker when the key is absent;
   *  off for a project that has said neither (see `DEFAULT_CONFIG`). */
  autopilot: boolean;
  commit: boolean;
  push: boolean;
  pr: boolean;
  /** Auto-PRs open as GitHub drafts, flipped to ready only after a clean
   *  /review-pr or explicit user approval (#655). Requires `pr: true`. */
  pr_draft: boolean;
  /** Per-action classifier gate for autonomous execute-plan seams (push, PR
   *  create, deletes outside the worktree, mutating bash) — pause+ask on
   *  irreversible actions (#653). Default false; independent of autopilot
   *  (only affects autonomous execute-plan runs, does not cascade). */
  guarded_autopilot: boolean;
  /** The project's default BASE — the branch a thread's worktree is cut from and the
   *  branch a PR opens against. Empty means "the branch you are on"
   *  (thread_remote_binding reuses this key rather than adding a base key). */
  branch: string;
  /** The git remote a thread's binding defaults to (`origin`). A NAME, never a
   *  URL; the binding a person confirms may name a different one. */
  remote: string;
  /** Optional naming convention for a thread's REMOTE branch, e.g.
   *  `feature/{ticket}`. Placeholders: `{ticket}`, `{slug}`, `{local}`,
   *  `{user}`. Absent means unset — the suggestion ladder falls to the next
   *  rung, and a pattern is never applied without confirmation. */
  remote_branch_pattern?: string;
  /** Where a thread's worktree starts when nobody names a start: `here` (the
   *  branch the main checkout is on), `trunk` (the repository's default branch,
   *  brought up to date) or `branch:<name>`. Absent means unset — the IDE's
   *  resolver falls through to the global default, then to the built-in. This
   *  is a DEFAULT the start dialog pre-selects, never a bypass of the ask.
   *  Read from the old key `workspace_start` when this one is absent. */
  worktree_start?: string;
  /** Whether the base ref is refreshed before a worktree is cut. Default ON —
   *  only the literal `false` turns it off, so a project that has never heard
   *  of the key behaves exactly as before it existed. Off means no fetch at
   *  all, and therefore no may-be-behind flag either. */
  base_refresh: boolean;
  /** How long that refresh may take, in milliseconds. Absent means unset — the
   *  resolver supplies the built-in and CLAMPS whatever it is given, so no
   *  setting can reopen an unbounded wait; the parser deliberately does not
   *  clamp, because a hand-typed out-of-range value should reach the layer
   *  that can say so. */
  base_refresh_timeout_ms?: number;
  wave_execution: boolean;
  phase_isolation: boolean;
  model_routing: boolean;
  max_verify_retries: number;
  /** The model that writes a discovery's user walkthrough page — the
   *  artifact, written on request by `/artifact`. The page is large and none of it
   *  is reasoning, so it runs on a cheaper tier than the session by default.
   *  Only the Claude runtime can honour it — Copilot and Codex offer no way to
   *  pick a sub-agent's model, and write the page on the thread's own. */
  walkthrough_model: WalkthroughModel;
  /** Engine registry — dotted keys `engines.<name>: enabled|declined|pending`. Absent when no engines recorded. */
  engines?: Record<string, EngineStatus>;
  /** One-time graphify migration re-prompt marker — `engines.graphify_migration_asked: true`. Absent when never recorded. */
  graphify_migration_asked?: boolean;
  /** Project commands — dotted keys `commands.<name>: <cmd>`. Absent when no commands recorded. */
  commands?: { lint?: string };
  /** Extra untracked entries a thread's worktree links in from the main
   *  checkout, beyond the built-in set (dependencies, `.env*`, `flow/`) —
   *  `worktree_links: .turbo, .next/cache`. Absent when none are configured. */
  worktree_links?: string[];
  /** The agent RUNTIME for this project — `'claude' | 'codex' | 'copilot'`
   *  (multi_runtime_support). A per-project override of the global default;
   *  absent means "use the global default" (Claude). */
  provider?: string;
}

/** The tiers a walkthrough page may be written on. `sonnet` is the default. */
export const WALKTHROUGH_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export type WalkthroughModel = (typeof WALKTHROUGH_MODELS)[number];

export interface SessionState {
  files_present: {
    ledger: boolean;
    brain_index: boolean;
    tasklist: boolean;
    memory: boolean;
    scratchpad: boolean;
    heartbeat_events: boolean;
    heartbeat_state: boolean;
    heartbeat_prompt: boolean;
    state_md: boolean;
  };
}

export interface HeartbeatSummary {
  unread_count: number;
  has_prompt: boolean;
  last_read_timestamp: string | null;
}

export interface TaskCompletion {
  task_number: number;
  task_name: string;
  files_created: string[];
  files_modified: string[];
}

export interface PlanTask {
  index: number;
  name: string;
  verify_command: string | null;
}

export interface PlanPhase {
  number: number;
  name: string;
  complexity: number;
  dependencies: number[];
  tasks: PlanTask[];
  /**
   * The phase's readable change notes (`#### Change notes`). Present only when
   * the phase has at least one, so a plan without notes parses exactly as it
   * did before notes existed (NFR-5).
   */
  notes?: ChangeNote[];
}

export interface WaveGroup {
  wave_number: number;
  phase_numbers: number[];
}

export type ContextEntryType = 'contract' | 'decision' | 'progress';
export type ContractKind = 'endpoint' | 'interface' | 'function' | 'type';

export interface ContractData {
  name: string;
  kind: ContractKind;
  signature: string;
  fields?: string[];
  /** Optional blueprint anchors attaching this contract to graph nodes. */
  anchors?: Anchor[];
}

export interface DecisionData {
  choice: string;
  reason?: string;
  /** Optional blueprint anchors attaching this decision to graph nodes. */
  anchors?: Anchor[];
}

export interface ProgressData {
  task: number;
  status: 'complete' | 'in-progress';
  summary?: string;
}

export interface ContextEntry {
  agent: string;
  type: ContextEntryType;
  timestamp: string;
  data: ContractData | DecisionData | ProgressData;
}

export interface ContractConflict {
  name: string;
  entries: { agent: string; signature: string; fields?: string[] }[];
}

export type ModelTierLevel = 'fast' | 'standard' | 'powerful';

export interface ModelTier {
  phase: number;
  complexity: number;
  tier: ModelTierLevel;
  model: string;
}

export interface CompletedPhase {
  number: number;
  name: string;
  outcome: string;
}

export interface Decision {
  decision: string;
  choice: string;
  reason: string;
}

export interface Blocker {
  issue: string;
  status: string;
  tried: string;
}

export interface ExecutionState {
  active_skill: string | null;
  active_plan: string | null;
  current_phase: { number: number; name: string } | null;
  current_task: string | null;
  completed_phases: CompletedPhase[];
  decisions: Decision[];
  blockers: Blocker[];
  files_modified: string[];
  next_action: string | null;
  updated_at: string | null;
}

export interface StateOutput {
  config: FlowConfig;
  session: SessionState;
  heartbeat: HeartbeatSummary;
  execution?: ExecutionState;
  plan?: {
    phases: PlanPhase[];
    waves: WaveGroup[];
    model_tiers: ModelTier[];
  };
}

// ── Compiled run scripts ─────────────────────────────────

/** Commit strategy a compiled run executes with. */
export type RunCommitStrategy = 'per-task' | 'per-phase' | 'none';

/** One task of a compiled run phase — `verify` reflects applied overrides. */
export interface RunTask {
  index: number;
  name: string;
  verify: string | null;
}

/**
 * One compiled run phase — derived from `PlanPhase` with overrides resolved:
 * `model` is the routed model after any phase override, `skip` marks phases
 * excluded from execution by override.
 */
export interface RunPhase {
  number: number;
  name: string;
  complexity: number;
  dependencies: number[];
  model: string;
  skip: boolean;
  tasks: RunTask[];
  /**
   * The phase's change notes and their review status. Always written by the
   * compiler (`[]` when the phase has none); optional on the type because an
   * artifact compiled before notes existed does not carry it.
   */
  notes?: RunNote[];
}

/** One change note as `/execute-plan` needs it: which, what kind, where, decided how. */
export interface RunNote {
  n: number;
  kind: ChangeNoteKind;
  /** The target as written in the plan (`[<project>/]file:<path>[:<function>]`). */
  target: string;
  status: NoteStatus;
}

/** Per-phase override — keyed by phase number (as a string) in `RunOverrides`. */
export interface RunPhaseOverride {
  model?: 'haiku' | 'sonnet' | 'opus';
  skip?: boolean;
}

/** Per-task override — keyed by `"<phase>.<task-index>"` in `RunOverrides`. */
export interface RunTaskOverride {
  verify?: string;
}

/**
 * User overrides applied during run compilation. Carried verbatim on the
 * compiled `RunScript` — stale entries are diagnosed, never dropped.
 */
export interface RunOverrides {
  phases?: Record<string, RunPhaseOverride>;
  tasks?: Record<string, RunTaskOverride>;
}

/** Diagnostic severity — `stale-override` flags overrides that no longer apply. */
export type RunDiagnosticSeverity = 'stale-override' | 'info';

/** One non-fatal compilation diagnostic. */
export interface RunDiagnostic {
  severity: RunDiagnosticSeverity;
  message: string;
}

/**
 * The compiled run artifact — a deterministic function of the plan content
 * and the overrides. `planHash` is the sha256 hex of the FULL plan markdown,
 * so drift between the artifact and its source plan is detectable.
 */
export interface RunScript {
  version: 1;
  plan: string;
  planHash: string;
  phases: RunPhase[];
  waves: WaveGroup[];
  routing: ModelTier[];
  commitStrategy: RunCommitStrategy;
  overrides: RunOverrides;
  diagnostics: RunDiagnostic[];
  /**
   * The plan's note counts (`unreviewed` = status proposed). Always written by
   * the compiler; optional for artifacts compiled before notes existed.
   */
  notes?: NoteCounts;
}
