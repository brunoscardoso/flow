// Blueprint pane state transitions — the pure decision layer behind
// blueprint-view.ts. Covers the derive-under-the-hood lifecycle: missing
// graph → one auto-derive → deriving → board | basic (fallback board with
// banner) | failed (only when even the basic graph is empty).

import {
  resolvePane,
  resolveHeaderActions,
  isCliUnavailable,
  shouldZoomOutOnEscape,
  type PaneInput,
} from './view-state'

/** Baseline input — override just what a case is about. */
function input(overrides: Partial<PaneInput>): PaneInput {
  return {
    hasRoot: true,
    hasGraph: false,
    hasBasicGraph: false,
    deriveState: 'idle',
    autoDeriveSpent: false,
    ...overrides,
  }
}

describe('resolvePane', () => {
  describe('the feature fetch is a wait, and waits get the pane', () => {
    it('shows the loader while the feature graph is in flight', () => {
      // THE REPORTED BUG. The snapshot read finishes, its loader goes away, and
      // the feature query is still running — with nothing on screen saying so.
      expect(
        resolvePane(input({ featuresPending: true, autoDeriveSpent: true, hasFeatures: false })),
      ).toBe('loading')
    })

    it('does not resolve that window as FAILURE, which is what it did', () => {
      // On any open after the first, auto-derive is spent and hasFeatures is
      // false only because nothing has arrived yet — and the board answered
      // that with "Blueprint could not be built".
      expect(
        resolvePane(input({ featuresPending: false, autoDeriveSpent: true, hasFeatures: false })),
      ).toBe('failed')
    })

    it('never flashes a loader over features already on screen', () => {
      // A refresh replaces rather than nulls, so the cells stay up while the
      // new ones are fetched.
      expect(
        resolvePane(input({ featuresPending: true, autoDeriveSpent: true, hasFeatures: true })),
      ).toBe('features')
    })

    it('yields to every state that outranks a wait', () => {
      expect(resolvePane(input({ featuresPending: true, hasRoot: false }))).toBe('no-project')
      expect(resolvePane(input({ featuresPending: true, hasGraph: true }))).toBe('board')
      expect(resolvePane(input({ featuresPending: true, hasBasicGraph: true }))).toBe('basic')
      expect(resolvePane(input({ featuresPending: true, provisioningState: 'provisioning' }))).toBe(
        'provisioning',
      )
    })

    it('absent reads as false — a caller that does not track it is unchanged', () => {
      expect(resolvePane(input({ autoDeriveSpent: true, hasFeatures: true }))).toBe('features')
    })
  })

  it('shows no-project without an active root, whatever else is going on', () => {
    expect(resolvePane(input({ hasRoot: false }))).toBe('no-project')
    expect(
      resolvePane(
        input({
          hasRoot: false,
          hasGraph: true,
          hasBasicGraph: true,
          deriveState: 'failed',
          autoDeriveSpent: true,
        }),
      ),
    ).toBe('no-project')
  })

  it('renders the board whenever a full graph exists (even mid-derive on Refresh)', () => {
    expect(resolvePane(input({ hasGraph: true, autoDeriveSpent: true }))).toBe('board')
    expect(
      resolvePane(input({ hasGraph: true, deriveState: 'running', autoDeriveSpent: true })),
    ).toBe('board')
  })

  it('the full graph always beats the basic fallback', () => {
    expect(
      resolvePane(input({ hasGraph: true, hasBasicGraph: true, autoDeriveSpent: true })),
    ).toBe('board')
  })

  it('auto-derives ONCE when the graph is missing and no attempt was spent', () => {
    expect(resolvePane(input({}))).toBe('auto-derive')
  })

  it('shows the deriving progress state while a derive runs with no graph at all', () => {
    expect(resolvePane(input({ deriveState: 'running', autoDeriveSpent: true }))).toBe('deriving')
  })

  it('falls back to the basic board after a failed derive when a basic graph exists', () => {
    expect(
      resolvePane(input({ hasBasicGraph: true, deriveState: 'failed', autoDeriveSpent: true })),
    ).toBe('basic')
  })

  it('keeps the basic board through a running retry-full-derive (no full-pane progress)', () => {
    expect(
      resolvePane(input({ hasBasicGraph: true, deriveState: 'running', autoDeriveSpent: true })),
    ).toBe('basic')
    expect(
      resolvePane(input({ hasBasicGraph: true, deriveState: 'idle', autoDeriveSpent: true })),
    ).toBe('basic')
  })

  it('settles on failed after a failed derive ONLY when even basic is empty', () => {
    expect(resolvePane(input({ deriveState: 'failed', autoDeriveSpent: true }))).toBe('failed')
  })

  it('never loops: a spent auto-derive that produced no graph is failed, not re-derived', () => {
    expect(resolvePane(input({ deriveState: 'idle', autoDeriveSpent: true }))).toBe('failed')
  })

  // ── provisioning gate (#513 phase 2) ─────────────────────────────────────
  it('shows the provisioning wait pane while the active root is provisioning', () => {
    expect(resolvePane(input({ provisioningState: 'provisioning' }))).toBe('provisioning')
  })

  it('provisioning gates even a full graph (assets are still being applied)', () => {
    expect(
      resolvePane(input({ provisioningState: 'provisioning', hasGraph: true, autoDeriveSpent: true })),
    ).toBe('provisioning')
  })

  it('no-project still wins over provisioning (no root to set up)', () => {
    expect(resolvePane(input({ hasRoot: false, provisioningState: 'provisioning' }))).toBe(
      'no-project',
    )
  })

  it('ready / idle / failed / absent provisioning fall through to the normal derive lifecycle', () => {
    expect(resolvePane(input({ provisioningState: 'ready', hasGraph: true }))).toBe('board')
    expect(resolvePane(input({ provisioningState: 'idle' }))).toBe('auto-derive')
    expect(resolvePane(input({ provisioningState: 'failed' }))).toBe('auto-derive')
    expect(resolvePane(input({ provisioningState: undefined, hasGraph: true }))).toBe('board')
  })
})

