// AppSettingsStore — generic app-wide key/value settings over the app_settings
// table (the same single-row store that holds default_account_id). Used by the
// first-run onboarding wizard (#48):
//   - onboarding_completed:      the wizard has been finished at least once
//   - autonomy_bypass_default:   new threads default to bypassPermissions
//     ("Autonomous mode"), overridable per-thread.

import { countUseDay } from '../../shared/consent-prompt'
import { randomBytes } from 'node:crypto'

import type { FlowDatabase } from './db'
import { parseModelRouting, type ModelRouting } from '../../shared/model-routing'
import {
  WORKTREE_FLOWCONFIG_KEYS,
  WORKTREE_SETTING_KEYS,
} from '../flow/worktree-settings'
import { legacyFlowconfigKeyOf } from '../../shared/worktree-config-aliases'
import type {
  IntegrationProvider,
  IssueListConfig,
  IssueListMode,
  RuntimeContextChoice,
  WorktreeDefaults,
  WorktreeSettingKey,
} from '../../shared/ipc-contract'

const ONBOARDING_COMPLETED_KEY = 'onboarding_completed'
const AUTONOMY_BYPASS_DEFAULT_KEY = 'autonomy_bypass_default'
const CLOSE_REMOTE_ON_DONE_KEY = 'close_remote_on_done'
const MODEL_ROUTING_KEY = 'model_routing_auto'
const DEFAULT_MODEL_KEY = 'default_model'
const LAST_RUN_VERSION_KEY = 'last_run_version'
const DEFAULT_EFFORT_KEY = 'default_effort'

/**
 * The preference is PER RUNTIME.
 *
 * It used to be one value for the app, and models do not transfer: pinning
 * gpt-5.1-codex-max under Codex made it the default for every new thread, so
 * switching back to Claude produced "There's an issue with the selected model
 * (gpt-5.1-codex-max)" on the first message of a brand-new chat.
 *
 * Claude keeps the original keys so an existing preference survives the change
 * — it is the runtime every one of them was chosen under.
 */
function modelKeyFor(provider: string): string {
  return provider === 'claude' ? DEFAULT_MODEL_KEY : `${DEFAULT_MODEL_KEY}_${provider}`
}

function effortKeyFor(provider: string): string {
  return provider === 'claude' ? DEFAULT_EFFORT_KEY : `${DEFAULT_EFFORT_KEY}_${provider}`
}
const LOOP_OWNER_KEY = 'loop_owner_id'
/** When this installation first ran — minted once, never updated. */
const FIRST_RUN_KEY = 'first_run_at'
/** Distinct calendar days this installation has been opened. */
const USE_DAYS_KEY = 'use_days'
/** The last day counted, so several launches in one afternoon count once. */
const LAST_USE_DAY_KEY = 'last_use_day'
/** How many times the telemetry question has been raised and dismissed. */
const CONSENT_ASKS_KEY = 'telemetry_consent_asks'
/** Has this person agreed to share install facts and usage events? */
const TELEMETRY_CONSENT_KEY = 'telemetry_consent'
/** Per-runtime model ids the user has added — `runtime_models_codex`, etc. */
const RUNTIME_MODELS_PREFIX = 'runtime_models_'
/** Per-runtime model ids Flow has WATCHED a runtime use — see rememberSeen…. */
const SEEN_MODELS_PREFIX = 'runtime_models_seen_'
/** Per-runtime context-window choices, keyed by model id (#1929) —
 *  `runtime_model_context_copilot` → `{ "<model>": "default" | "max" }`. */
const MODEL_CONTEXT_PREFIX = 'runtime_model_context_'

/**
 * WORKSPACES — the app-only facts, kept HERE rather than in new tables.
 *
 * DEVIATION FROM THE PLAN (Phase 4, decided 2026-10-06): the plan called for a
 * `workspace_groups` table, `workspace_id` columns on threads and tasks, and a
 * `task_projects` link table. Any of those bumps the schema past v35, and the
 * installed Flow.app refuses every profile above v35 — while `npm run dev` and
 * the installed app must keep sharing ONE profile. So nothing about Workspaces
 * is stored in a table:
 *
 *  · MEMBERSHIP IS DERIVED, never stored. A thread's Workspace is the one that
 *    holds its primary project; a task's is the one that holds its
 *    `project_root`. The CLI (`workspace status`) is the only thing that knows,
 *    and the registry (main/workspaces/workspace-registry.ts) asks it.
 *  · What only the app knows lives in these key/value rows, which older builds
 *    ignore: whether the feature is on, which Workspace is selected, and the
 *    extra projects a multi-project task card names (one row per such task,
 *    so a write never reads-modifies-writes anybody else's).
 *
 * The prefix is `workspaces_`, never `workspace.`: that one belongs to the
 * legacy worktree-default rows below.
 */
