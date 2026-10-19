import {
  briefLayoutIds,
  briefUnavailableText,
  buildBriefNodeDetail,
  buildBriefView,
  ladderHighlight,
  type BriefDeltaInput,
  withoutCliInstruction,
} from './brief-view-model'

const delta: BriefDeltaInput = {
  nodes: [
    { nodeId: 'module:src/a', kind: 'stable', existsToday: true, label: 'a' },
    { nodeId: 'module:src/b', kind: 'modify', existsToday: true, label: 'b', stale: true },
    { nodeId: 'module:src/new', kind: 'new', existsToday: false, label: 'new' },
    { nodeId: 'module:src/gone', kind: 'remove', existsToday: true, label: 'gone' },
  ],
  wires: [
    { from: 'module:src/a', to: 'module:src/b', delta: 'kept', labelBefore: 'imports', labelAfter: 'imports', drawnToday: true },
    { from: 'module:src/a', to: 'module:src/new', delta: 'added', labelBefore: '', labelAfter: 'writes', drawnToday: false },
    { from: 'module:src/a', to: 'module:src/gone', delta: 'removed', labelBefore: 'writes', labelAfter: 'writes', drawnToday: true },
  ],
  unchanged: 'The UI is identical.',
  fails: ['persist throws', 'row absent on reload'],
}

const nodeView = (time: 'now' | 'next', id: string) =>
  buildBriefView(delta, time).nodes.find((n) => n.nodeId === id)!
const wireView = (time: 'now' | 'next', to: string) =>
  buildBriefView(delta, time).wires.find((w) => w.to === to)!

describe('TODAY paints only the pre-plan world', () => {
  it('does not paint a node the plan introduces', () => {
    const introduced = nodeView('now', 'module:src/new')
    expect(introduced.painted).toBe(false)
    expect(introduced.classes).toContain('t-absent')
  })

  it('paints a node the plan REMOVES — it still exists today', () => {
    const removed = nodeView('now', 'module:src/gone')
    expect(removed.painted).toBe(true)
    expect(removed.classes).not.toContain('t-absent')
  })

  it('never ghosts: an absent node carries no delta class and no badge', () => {
    const introduced = nodeView('now', 'module:src/new')
    expect(introduced.classes).not.toContain('d-new')
    expect(introduced.badge).toBeNull()
  })

  it('shows no delta styling at all — a card looks like an ordinary board card', () => {
    for (const node of buildBriefView(delta, 'now').nodes) {
      expect(node.classes.filter((c) => c.startsWith('d-'))).toEqual([])
      expect(node.badge).toBeNull()
    }
  })

  it('withholds added wires and draws the rest', () => {
    expect(wireView('now', 'module:src/new').drawn).toBe(false)
    expect(wireView('now', 'module:src/b').drawn).toBe(true)
    expect(wireView('now', 'module:src/gone').drawn).toBe(true)
  })

  it('has no band and no ladder, and reports a component census instead', () => {
    const view = buildBriefView(delta, 'now')
    expect(view.unchangedBand).toBeNull()
    expect(view.showLadder).toBe(false)
    expect(view.census).toEqual({ components: 3 })
  })

  it('offers slots that never reference the plan', () => {
    expect(buildBriefView(delta, 'now').slots).toEqual(['todayHow', 'todayProblems', 'verify'])
  })
})

describe('AFTER paints the delta', () => {
  it('tints and badges each changed node', () => {
    expect(nodeView('next', 'module:src/new').classes).toEqual(expect.arrayContaining(['d-new', 'show-badge']))
    expect(nodeView('next', 'module:src/new').badge).toBe('new')
    expect(nodeView('next', 'module:src/b').badge).toBe('changed')
    expect(nodeView('next', 'module:src/gone').badge).toBe('removed')
  })

  it('leaves a stable node untouched', () => {
    const stable = nodeView('next', 'module:src/a')
    expect(stable.classes).toEqual([])
    expect(stable.badge).toBeNull()
  })

  it('draws every wire and strikes the dead one', () => {
    expect(wireView('next', 'module:src/new').drawn).toBe(true)
    expect(wireView('next', 'module:src/new').classes).toContain('w-added')
    expect(wireView('next', 'module:src/gone').classes).toContain('w-dead')
    expect(wireView('next', 'module:src/gone').struck).toBe(true)
    expect(wireView('next', 'module:src/b').struck).toBe(false)
  })

  it('shows the band and the ladder', () => {
    const view = buildBriefView(delta, 'next')
    expect(view.unchangedBand).toBe('The UI is identical.')
    expect(view.showLadder).toBe(true)
    expect(view.census).toBeNull()
    expect(view.slots).toEqual(['why', 'fails', 'rollout', 'verify'])
  })

  it('hides the band when no unchanged was authored — never renders it empty', () => {
    const { unchanged, ...rest } = delta
    expect(buildBriefView(rest as BriefDeltaInput, 'next').unchangedBand).toBeNull()
  })
})

