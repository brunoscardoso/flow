// The AgentRuntime seam (multi_runtime_support, Phase 2).
//
// plan-flow was bound to the Claude Agent SDK: `agent-manager` imported the SDK
// directly and every feature rode SDK-specific machinery. This interface is the
// ONE seam every coding-agent runtime implements, so a user can bring their own
// CLI (Claude, OpenAI/Codex, Copilot). It owns the six responsibilities the
// discovery identified: lifecycle+env, a normalized event stream, tool approval,
// tool interception/veto (containment), session+resume, and model selection.
//
// The normalized event stream is `AgentStreamEvent` (the shape the renderer
// already consumes). Each runtime's adapter maps its native output onto it —
// e.g. Codex's JSONL `thread.started`/`item.completed`/`turn.completed` map to
// `message-start`/`tool-*`/`usage` (see flow/resources/multi-runtime-spike-report.md).
//
// Additive by construction: this file introduces no behavior. `ClaudeRuntime`
// (Task 2.2) implements it by extracting today's agent-manager wiring unchanged.

import type { AgentStreamEvent } from '../../../shared/ipc-contract'

/**
 * The capability contract. A runtime is ADMITTED only when its safety-critical
 * capabilities are met (`containment` present); productivity capabilities
 * declare themselves and features degrade gracefully where absent — "safe
 * peers, not always feature-identical peers".
 */
export interface RuntimeCapabilities {
  /** Native-required: can be launched non-interactively with a focused task. */
  driveHeadless: true
  /** Native-required: emits a machine-parseable event stream. */
  parseableStream: true
  /** Native-required for resume: exposes a session id we can persist + resume. */
  resumeHandle: boolean
  /**
   * SAFETY FLOOR (admission gate). How the runtime is contained:
   * - `native`  — the CLI's own veto/approval channel (Claude `canUseTool`, or
   *   Codex's built-in sandbox);
   * - `sandbox` — plan-flow wraps it in an OS sandbox (restricted FS + shell).
   * A runtime that can be neither is REJECTED — it never runs.
   */
  containment: 'native' | 'sandbox'
  /** Productivity: per-tool interception granularity (degrades where coarser). */
  toolApproval: 'per-tool' | 'on-request' | 'none'
  /** Productivity: observable pre/post tool events (edit-tracking, capture). */
  toolEvents: boolean
  /** Isolation mechanism for sub-agents (phase isolation / waves): a native
   *  sub-agent tool, or plan-flow spawning fresh instances at the CLI layer. */
  subAgents: 'native' | 'instance-spawn'
  /** Whether multiple models are available for complexity routing. */
  modelSelection: boolean
}

/** How a runtime session is started (lifecycle + env). */
export interface RuntimeStartOptions {
  /** The plan-flow thread this session belongs to. */
  threadId: string
  /** Working root the agent is confined to. */
  cwd: string
  /** Additional roots in scope (multi-root + resolved `flow/` symlink targets). */
  additionalRoots: string[]
  /**
   * The directories beyond `cwd` the session must be able to WRITE: the
   * thread's other projects (as their thread checkouts when they have one) and
   * the real targets of each project's symlinked `flow/`. A runtime whose
   * sandbox takes write grants separately from read scope (Codex's
   * `writable_roots`) passes these; the rest can ignore it — `additionalRoots`
   * already carries them. Absent means none.
   */
  writableRoots?: string[]
  /** The first user turn's text (task seed). */
  prompt: string
  /** Model id/alias, or undefined to let the runtime route by effort. */
  model?: string
  /**
   * How hard the thread asked the agent to think — Flow's own effort, which
   * the composer sets per thread. Runtimes with a reasoning-effort dial receive
   * it; the rest ignore it.
   */
  effort?: 'low' | 'medium' | 'high'
  /** A prior session id to resume, or null for a fresh session. */
  resumeSessionId?: string | null
  /** Cancels the session (Interrupt / dispose). */
  abortSignal: AbortSignal
}

/** A tool-call verdict from the approval channel (containment, guarded autopilot). */
export type RuntimeToolVerdict =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

/** Callbacks the coordinator (agent-manager) wires into a runtime session. */
export interface RuntimeCallbacks {
  /** The normalized event stream — one call per translated provider event. */
  onEvent(event: AgentStreamEvent): void
  /** Fired once the provider's session id is known, for persist + resume. */
  onSessionId(sessionId: string): void
  /**
   * Approve/deny/rewrite a tool call BEFORE it runs. Runtimes with per-tool
   * interception (`toolApproval: 'per-tool'`) route here; coarser runtimes rely
   * on `capabilities.containment` and this may be a no-op returning `allow`.
   */
  canUseTool?(toolName: string, input: unknown): Promise<RuntimeToolVerdict>
  /**
   * Fired ONCE when the session's event stream ends — the turn/session is done
   * (cleanly or on error). The interactive coordinator can ignore it; a headless
   * one-shot caller (a learn pass, a title generator) awaits it to know the run
   * has finished and its captured result is complete.
   */
  onDone?(): void
  /**
   * Something the person should know about the session that is neither an
   * error nor the agent's words — said in plain language, once. The
   * coordinator records it in the thread as a calm system line.
   */
  onNotice?(text: string): void
}

/** A live session handle (send, retarget model, dispose). */
export interface RuntimeSession {
  /** The provider's session id once known, else null (resume handle). */
  readonly sessionId: string | null
  /** Push a follow-up user message into the live session. */
  send(text: string): void
  /** Switch the active model mid-session, when the runtime supports it. */
  setModel(model: string): void
  /**
   * Interrupt the IN-FLIGHT turn without ending the session — the user hit stop.
   * The session stays resumable (a later `send` continues it). Distinct from
   * `dispose`, which tears the whole session down. Safe to call when idle.
   */
  interrupt(): void
  /** Abort and dispose the underlying process. Safe to call twice. */
  dispose(): void
}

/**
 * The one seam every coding-agent runtime implements. `agent-manager` selects
 * the implementation from config (global default + per-project `.flowconfig`
 * override) and talks only to this interface.
 */
export interface AgentRuntime {
  /** Stable id — `'claude'`, `'codex'`, `'copilot'`. */
  readonly id: string
  /** Declared capabilities, checked against the admission contract. */
  readonly capabilities: RuntimeCapabilities
  /** Start a session; stream its events through `callbacks`; return the handle. */
  start(options: RuntimeStartOptions, callbacks: RuntimeCallbacks): RuntimeSession
}