// `workspaces_enabled` (the old on/off switch) is no longer read or written:
// Workspaces are always on. A row left in an old profile is harmless.
const CURRENT_WORKSPACE_KEY = 'workspaces_current'
const TASK_PROJECTS_PREFIX = 'workspaces_task_projects:'
/** A person CHOSE a task's projects (the remote ticket's picker) — the context gate does not guess for it. */
const TASK_PROJECTS_CHOSEN_PREFIX = 'workspaces_task_projects_chosen:'
/** A project description the context gate GENERATED — kept on this computer, never pushed to the Workspace. */
const GENERATED_DESCRIPTION_PREFIX = 'workspaces_generated_description:'
/** A card naming more projects than this is not a card any more. */
const MAX_TASK_EXTRA_PROJECTS = 32

/**
 * When knowledge last synced, per project root or per Workspace slug — the
 * sync engines' `lastSyncedAt`, so a restart does not read as "never synced".
 * Key/value rows older builds ignore: no schema change.
 */
const KNOWLEDGE_LAST_SYNCED_PREFIX = 'knowledge_last_synced:'
export type KnowledgeSyncScope = 'project' | 'workspace'

/**
 * The word this installation claims queue items under.
 *
 * A THIRD KIND OF HOLDER, named so it reads as one. The CLI already has two:
 * `run-<compact-iso>-<pid>` is one headless run, and `@<login>` is a GitHub
 * account seen from the queue's assignees. Neither fits a Flow window, which is
 * not a run (it outlives every claim it makes) and not an account (two machines
 * signed into the same GitHub login are two of these). `flow-ide-<hex>` sits
 * beside them without colliding: it cannot be mistaken for a run, and it cannot
 * start with the `@` that marks a claimant derived from the queue rather than
 * recorded — so every existing comparison against an owner keeps failing closed.
 *
 * A refusal reads: `item 1533 is already claimed by 'flow-ide-3f2a9c1b7e04'`.
 */
const LOOP_OWNER_PREFIX = 'flow-ide-'

/** The app-wide default agent runtime (multi_runtime_support). */
const DEFAULT_PROVIDER_KEY = 'default_provider'

/**
 * A tracker's issue-list preference — mode + native query — keyed per provider.
 *
 * GLOBAL AND NON-SECRET, which is why it is here and not in the credentials
 * file: the renderer must read it back to fill the settings query field and to
 * know which modes the board selector may offer, and the credentials file never
 * crosses IPC. One row per provider (`issue_list_config_github`, …).
 */
const ISSUE_LIST_CONFIG_PREFIX = 'issue_list_config_'

/** The behaviour a freshly-connected tracker has always had: show what is
 *  assigned to you, with no saved query. */
const DEFAULT_ISSUE_LIST_CONFIG: IssueListConfig = { mode: 'assigned', query: '' }

const ISSUE_LIST_MODES: readonly IssueListMode[] = ['assigned', 'list', 'both']

/**
 * The app-wide worktree defaults, one row per setting.
 *
 * NAMESPACED BY THE FILE'S OWN SPELLING (`worktree.thread_worktrees`, …) so a
 * row is readable next to the project file it stands behind — the two layers
 * hold the same grammar for the same setting, and a defaults row a person finds
 * in a database dump should be recognisable as the thing they typed. The prefix
 * keeps them clear of the flat keys this table already holds.
 *
 * DUAL-WRITTEN, TRANSITIONALLY. Builds before the workspace→worktree rename
 * read `workspace.<old file key>` rows, and they share this profile with
 * today's build (user, 2026-10-06). So every save writes BOTH rows with the same
 * value, every unset removes both, and a read prefers the new row and falls
 * back to the old one (which an older build may have written alone). Drop the
 * legacy half once no build older than the rename is still in use.
 */