describe('resolveHeaderActions (#449)', () => {
  // #711: the "Sync status" surface moved INTO the Learning panel (reached via
  // the learn chip, hidden without a project/graph), so HeaderActions no longer
  // carries a showSync gate — no-project honesty holds by construction.
  it('turns the no-project empty state into an honest "Open Project…" CTA, no Refresh, no Sync (#711)', () => {
    const actions = resolveHeaderActions('no-project')
    expect(actions).toEqual({
      primaryLabel: 'Open Project…',
      primaryAction: 'open-project',
      primaryVariant: 'primary',
      showPrimary: true,
      // Nothing to learn without a project.
      showLearning: false,
    })
  })

  it('shows NO derive CTA on any project pane — the board derives itself', () => {
    // The old "New Blueprint" button ran plain derive(), which is what the
    // auto-derive pane already does for a project with no graph. It advertised
    // work that was already underway, in language ("New") that promised a
    // different action entirely.
    for (const pane of ['basic', 'deriving', 'auto-derive', 'failed', 'board'] as const) {
      const actions = resolveHeaderActions(pane)
      expect(actions.showPrimary).toBe(false)
      expect(actions.primaryLabel).not.toBe('New Blueprint')
    }
  })

  it('offers Learning on every pane that has a project', () => {
    // The learn chip toggles the same panel but hides itself when nothing has
    // been learned yet — the exact state where a user asks "is it learning?".
    for (const pane of ['basic', 'deriving', 'auto-derive', 'failed', 'board'] as const) {
      expect(resolveHeaderActions(pane).showLearning).toBe(true)
    }
  })

  it('hides Learning and the CTA while provisioning (#513 phase 2)', () => {
    // Mid-provision nothing is actionable: assets aren't in place, there is no
    // learning state, and nothing may claim sync freshness.
    expect(resolveHeaderActions('provisioning')).toEqual({
      primaryLabel: 'Open Project…',
      primaryAction: 'open-project',
      primaryVariant: 'ghost',
      showPrimary: false,
      showLearning: false,
    })
  })
})

