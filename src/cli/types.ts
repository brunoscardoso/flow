/**
 * Shared types for the CLI
 */

export interface InitOptions {
  claude?: boolean;
  all?: boolean;
  force?: boolean;
  /** Non-interactive: never prompt — take the default for every question. Used
   *  when the IDE runs init under the hood (no terminal). Defaults platforms to
   *  Claude when none are flagged. */
  yes?: boolean;
  /** Refresh plan-flow-owned assets only, leaving user data (`.claude/rules/**`,
   *  flow content, existing `.flowconfig` keys) untouched. Refuses when the
   *  project has no existing install. Used by the IDE's auto-provisioning. */
  refreshOwned?: boolean;
  /** The Flow app provisions this project and will put it in a Workspace
   *  (`workspace migrate`) itself: init leaves `flow/` alone — no vault link,
   *  no vault registration, nothing seeded into it — unless it already is (or
   *  provisioning makes it) a Workspace link. Terminal runs omit it. */
  workspaceManaged?: boolean;
  target: string;
}

/**
 * Whether this project's plan-flow knowledge is shared with the team or kept
 * local to this machine.
 *
 * `local`    — `flow/` is ignored wholesale (the historical behaviour).
 * `shared`   — only DERIVED artifacts are ignored; the precious markdown layer
 *              is committed alongside the code (same repo as the code).
 * `separate` — `flow/` is its OWN nested git repo (own remote), so the PARENT
 *              repo ignores it wholesale — the same shape as `local` for the
 *              parent — plus `.claude/rules` (materialized from the brain repo).
 *              The brain-repo pointer travels in the committed `.gitignore`
 *              header (see `BrainPointer` / `readBrainPointer`), because a
 *              gitignored `flow/.flowconfig` cannot reach a fresh clone.
 *
 * The default is ALWAYS `local`: turning sharing on publishes someone's work,
 * so it is never inferred, only answered.
 */
export type ShareMode = 'local' | 'shared' | 'separate';

/**
 * Where a `separate`-mode project's `flow/` nested git repo lives. Recorded in
 * the COMMITTED root `.gitignore` header (the one channel a fresh clone reads),
 * never in the gitignored `flow/.flowconfig`.
 */
export interface BrainPointer {
  /** The brain repo's git URL. */
  url: string;
  /** Optional branch; absent means the remote's default branch. */
  branch?: string;
}

export interface CopyOptions {
  force: boolean;
  /** Non-interactive — handlers must not prompt; take the safe default. */
  nonInteractive?: boolean;
  /**
   * Knowledge-sharing answer for this run. Undefined means "not answered here"
   * — the handler falls back to the project's persisted setting, then `local`.
   */
  share?: ShareMode;
  /** See `InitOptions.workspaceManaged`. */
  workspaceManaged?: boolean;
}

export interface CopyResult {
  created: string[];
  skipped: string[];
  updated: string[];
}

export interface InitResult {
  platform: string;
  result: CopyResult;
}

/** Claude Code is the only supported platform — the Flow IDE is the product
 *  surface now (multi-IDE support removed 2026-07-22; other MODELS may return
 *  later via a router, other IDEs will not). */
export type Platform = 'claude';

export interface ScheduleConfig {
  type: 'daily' | 'interval' | 'weekly' | 'once';
  hour?: number;
  minute?: number;
  intervalMs?: number;
  dayOfWeek?: number; // 0=Sunday, 1=Monday, ..., 6=Saturday
}

export interface HeartbeatTask {
  name: string;
  schedule: string;
  scheduleConfig: ScheduleConfig;
  command: string;
  enabled: boolean;
  description: string;
  oneShot?: boolean;
  tasklistLink?: string;
  addDirs?: string[];
}

export interface HeartbeatOptions {
  target: string;
}

export type NotificationLevel = 'info' | 'warn' | 'error';

export type NotificationType =
  | 'task_started'
  | 'phase_complete'
  | 'task_complete'
  | 'task_failed'
  | 'task_blocked'
  | 'task_skipped';

export interface NotificationEvent {
  id: string;
  timestamp: Date;
  task: string;
  type: NotificationType;
  level: NotificationLevel;
  phase?: string;
  message: string;
}

export interface HeartbeatState {
  lastReadTimestamp: string;
  lastSessionId?: string;
}