const WORKTREE_DEFAULT_PREFIX = 'worktree.'
const LEGACY_DEFAULT_PREFIX = 'workspace.'

function worktreeDefaultKeyFor(key: WorktreeSettingKey): string {
  return `${WORKTREE_DEFAULT_PREFIX}${WORKTREE_FLOWCONFIG_KEYS[key]}`
}

/** The row older builds read and write: the old prefix, and the file key's
 *  old spelling when it had one (the shared alias table — never a copy). */
function legacyDefaultKeyFor(key: WorktreeSettingKey): string {
  const fileKey = WORKTREE_FLOWCONFIG_KEYS[key]
  return `${LEGACY_DEFAULT_PREFIX}${legacyFlowconfigKeyOf(fileKey) ?? fileKey}`
}

export class AppSettingsStore {
  constructor(private readonly db: FlowDatabase) {}

  #getBool(key: string): boolean {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string | null } | undefined
    return row?.value === 'true'
  }

  #setBool(key: string, value: boolean): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value ? 'true' : 'false')
  }

  /** Whether the first-run onboarding wizard has been completed. */
  getOnboardingCompleted(): boolean {
    return this.#getBool(ONBOARDING_COMPLETED_KEY)
  }

  setOnboardingCompleted(value: boolean): void {
    this.#setBool(ONBOARDING_COMPLETED_KEY, value)
  }

  /** Whether new threads default to bypassPermissions ("Autonomous mode"). */
  getAutonomyBypassDefault(): boolean {
    return this.#getBool(AUTONOMY_BYPASS_DEFAULT_KEY)
  }

  setAutonomyBypassDefault(value: boolean): void {
    this.#setBool(AUTONOMY_BYPASS_DEFAULT_KEY, value)
  }

  /**
   * Whether dragging a promoted remote task to Done closes the tracker ticket.
   *
   * DEFAULT TRUE — the feature the user asked for works out of the box, so an
   * ABSENT row reads as on. That is why this cannot use `#getBool` (which defaults
   * false): "nobody has chosen" must mean on here, and only an explicit `'false'`
   * turns it off. The toggle is the standing escape hatch.
   */
  getCloseRemoteOnDone(): boolean {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(CLOSE_REMOTE_ON_DONE_KEY) as { value: string | null } | undefined
    return row?.value !== 'false'
  }

  setCloseRemoteOnDone(value: boolean): void {
    this.#setBool(CLOSE_REMOTE_ON_DONE_KEY, value)
  }

  #getString(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string | null } | undefined
    return row?.value ?? null
  }

  #setString(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /**
   * Whether this person has agreed to share anything at all.
   *
   * THREE STATES, NOT TWO. `null` means nobody has been asked yet, and it is
   * NOT the same as no: the first-run wizard has to be able to tell "declined"
   * from "not reached", and an unanswered question must never read as consent.
   * Everything optional stays home until this is explicitly `true`.
   */
  getTelemetryConsent(): boolean | null {
    const raw = this.#getString(TELEMETRY_CONSENT_KEY)
    if (raw === null) return null
    return raw === 'true'
  }

  setTelemetryConsent(agreed: boolean): void {
    this.#setString(TELEMETRY_CONSENT_KEY, agreed ? 'true' : 'false')
  }

  /** Auto-mode effort→model routing (#129). Always a full, valid map (defaults
   *  fill any missing/invalid fields). */
  getModelRouting(): ModelRouting {
    return parseModelRouting(this.#getString(MODEL_ROUTING_KEY))
  }

  setModelRouting(routing: ModelRouting): void {
    this.#setString(MODEL_ROUTING_KEY, JSON.stringify(routing))
  }

  /** The app version of the previous run — compared at startup to detect a
   *  completed update, which triggers the post-update "What's new" notes. */
  getLastRunVersion(): string | null {
    const value = this.#getString(LAST_RUN_VERSION_KEY)
    return value !== null && value !== '' ? value : null
  }

  setLastRunVersion(version: string): void {
    this.#setString(LAST_RUN_VERSION_KEY, version)
  }

  /** The user's persisted model+effort preference (#848) — the last explicit
   *  composer pick. Applied by threads:create when the request omits a model,
   *  so every new thread (sidebar, tasks, imports) starts from the preference.
   *  Sub-agent model routing is untouched: 'auto' stays 'auto'. */
  getDefaultModelSelection(provider = 'claude'): { model: string | null; effort: string | null } {
    const model = this.#getString(modelKeyFor(provider))
    const effort = this.#getString(effortKeyFor(provider))
    return {
      model: model !== null && model !== '' ? model : null,
      effort: effort !== null && effort !== '' ? effort : null,
    }
  }

  setDefaultModelSelection(model: string, effort: string | null, provider = 'claude'): void {
    this.#setString(modelKeyFor(provider), model)
    // Auto carries no manual effort (#332) — store it as unset.
    this.#setString(effortKeyFor(provider), effort ?? '')
  }

  /**
   * This installation's queue-claim owner, minted once and kept forever.
   *
   * WHY IT HAS TO BE DURABLE (review finding H1). The board used to claim with
   * no `--owner`, so the CLI minted a fresh `run-<ts>-<pid>` on every single
   * invocation — and `claimBlocker` refuses any claim where
   * `item.claimedBy !== owner`. A claim that landed while its local record did
   * not could therefore never be retried FROM THE APP: the second drag arrived
   * under a name the queue had never seen, was refused by the claim this very
   * window had just made, and was reported to the user as somebody else holding
   * their own item. One stable word makes the claim re-entrant — the CLI already
   * treats a same-owner claim as re-entry, mirroring the loop lock — and makes
   * "held by me" a fact the board can actually test.
   *
   * INSTALLATION-WIDE, NOT PER PROJECT: it identifies this copy of Flow, which
   * is exactly the scope over which a retry has to match. It is a coordination
   * name, never a credential — it is written into a public issue body by every
   * claim it makes, and nothing anywhere authorizes on it.
   */
  getLoopOwnerId(): string {
    const stored = this.#getString(LOOP_OWNER_KEY)
    if (stored !== null && stored.trim().length > 0) return stored.trim()
    // 12 hex characters — long enough that two installations never collide,
    // short enough to sit inside a CLI refusal line without wrapping it.
    const minted = `${LOOP_OWNER_PREFIX}${randomBytes(6).toString('hex')}`
    this.#setString(LOOP_OWNER_KEY, minted)
    return minted
  }

  /**
   * When this installation first ran.
   *
   * WRITTEN ON FIRST READ, like the owner id above, because there is no
   * "install" moment to hook: the app has always simply started. The first
   * caller therefore defines it, and every later call returns that same value.
   *
   * THIS IS NOT WHEN TELEMETRY WAS SWITCHED ON, and the distinction matters:
   * an installation that answers "no" and later changes its mind still reports
   * the date it was installed, so "how old are the installs still running this
   * version" is answerable without the answer bending around consent.
   *
   * The clock is injected so a test needs no timer.
   */
  getFirstRunAt(now: () => Date = () => new Date()): string {
    const stored = this.#getString(FIRST_RUN_KEY)
    if (stored !== null && stored.trim().length > 0) return stored.trim()
    const minted = now().toISOString()
    this.#setString(FIRST_RUN_KEY, minted)
    return minted
  }

  /**
   * Count today as a day of use, and report the running total.
   *
   * Called once per app start. Several launches in one afternoon are one day —
   * "the third day you used Flow" is a sentence about days, not launches.
   */
  countUseDayNow(today: string): number {
    const lastDay = this.#getString(LAST_USE_DAY_KEY)
    const next = countUseDay(
      { useDays: Number(this.#getString(USE_DAYS_KEY) ?? '0') || 0, lastDay },
      today,
    )
    if (next.lastDay !== lastDay) {
      this.#setString(USE_DAYS_KEY, String(next.useDays))
      this.#setString(LAST_USE_DAY_KEY, next.lastDay)
    }
    return next.useDays
  }

  /** Distinct days this installation has been opened. */
  getUseDays(): number {
    return Number(this.#getString(USE_DAYS_KEY) ?? '0') || 0
  }

  /** How many times the telemetry question has been raised and dismissed. */
  getConsentAsks(): number {
    return Number(this.#getString(CONSENT_ASKS_KEY) ?? '0') || 0
  }

  /** Record that the question was raised — whether or not it was answered. */
  recordConsentAsk(): void {
    this.#setString(CONSENT_ASKS_KEY, String(this.getConsentAsks() + 1))
  }

  /** The app-wide default agent RUNTIME (multi_runtime_support) — 'claude' |
   *  'codex' | 'copilot'. A per-project flow/.flowconfig `provider` overrides
   *  it; unset (null) → the legacy default (Claude). */
  getDefaultProvider(): string | null {
    const value = this.#getString(DEFAULT_PROVIDER_KEY)
    return value !== null && value !== '' ? value : null
  }

  setDefaultProvider(provider: string): void {
    this.#setString(DEFAULT_PROVIDER_KEY, provider)
  }

  /**
   * Model ids the user has added for a runtime.
   *
   * WHY THESE ARE STORED AT ALL: Codex and Copilot have no way to list the
   * models an account may use — no subcommand, no file, and the set differs by
   * plan. Flow cannot discover them, so it remembers the ones the person names
   * and offers those alongside Auto.
   */
  getRuntimeModels(provider: string): string[] {
    const raw = this.#getString(`${RUNTIME_MODELS_PREFIX}${provider}`)
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : []
    } catch {
      return []
    }
  }

  /**
   * Models Flow has watched this runtime actually use.
   *
   * THE RUNTIME REPORTS ITS OWN MODEL EVERY TURN — Copilot's stream carries it,
   * which is where the "Sonnet 5" under a reply comes from — and that is the
   * only per-account model list Flow can be sure of: GitHub Copilot's catalogue
   * table is empty until its interactive session fills it, and no command
   * exists to ask. So the answer is collected by watching, one turn at a time.
   */
  getSeenRuntimeModels(provider: string): string[] {
    const raw = this.#getString(`${SEEN_MODELS_PREFIX}${provider}`)
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : []
    } catch {
      return []
    }
  }

  /** Record one, newest first, capped — a menu, not a history. */
  rememberSeenRuntimeModel(provider: string, model: string, cap = 12): void {
    const trimmed = model.trim()
    if (trimmed.length === 0) return
    const seen = this.getSeenRuntimeModels(provider)
    if (seen[0] === trimmed) return // nothing moved; skip the write
    const next = [trimmed, ...seen.filter((entry) => entry !== trimmed)].slice(0, cap)
    this.#setString(`${SEEN_MODELS_PREFIX}${provider}`, JSON.stringify(next))
  }

  #deleteKey(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }

  /**
   * The person's app-wide worktree defaults — raw strings, keyed by setting.
   *
   * PARTIAL BY DESIGN. A key absent from the result is a default nobody has set,
   * which is a different fact from a default set to the built-in value: the
   * first inherits future changes to what Flow does, the second pins one. The
   * resolver reads absence as "ask the layer below", so the shape has to be able
   * to express it.
   *
   * Raw text, not parsed values, because the project layer is text and always
   * will be — `.flowconfig` is hand-editable — and one grammar read by one
   * parser is the only arrangement in which the same value typed in either place
   * cannot mean two different things.
   */
  getWorktreeDefaults(): Partial<WorktreeDefaults> {
    const defaults: Partial<WorktreeDefaults> = {}
    for (const key of WORKTREE_SETTING_KEYS) {
      const value =
        this.#getString(legacyDefaultKeyFor(key)) ?? this.#getString(worktreeDefaultKeyFor(key))
      if (value !== null && value.trim() !== '') defaults[key] = value
    }
    return defaults
  }

  /**
   * Set or unset worktree defaults. A `null` value REMOVES the row.
   *
   * Removal is a value of this function rather than a second function beside it
   * for the same reason the flowconfig merge folds delete into upsert: "go back
   * to inheriting" and "set this" are one decision a person makes with one
   * control, and two entry points is two chances for them to disagree
   * (allowed-pattern #14). It only ever happens on an explicit switch — nothing
   * here removes a row the caller did not name (forbidden-pattern #15).
   */
  setWorktreeDefaults(patch: Partial<Record<WorktreeSettingKey, string | null>>): void {
    for (const key of WORKTREE_SETTING_KEYS) {
      if (!(key in patch)) continue
      const value = patch[key]
      // Both spellings, always together: an older build sharing this profile
      // reads only the legacy row, and an unset that left either behind would
      // read a stale value straight back.
      const rowKeys = [worktreeDefaultKeyFor(key), legacyDefaultKeyFor(key)]
      for (const rowKey of rowKeys) {
        if (value === null || value === undefined || value.trim() === '') {
          this.#deleteKey(rowKey)
        } else {
          this.#setString(rowKey, value.trim())
        }
      }
    }
  }

  /**
   * A provider's issue-list preference, or the default when none is stored.
   *
   * ALWAYS A FULL, VALID CONFIG — a corrupt row, a mode this build does not know,
   * or a missing field reads as the default rather than propagating an unusable
   * value to the fetch. The board and settings both branch on `query.length`, so
   * a null query would be a third state neither handles.
   */
  getIssueListConfig(provider: IntegrationProvider): IssueListConfig {
    const raw = this.#getString(`${ISSUE_LIST_CONFIG_PREFIX}${provider}`)
    if (raw === null) return { ...DEFAULT_ISSUE_LIST_CONFIG }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_ISSUE_LIST_CONFIG }
      const record = parsed as Record<string, unknown>
      const mode = ISSUE_LIST_MODES.includes(record['mode'] as IssueListMode)
        ? (record['mode'] as IssueListMode)
        : 'assigned'
      const query = typeof record['query'] === 'string' ? record['query'] : ''
      return { mode, query }
    } catch {
      return { ...DEFAULT_ISSUE_LIST_CONFIG }
    }
  }

  /**
   * Set the mode, the query, or both — a partial patch merged onto the stored
   * config, returning the result so a caller needs no follow-up read.
   *
   * The query is trimmed but never rewritten (allowed-pattern #22: a value a
   * person TYPED is stored as they typed it, minus surrounding space). Clearing
   * it to '' is a real choice — the board falls back to `assigned` when the mode
   * asks for a list there is no longer a query for, which is validated on read.
   */
  setIssueListConfig(
    provider: IntegrationProvider,
    patch: { mode?: IssueListMode; query?: string },
  ): IssueListConfig {
    const current = this.getIssueListConfig(provider)
    const next: IssueListConfig = {
      mode:
        patch.mode !== undefined && ISSUE_LIST_MODES.includes(patch.mode) ? patch.mode : current.mode,
      query: patch.query !== undefined ? patch.query.trim() : current.query,
    }
    this.#setString(`${ISSUE_LIST_CONFIG_PREFIX}${provider}`, JSON.stringify(next))
    return next
  }

  setRuntimeModels(provider: string, models: readonly string[]): void {
    // Trimmed, de-duplicated, order preserved — a menu with the same entry
    // twice is a bug the user has to look at every day.
    const seen = new Set<string>()
    const clean: string[] = []
    for (const model of models) {
      const trimmed = model.trim()
      if (trimmed.length === 0 || seen.has(trimmed)) continue
      seen.add(trimmed)
      clean.push(trimmed)
    }
    this.#setString(`${RUNTIME_MODELS_PREFIX}${provider}`, JSON.stringify(clean))
  }

  /**
   * The context-window choice the user has saved per model id (#1929).
   *
   * A map, not a list: the choice belongs to a MODEL, not to the provider, and
   * only the models whose catalogue offers an extended window ever appear here.
   * A missing entry means "the model's default window" — the same behaviour that
   * shipped before this existed. Corrupt/foreign rows read as {} (the default).
   */
  getModelContextPreferences(provider: string): Record<string, RuntimeContextChoice> {
    const raw = this.#getString(`${MODEL_CONTEXT_PREFIX}${provider}`)
    if (raw === null) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return {}
      const out: Record<string, RuntimeContextChoice> = {}
      for (const [model, choice] of Object.entries(parsed as Record<string, unknown>)) {
        if (model.length > 0 && (choice === 'default' || choice === 'max')) out[model] = choice
      }
      return out
    } catch {
      return {}
    }
  }

  /**
   * Save one model's context-window choice (#1929). `'default'` REMOVES the
   * entry rather than storing it — the absence of a row is what "default window"
   * means, so the two cannot drift apart (the same fold setWorktreeDefaults
   * uses for its null, allowed-pattern #14).
   */
  setModelContextPreference(provider: string, model: string, choice: RuntimeContextChoice): void {
    const trimmed = model.trim()
    if (trimmed.length === 0) return
    const current = this.getModelContextPreferences(provider)
    if (choice === 'default') delete current[trimmed]
    else current[trimmed] = choice
    if (Object.keys(current).length === 0) {
      this.#deleteKey(`${MODEL_CONTEXT_PREFIX}${provider}`)
    } else {
      this.#setString(`${MODEL_CONTEXT_PREFIX}${provider}`, JSON.stringify(current))
    }
  }

  /** The Workspace the person last selected (its folder slug), or null. */
  getCurrentWorkspace(): string | null {
    const value = this.#getString(CURRENT_WORKSPACE_KEY)
    return value !== null && value.trim() !== '' ? value.trim() : null
  }

  /** Select a Workspace; null clears the selection (the row is removed). */
  setCurrentWorkspace(slug: string | null): void {
    if (slug === null || slug.trim() === '') this.#deleteKey(CURRENT_WORKSPACE_KEY)
    else this.#setString(CURRENT_WORKSPACE_KEY, slug.trim())
  }

  /**
   * The projects a task card names BESIDES its own `project_root` (the plan's
   * `task_projects`, stored as one row per task). Corrupt rows read as none.
   */
  getTaskExtraProjects(taskId: string): string[] {
    const raw = this.#getString(`${TASK_PROJECTS_PREFIX}${taskId}`)
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : []
    } catch {
      return []
    }
  }

  /**
   * Replace a task's extra projects. De-duplicated, order kept, capped; an
   * empty list REMOVES the row — absence is what "no extra projects" means.
   */
  setTaskExtraProjects(taskId: string, roots: readonly string[]): string[] {
    const clean = [...new Set(roots.map((root) => root.trim()).filter((root) => root.length > 0))].slice(
      0,
      MAX_TASK_EXTRA_PROJECTS,
    )
    if (clean.length === 0) this.#deleteKey(`${TASK_PROJECTS_PREFIX}${taskId}`)
    else this.#setString(`${TASK_PROJECTS_PREFIX}${taskId}`, JSON.stringify(clean))
    return clean
  }

  /**
   * A description the context gate generated for a Workspace project. LOCAL ON
   * PURPOSE: a model's sentence is not something a teammate wrote, so it is
   * never written into the shared Workspace — only the gate on this computer
   * reads it, and only when the Workspace has no description of its own.
   */
  getGeneratedProjectDescription(workspace: string, project: string): string | null {
    const value = this.#getString(`${GENERATED_DESCRIPTION_PREFIX}${workspace}/${project}`)
    return value !== null && value.trim() !== '' ? value : null
  }

  setGeneratedProjectDescription(workspace: string, project: string, text: string): void {
    this.#setString(`${GENERATED_DESCRIPTION_PREFIX}${workspace}/${project}`, text)
  }

  /** Drop a deleted task's rows. */
  forgetTaskExtraProjects(taskId: string): void {
    this.#deleteKey(`${TASK_PROJECTS_PREFIX}${taskId}`)
    this.#deleteKey(`${TASK_PROJECTS_CHOSEN_PREFIX}${taskId}`)
  }

  /** Whether a person chose this task's projects (one row per such task). */
  isTaskProjectsChosen(taskId: string): boolean {
    return this.#getString(`${TASK_PROJECTS_CHOSEN_PREFIX}${taskId}`) === '1'
  }

  /** Record that a person chose this task's projects. */
  markTaskProjectsChosen(taskId: string): void {
    this.#setString(`${TASK_PROJECTS_CHOSEN_PREFIX}${taskId}`, '1')
  }

  /**
   * When knowledge last synced completely — a project's own knowledge repo
   * (`project`, keyed by its root) or a Workspace's (`workspace`, keyed by its
   * slug). Epoch ms, or null when never (or the row is unreadable). One row
   * per subject, so a write never reads-modifies-writes another's.
   */
  getKnowledgeLastSyncedAt(scope: KnowledgeSyncScope, id: string): number | null {
    const raw = this.#getString(`${KNOWLEDGE_LAST_SYNCED_PREFIX}${scope}:${id}`)
    if (raw === null) return null
    const at = Date.parse(raw)
    return Number.isFinite(at) ? at : null
  }

  setKnowledgeLastSyncedAt(scope: KnowledgeSyncScope, id: string, at: number): void {
    if (!Number.isFinite(at)) return
    this.#setString(`${KNOWLEDGE_LAST_SYNCED_PREFIX}${scope}:${id}`, new Date(at).toISOString())
  }
}
