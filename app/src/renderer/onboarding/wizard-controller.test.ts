import { WizardController, WIZARD_STEPS, canAdvance } from './wizard-controller'

describe('WizardController', () => {
  it('starts at the first step and reports position', () => {
    const w = new WizardController()
    expect(w.current).toBe('welcome')
    expect(w.index).toBe(0)
    expect(w.total).toBe(WIZARD_STEPS.length)
    expect(w.isFirst).toBe(true)
    expect(w.isLast).toBe(false)
  })

  it('advances and goes back within bounds', () => {
    const w = new WizardController()
    expect(w.next()).toBe(true)
    // Runtime is step two now — which agent runs decides what "connect" means.
    expect(w.current).toBe('runtime')
    expect(w.back()).toBe(true)
    expect(w.current).toBe('welcome')
    expect(w.back()).toBe(false) // no-op at the first step
  })

  it('clamps at the last step', () => {
    const w = new WizardController(['welcome', 'connect'])
    w.next()
    expect(w.isLast).toBe(true)
    expect(w.next()).toBe(false)
    expect(w.current).toBe('connect')
  })

  it('throws on empty steps', () => {
    expect(() => new WizardController([])).toThrow(/at least one step/)
  })
})

describe('canAdvance', () => {
  const base = {
    // The default first-run shape: Claude picked and verified, which is what
    // every assertion below was written against before the runtime step existed.
    runtime: 'claude',
    runtimeReady: true,
    accountConnected: false,
    projectOpen: false,
    mode: null,
    modePersistFailed: false,
    telemetryConsent: null,
  }

  it('blocks connect until an account is connected', () => {
    expect(canAdvance('connect', base)).toBe(false)
    expect(canAdvance('connect', { ...base, accountConnected: true })).toBe(true)
  })

  it('blocks project until a project is open', () => {
    expect(canAdvance('project', base)).toBe(false)
    expect(canAdvance('project', { ...base, projectOpen: true })).toBe(true)
  })

  it('blocks mode until a mode is chosen', () => {
    expect(canAdvance('mode', base)).toBe(false)
    expect(canAdvance('mode', { ...base, mode: 'autonomous' })).toBe(true)
  })

  it('blocks mode while the last persist failed, even with a mode selected (#1078)', () => {
    // #716's reflection pre-sets `mode` before any click — selection presence
    // alone must not defeat #229's "Next stays gated on a failed save".
    expect(canAdvance('mode', { ...base, mode: 'manual', modePersistFailed: true })).toBe(false)
    expect(canAdvance('mode', { ...base, mode: 'autonomous', modePersistFailed: true })).toBe(false)
    // A successful retry clears the flag and re-opens the gate.
    expect(canAdvance('mode', { ...base, mode: 'autonomous', modePersistFailed: false })).toBe(true)
  })

  it('always allows welcome and settings', () => {
    expect(canAdvance('welcome', base)).toBe(true)
    expect(canAdvance('settings', base)).toBe(true)
  })
})

describe('the runtime step gates on the runtime, not on Claude', () => {
  const base = {
    runtime: null as string | null,
    runtimeReady: false,
    accountConnected: false,
    projectOpen: false,
    mode: null,
    modePersistFailed: false,
    telemetryConsent: null,
  }

  it('blocks an EXTERNAL runtime until it is usable', () => {
    expect(canAdvance('runtime', base)).toBe(false)
    expect(canAdvance('runtime', { ...base, runtime: 'codex' })).toBe(false)
    expect(canAdvance('runtime', { ...base, runtime: 'codex', runtimeReady: true })).toBe(true)
  })

  it('never blocks CLAUDE here — its sign-in is the next step', () => {
    // The deadlock this avoids: on first run there is no account yet, so the
    // check says "not signed in"; gating on that would stop the user reaching
    // the step that adds one.
    expect(canAdvance('runtime', { ...base, runtime: 'claude', runtimeReady: false })).toBe(true)
    // …and the account is still demanded one step later.
    expect(
      canAdvance('connect', { ...base, runtime: 'claude', accountConnected: false }),
    ).toBe(false)
  })

  it('stops demanding a Claude account from someone who did not choose Claude', () => {
    // The gate that made this step necessary: "Connect a Claude account" was a
    // hard prerequisite, so a first-run user who wanted Codex had to connect an
    // Anthropic account to reach the end of the wizard.
    const codex = { ...base, runtime: 'codex', runtimeReady: true }
    expect(canAdvance('connect', codex)).toBe(true)
    expect(canAdvance('connect', { ...codex, accountConnected: false })).toBe(true)
  })

  it('still demands one when Claude IS the runtime', () => {
    const claude = { ...base, runtime: 'claude', runtimeReady: true }
    expect(canAdvance('connect', claude)).toBe(false)
    expect(canAdvance('connect', { ...claude, accountConnected: true })).toBe(true)
  })
})

