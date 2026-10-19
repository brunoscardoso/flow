// Onboarding wizard step controller (#48) — pure, DOM-free so it unit-tests
// under the CJS node jest. Owns step order, navigation, and per-step gating; the
// view renders whatever `current`/`canAdvance` report.

export type StepId =
  | 'welcome'
  | 'runtime'
  | 'connect'
  | 'project'
  | 'mode'
  | 'signIn'
  | 'settings'
  | 'workspace'

/**
 * The wizard steps in order: Welcome → Runtime → Connect → Project → Mode →
 * Sign in → Settings → Workspace.
 *
 * WORKSPACE IS LAST AND NEVER GATES (decision 2026-10-06). Every project lives
 * in a Workspace, so the step is always there: it shows the Default Workspace
 * Flow made (or is making) and lets the person rename it, or join their team's
 * instead. `canAdvance` has no case for it — Next is as complete an answer as
 * either. The per-project Knowledge step went with the per-project sync.
 *
 * PRIVACY IS NO LONGER HERE (user, 2026-09-22). It sat second to last on the
 * reasoning that by then somebody knows what Flow is — but they do not. They
 * have configured it, which is not the same as having used it, and the honest
 * answer to "may we collect usage data" before the first session is "I have no
 * idea what you even do".
 *
 * The question is now raised on the THIRD DAY THEY ACTUALLY USE FLOW, where it
 * is about something real — see `shared/consent-prompt.ts`. Nothing is
 * collected in the meantime, because unanswered is not a yes.
 *
 * SIGN-IN IS HERE AND IS SKIPPABLE (client-sign-in). Setup is when somebody
 * expects to be asked about accounts — the Claude connect step is two along —
 * so it is offered here. `canAdvance` is deliberately not given a case for it:
 * the app's ONLY account gate is `connect`, and a second one would break the
 * promise that signing in gates nothing. Pressing Next without signing in is
 * the same as pressing it after.
 *
 * RUNTIME COMES BEFORE CONNECT, and that ordering is the whole point of adding
 * it. "Connect a Claude account" was step two and a HARD gate, so a first-run
 * user who intends to work on Codex had to connect an Anthropic account they
 * may not have, just to reach the end — and only then find the runtime picker
 * in Settings. Which agent runs is the question that decides what connecting
 * even means.
 */
export const WIZARD_STEPS: readonly StepId[] = [
  'welcome',
  'runtime',
  'connect',
  'project',
  'mode',
  'signIn',
  'settings',
  // Always present (decision 2026-10-06): every project lives in a Workspace,
  // and this step shows the one Flow made (or is making) — rename it, or join
  // the team's instead. The per-project "Knowledge" step went with the
  // per-project knowledge sync.
  'workspace',
]

export type AutonomyMode = 'manual' | 'autonomous'

/** Live inputs the gating rules read (mirrors what the steps collect). */
export interface WizardState {
  /**
   * The runtime the user picked, and whether it is usable.
   *
   * `runtimeReady` is the SAME verdict the settings screen gates on — one rule
   * for "may this runtime be used", not a second one written for the wizard.
   */
  runtime: string | null
  runtimeReady: boolean
  accountConnected: boolean
  projectOpen: boolean
  mode: AutonomyMode | null
  /**
   * Whether this person has agreed to share usage data — and `null` while they
   * have not answered.
   *
   * NULL IS NOT A NO, AND NEVER A YES. It is the state before the question, and
   * it is why `canAdvance` blocks here: a consent step that advances without an
   * answer collects from somebody who was never asked, which is the single
   * worst bug this feature could have.
   */
  telemetryConsent: boolean | null
  /** The last mode click failed to persist (#1078). Tracked explicitly in state
   *  (not inferred from `mode === null`) because #716's reflection pre-sets
   *  `mode` before the user clicks anything — selection presence alone must
   *  never satisfy the gate while a save is known to have failed. Cleared only
   *  by a subsequent successful persist. */
  modePersistFailed: boolean
}

/**
 * Whether the wizard may advance past `step` given the current state. Steps with
 * a hard prerequisite block Next until it's met; the rest always advance.
 */
export function canAdvance(step: StepId, state: WizardState): boolean {
  switch (step) {
    case 'runtime':
      // A runtime nobody can sign into is an app that fails on its first turn —
      // EXCEPT Claude, whose sign-in is the very next step. Requiring a verified
      // Claude account here would deadlock the wizard on first run: no account
      // yet, so the check says "not signed in", so Next is blocked, so the user
      // never reaches the step that adds one. The other two have no later step —
      // their login lives in their own CLI — so for them this IS the gate.
      return state.runtime !== null && (state.runtime === 'claude' || state.runtimeReady)
    case 'connect':
      // CLAUDE'S ACCOUNT IS CLAUDE'S GATE. Under another runtime the sign-in
      // happened at the previous step (in that CLI's own login), and there is
      // no Flow-side account to connect — so this step reports rather than
      // blocks. Gating it on `accountConnected` would demand an Anthropic login
      // from someone who chose not to use Anthropic.
      return state.runtime !== null && state.runtime !== 'claude'
        ? true
        : state.accountConnected
    case 'project':
      return state.projectOpen
    case 'mode':
      // #229's guardrail, re-established after #716: an autopilot-relevant
      // choice that failed to save blocks progress until a retry succeeds.
      return state.mode !== null && !state.modePersistFailed
    default:
      return true
  }
}

export class WizardController {
  #index = 0
  readonly steps: readonly StepId[]

  constructor(steps: readonly StepId[] = WIZARD_STEPS) {
    if (steps.length === 0) throw new Error('[Wizard] needs at least one step')
    this.steps = steps
  }

  get current(): StepId {
    return this.steps[this.#index]
  }
  get index(): number {
    return this.#index
  }
  get total(): number {
    return this.steps.length
  }
  get isFirst(): boolean {
    return this.#index === 0
  }
  get isLast(): boolean {
    return this.#index === this.steps.length - 1
  }

  /** Advance to the next step; no-op on the last. Returns true when it moved. */
  next(): boolean {
    if (this.isLast) return false
    this.#index += 1
    return true
  }

  /** Go back a step; no-op on the first. Returns true when it moved. */
  back(): boolean {
    if (this.isFirst) return false
    this.#index -= 1
    return true
  }
}