describe('the layout is identical across states', () => {
  it('lays out the union of both worlds, so nothing moves on a flip', () => {
    const ids = briefLayoutIds(delta)
    expect(ids).toHaveLength(delta.nodes.length)
    // Every node the AFTER state paints is present in the layout the TODAY
    // state used — that is what keeps positions stable.
    const paintedAfter = buildBriefView(delta, 'next').nodes.map((n) => n.nodeId)
    expect(ids).toEqual(expect.arrayContaining(paintedAfter))
  })

  it('emits the same node list in both states (only paint differs)', () => {
    const now = buildBriefView(delta, 'now').nodes.map((n) => n.nodeId)
    const next = buildBriefView(delta, 'next').nodes.map((n) => n.nodeId)
    expect(now).toEqual(next)
  })
})

describe('drift dot', () => {
  it('shows in both worlds — drift is a fact about the code, not the plan', () => {
    expect(nodeView('now', 'module:src/b').staleDot).toBe(true)
    expect(nodeView('next', 'module:src/b').staleDot).toBe(true)
    expect(nodeView('next', 'module:src/a').staleDot).toBe(false)
  })
})

describe('the band flips meaning with the state', () => {
  const withStory: BriefDeltaInput = {
    ...delta,
    steps: [
      { title: 'The duplicate', kicker: 'Problem', body: 'Reload duplicates a turn.', decisions: [], rejected: [] },
      { title: 'Two worlds', kicker: 'Shape', body: 'One id everywhere.', decisions: ['mint up front'], rejected: ['text match'] },
    ],
  }

  it('AFTER carries the authored guarantee', () => {
    const band = buildBriefView(withStory, 'next').band!
    expect(band.tone).toBe('guarantee')
    expect(band.label).toBe('Unchanged')
    expect(band.text).toBe('The UI is identical.')
  })

  it('TODAY carries the derived problem, never the guarantee', () => {
    const band = buildBriefView(withStory, 'now').band!
    expect(band.tone).toBe('problem')
    expect(band.label).toBe('Known issue')
    expect(band.text).toBe('Reload duplicates a turn.')
  })

  it('shows NO band when no step is kickered Problem', () => {
    // This used to fall back to steps[0], on the assumption that a concept arc
    // always opens on the problem. Plans authored as PHASES do not, and the
    // fallback rendered "KNOWN ISSUE — Close the doors first" against a real
    // plan: a phase title presented as a defect that does not exist. A band is
    // a claim about the present; none is better than an invented one.
    const noKicker: BriefDeltaInput = {
      ...delta,
      steps: [{ title: 'First', body: 'First body.', decisions: [], rejected: [] }],
    }
    expect(buildBriefView(noKicker, 'now').band).toBeNull()
  })

  it('renders no band at all rather than an empty one', () => {
    expect(buildBriefView(delta, 'now').band).toBeNull() // no steps supplied
    const { unchanged, ...noGuarantee } = delta
    expect(buildBriefView(noGuarantee as BriefDeltaInput, 'next').band).toBeNull()
  })
})

describe('verification ledger', () => {
  const withAnchors: BriefDeltaInput = {
    ...delta,
    anchors: [
      { ref: 'module:src/a', resolved: true },
      { ref: 'module:src/b', resolved: true },
      { ref: 'file:src/missing.ts', resolved: false },
    ],
  }

  it('counts resolved anchors and NAMES the unresolved ones', () => {
    const ledger = buildBriefView(withAnchors, 'next').ledger
    expect(ledger.resolved).toBe(2)
    expect(ledger.unresolved).toEqual(['file:src/missing.ts'])
  })

  it('counts authored claims — unchanged plus every fails entry', () => {
    // 1 unchanged + 2 fails
    expect(buildBriefView(withAnchors, 'next').ledger.authoredClaims).toBe(3)
  })

  it('attributes no authored claims to TODAY — they are all about the change', () => {
    expect(buildBriefView(withAnchors, 'now').ledger.authoredClaims).toBe(0)
  })
})