describe('the consent step gates on an ANSWER, not on consent', () => {
  const base = {
    runtime: 'claude',
    runtimeReady: true,
    accountConnected: true,
    projectOpen: true,
    mode: 'manual' as const,
    modePersistFailed: false,
    telemetryConsent: null,
  }

  // THE WIZARD NO LONGER ASKS (user, 2026-09-22). It used to gate a step on an
  // answer; the question now appears on the third day somebody actually uses
  // Flow, where it is about something they have experienced rather than about a
  // product they have only configured.
  //
  // These three tests pinned that gate. What replaces them is the invariant
  // that matters now: the step is gone, so nobody is asked twice.
  // SIGN-IN IS OFFERED AND NEVER REQUIRED (client-sign-in).
  //
  // The app's only account gate is `connect`. A second one would break the
  // promise that signing in gates nothing — which is the whole reason
  // `identity-is-not-a-gate.test.ts` exists — so this pins that `canAdvance`
  // treats the step as freely passable.
  it('offers sign-in as a step', () => {
    expect(WIZARD_STEPS).toContain('signIn')
  })

  it('lets somebody past sign-in without signing in', () => {
    // POSITIVE BEFORE ABSENCE: the wizard still gates on what it should, so
    // this is a real freedom rather than a controller that gates on nothing.
    expect(canAdvance('mode', { ...base, mode: null })).toBe(false)
    expect(canAdvance('signIn', base)).toBe(true)
  })

  it('puts sign-in after the work is set up, not before', () => {
    // Asking who somebody is before they have seen the product is the mistake
    // that moved the telemetry question out of this wizard entirely.
    expect(WIZARD_STEPS.indexOf('signIn')).toBeGreaterThan(WIZARD_STEPS.indexOf('project'))
  })

  it('does not ask about telemetry at all', () => {
    expect(WIZARD_STEPS).not.toContain('privacy')
  })

  it('never blocks the wizard on an unanswered telemetry question', () => {
    // POSITIVE BEFORE ABSENCE: the wizard still gates on the things it should,
    // so this is a real absence and not a controller that gates on nothing.
    expect(canAdvance('mode', { ...base, mode: null })).toBe(false)
    for (const step of WIZARD_STEPS) {
      expect(canAdvance(step, { ...base, telemetryConsent: null })).toBe(
        canAdvance(step, { ...base, telemetryConsent: true }),
      )
    }
  })

  it('does not gate any OTHER step on consent', () => {
    // A consent answer must never become a hidden prerequisite elsewhere.
    for (const step of ['welcome', 'runtime', 'connect', 'project', 'mode', 'settings', 'workspace'] as const) {
      const withAnswer = canAdvance(step, { ...base, telemetryConsent: true })
      const without = canAdvance(step, { ...base, telemetryConsent: null })
      expect(withAnswer).toBe(without)
    }
  })
})

describe('the Workspace step is always there, last, and never gates', () => {
  const base = {
    runtime: 'claude',
    runtimeReady: true,
    accountConnected: true,
    projectOpen: true,
    mode: 'manual' as const,
    modePersistFailed: false,
    telemetryConsent: null,
  }

  it('comes right after the settings summary, as the last step — and there is no Knowledge step', () => {
    expect(WIZARD_STEPS).toContain('workspace')
    expect(WIZARD_STEPS.indexOf('workspace')).toBe(WIZARD_STEPS.indexOf('settings') + 1)
    expect(WIZARD_STEPS[WIZARD_STEPS.length - 1]).toBe('workspace')
    expect(WIZARD_STEPS as readonly string[]).not.toContain('knowledge')
  })

  it('the controller walks onto it and finishes there', () => {
    const w = new WizardController()
    while (w.next()) {
      /* walk to the end */
    }
    expect(w.current).toBe('workspace')
    expect(w.isLast).toBe(true)
    expect(w.back()).toBe(true)
    expect(w.current).toBe('settings')
  })

  it('advances whatever state the wizard is in', () => {
    // POSITIVE BEFORE ABSENCE: the same states DO gate the steps that should.
    const nothing = { ...base, accountConnected: false, projectOpen: false, mode: null }
    expect(canAdvance('project', nothing)).toBe(false)
    expect(canAdvance('mode', nothing)).toBe(false)
    expect(canAdvance('workspace', nothing)).toBe(true)
    expect(canAdvance('workspace', base)).toBe(true)
  })
})