describe('isCliUnavailable', () => {
  it('flags a missing/unspawnable planflow-ai CLI', () => {
    expect(isCliUnavailable('planflow-ai CLI not found for this project')).toBe(true)
    expect(isCliUnavailable('spawn planflow-ai ENOENT')).toBe(true)
    expect(isCliUnavailable('no usable CLI for /path')).toBe(true)
    expect(isCliUnavailable('command not found: planflow-ai')).toBe(true)
  })

  it('does not flag a real derive failure (the CLI ran and errored)', () => {
    expect(isCliUnavailable('canonical contract violation: bad node id')).toBe(false)
    expect(isCliUnavailable('Derive timed out after 60s')).toBe(false)
    expect(isCliUnavailable(null)).toBe(false)
    expect(isCliUnavailable(undefined)).toBe(false)
  })
})

describe('shouldZoomOutOnEscape (#221)', () => {
  it('zooms out only for Escape while visible with depth to pop', () => {
    expect(shouldZoomOutOnEscape('Escape', true, 2)).toBe(true)
  })

  it('ignores Escape when the board is hidden/closed (offsetParent null)', () => {
    // The core #221 fix: a background/closed board must not react to a global Escape.
    expect(shouldZoomOutOnEscape('Escape', false, 3)).toBe(false)
  })

  it('ignores Escape at the root layer (nothing to zoom out of)', () => {
    expect(shouldZoomOutOnEscape('Escape', true, 1)).toBe(false)
    expect(shouldZoomOutOnEscape('Escape', true, 0)).toBe(false)
  })

  it('ignores non-Escape keys', () => {
    expect(shouldZoomOutOnEscape('Enter', true, 2)).toBe(false)
    expect(shouldZoomOutOnEscape('Backspace', true, 2)).toBe(false)
  })
})

/**
 * #1436 — the feature board is not the code map, and must not die with it.
 *
 * A project whose `graph.json` cannot be produced (an unwritable `.structure/`,
 * a crashed extractor, a missing CLI) used to render ONE thing: "Blueprint could
 * not be generated for this project." Its features — the DEFAULT view, and a
 * store that is perfectly intact — were unreachable and unmentioned.
 *
 * The gate was never justified by a data dependency: the feature graph is
 * `readFeatures` + `readModuleLearning` + `computeFeatureLimitations`, and it
 * never opens `graph.json`. The board was refusing to draw something it was
 * fully capable of drawing.
 */
describe('#1436 — features survive a failed code-map derive', () => {
  const noGraph = {
    hasRoot: true,
    hasGraph: false,
    hasBasicGraph: false,
    deriveState: 'failed' as const,
    autoDeriveSpent: true,
  }

  it('draws the features when the derive failed but features exist', () => {
    expect(resolvePane({ ...noGraph, hasFeatures: true })).toBe('features')
  })

  it('still fails when there is genuinely nothing to show', () => {
    // No graph AND no features is the case the failure pane was written for.
    expect(resolvePane({ ...noGraph, hasFeatures: false })).toBe('failed')
    expect(resolvePane(noGraph)).toBe('failed')
  })

  it('prefers the real graph when there is one — features never mask a code map', () => {
    expect(resolvePane({ ...noGraph, hasGraph: true, hasFeatures: true })).toBe('board')
    expect(resolvePane({ ...noGraph, hasBasicGraph: true, hasFeatures: true })).toBe('basic')
  })

  it('does not jump the lifecycle: loading and deriving still win', () => {
    // Features on disk must not turn a run that is still working into a verdict.
    expect(resolvePane({ ...noGraph, hasFeatures: true, readPending: true })).toBe('loading')
    expect(
      resolvePane({ ...noGraph, hasFeatures: true, deriveState: 'running' }),
    ).toBe('deriving')
  })

  it('lets the one automatic derive happen first', () => {
    // With an unspent auto-derive, the answer is still "try the derive" — the
    // features pane is what a FAILED or exhausted derive falls back to, not a
    // reason to skip trying.
    expect(
      resolvePane({ ...noGraph, hasFeatures: true, deriveState: 'idle', autoDeriveSpent: false }),
    ).toBe('auto-derive')
  })

  it('keeps Learning reachable on the features pane', () => {
    // Refresh left the header entirely (2026-07-27 cleanup); the Learning
    // panel's ⟳ is the live re-derive control, so the panel must be reachable.
    expect(resolveHeaderActions('features').showLearning).toBe(true)
  })
})