describe('node drawer detail', () => {
  const notes = [
    {
      anchorRefs: ['module:src/a'],
      summary: 'The placeholder row is what makes reconnect possible.',
      provenance: 'blueprint observe · run x',
      stale: false,
    },
    {
      anchorRefs: ['file:src/a/deep/thing.ts'],
      summary: 'A file-level fact that rolls up to the module card.',
      provenance: 'blueprint observe · run y',
      stale: true,
    },
    { anchorRefs: ['module:src/elsewhere'], summary: 'Unrelated.', provenance: 'z' },
  ]

  it('attaches exact-match AND rolled-up file notes to a module card', () => {
    const detail = buildBriefNodeDetail(delta, 'module:src/a', notes)!
    expect(detail.notes.map((n) => n.summary)).toEqual([
      'The placeholder row is what makes reconnect possible.',
      'A file-level fact that rolls up to the module card.',
    ])
    expect(detail.notes[1].stale).toBe(true)
  })

  it('does not attach a note anchored to a different module', () => {
    const detail = buildBriefNodeDetail(delta, 'module:src/b', notes)!
    expect(detail.notes).toEqual([])
  })

  it('states what the node is today and what it becomes', () => {
    expect(buildBriefNodeDetail(delta, 'module:src/new', [])!.today).toBeNull()
    expect(buildBriefNodeDetail(delta, 'module:src/new', [])!.after).toBe('Introduced by this plan.')
    expect(buildBriefNodeDetail(delta, 'module:src/gone', [])!.after).toBeNull()
    expect(buildBriefNodeDetail(delta, 'module:src/gone', [])!.today).toBe('Present today.')
  })

  it('lists wires from this node\'s point of view, with direction', () => {
    const detail = buildBriefNodeDetail(delta, 'module:src/a', [])!
    expect(detail.wires.every((w) => w.direction === 'out')).toBe(true)
    expect(detail.wires.map((w) => w.other).sort()).toEqual([
      'module:src/b',
      'module:src/gone',
      'module:src/new',
    ])
    const inbound = buildBriefNodeDetail(delta, 'module:src/b', [])!
    expect(inbound.wires[0].direction).toBe('in')
  })

  it('returns null for a node the delta does not know — caller falls back', () => {
    expect(buildBriefNodeDetail(delta, 'module:src/unknown', [])).toBeNull()
  })
})

describe('ladder highlight', () => {
  it('lights only the touched nodes and dims the rest', () => {
    const { lit, dimmed } = ladderHighlight(delta, ['module:src/a', 'module:src/new'])
    expect(lit.sort()).toEqual(['module:src/a', 'module:src/new'])
    expect(dimmed.sort()).toEqual(['module:src/b', 'module:src/gone'].sort())
  })

  it('dims nothing for an unknown phase — never invents a highlight', () => {
    const { lit, dimmed } = ladderHighlight(delta, [])
    expect(dimmed).toEqual([])
    expect(lit).toHaveLength(delta.nodes.length)
  })
})

describe('feature identity — a brief that draws nothing still says something', () => {
  const bare = { nodes: [], wires: [], fails: [] }

  it('carries the feature name and prose into the view', () => {
    const view = buildBriefView(
      { ...bare, identity: { name: 'Playbooks', prose: 'Reusable multi-step runs.', children: [] } },
      'now',
    )
    expect(view.intro).toEqual({ name: 'Playbooks', prose: 'Reusable multi-step runs.', children: [] })
    // The point: zero cards, and the drawer is still not blank.
    expect(view.nodes).toEqual([])
  })

  it('lists the change records filed under the feature', () => {
    const view = buildBriefView(
      { ...bare, identity: { name: 'Chats', prose: '', children: [{ id: 'feature:chat-session-cache-rework', name: 'Chat Session Cache Rework' }] } },
      'now',
    )
    // Children carry ids: the brief's Changes row is now the ONLY way to reach
    // a change record, and a name alone can be printed but not opened.
    expect(view.intro?.children).toEqual([
      { id: 'feature:chat-session-cache-rework', name: 'Chat Session Cache Rework' },
    ])
  })

  it('is null for a plan-scoped brief, which is about a change, not a feature', () => {
    expect(buildBriefView(bare, 'now').intro).toBeNull()
  })

  it('survives the time flip — identity does not change with the state', () => {
    const delta = { ...bare, identity: { name: 'Spaces', prose: 'p', children: [] } }
    expect(buildBriefView(delta, 'next').intro).toEqual(buildBriefView(delta, 'now').intro)
  })
})

// ── Time switch ──────────────────────────────────────────────
//
// Reported: a FEATURE brief (no plan in flight) still offered
// "Today · before this plan" / "After · this plan" — a control naming a plan
// that does not exist. The CLI has always said which world it is describing;
// the renderer simply dropped `mode`.

describe('showTimeSwitch', () => {
  const base = { nodes: [], wires: [], fails: [] }

  it('is hidden for an anatomy brief — there is no plan to be before or after', () => {
    expect(buildBriefView({ ...base, mode: 'anatomy' }, 'now').showTimeSwitch).toBe(false)
  })

  it('is shown for a delta brief — two worlds to move between', () => {
    expect(buildBriefView({ ...base, mode: 'delta' }, 'now').showTimeSwitch).toBe(true)
  })

  it('defaults to shown when mode is absent — back-compat with pre-feature briefs', () => {
    expect(buildBriefView(base, 'now').showTimeSwitch).toBe(true)
  })

  it('does not depend on the time being viewed', () => {
    expect(buildBriefView({ ...base, mode: 'anatomy' }, 'next').showTimeSwitch).toBe(false)
    expect(buildBriefView({ ...base, mode: 'delta' }, 'next').showTimeSwitch).toBe(true)
  })
})

// ── The KNOWN ISSUE band ────────────────────────────────────────────────
//
// The band is a claim about the PRESENT. It used to fall back to the story's
// first step, so a plan authored as phases showed "KNOWN ISSUE — Close the
// doors first": a phase title presented as a defect that does not exist.

describe('problem band', () => {
  const base = { nodes: [], wires: [], fails: [] }
  const step = (title: string, kicker?: string) => ({
    title,
    ...(kicker !== undefined ? { kicker } : {}),
    body: '',
    decisions: [],
    rejected: [],
  })

  it('shows the band when a step is explicitly the problem', () => {
    const view = buildBriefView({ ...base, steps: [step('Reload duplicates a turn', 'Problem')] }, 'now')
    expect(view.band?.text).toBe('Reload duplicates a turn')
  })

  it('shows NO band when the story is phases, not a concept arc', () => {
    const view = buildBriefView(
      {
        ...base,
        steps: [
          step('Close the doors first', 'Land the security prerequisites before anything moves'),
          step('Give the engine a real chat', 'Build the schema'),
        ],
      },
      'now',
    )
    expect(view.band).toBeNull()
  })

  it('finds the problem step wherever it sits in the arc', () => {
    const view = buildBriefView(
      { ...base, steps: [step('Shape', 'Shape'), step('The id mismatch', 'problem')] },
      'now',
    )
    expect(view.band?.text).toBe('The id mismatch')
  })
})

describe('withoutCliInstruction — a terminal instruction on a board', () => {
  it('keeps the reason and drops the invocation', () => {
    // The exact refusal a live run surfaced when a feature's proposal chip was
    // pressed for a plan nobody had narrated.
    expect(
      withoutCliInstruction(
        "no compiled story for 'tenant_id_alias_consolidation' — run `blueprint narrate --from <plan-doc>` first",
      ),
    ).toBe("no compiled story for 'tenant_id_alias_consolidation'")
  })

  it('leaves a reason that carries no command exactly as it was', () => {
    expect(withoutCliInstruction('no active project')).toBe('no active project')
  })

  it('never empties a reason that was ONLY an instruction', () => {
    // Something is better than a blank band: the reader at least sees that the
    // refusal had words in it.
    const only = 'run `blueprint narrate` first'
    expect(withoutCliInstruction(only)).toBe(only)
  })

  it('leaves no dangling dash where the clause was', () => {
    expect(withoutCliInstruction('nothing to show — run `x` first')).toBe('nothing to show')
  })

  it('is applied by the band the reader actually sees', () => {
    const text = briefUnavailableText("no compiled story for 'p' — run `blueprint narrate` first")
    expect(text).not.toContain('`')
    expect(text).not.toContain('blueprint narrate')
    expect(text).toContain("no compiled story for 'p'")
    // …and still says what a person here can actually do.
    expect(text).toContain('Ask the agent to narrate one')
  })
})
