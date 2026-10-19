// Node-popover content model — pure logic, no DOM (node env). Covers content
// assembly, the annotation cap + '…and K more', feature membership by file
// containment, ghost/plan badge, review reason lines, and action availability.

import type {
  BlueprintAnnotation,
  BlueprintFeature,
  BlueprintInvestigation,
  BlueprintLearningEntry,
  BlueprintMustReviewItem,
  BlueprintNode,
} from '../../shared/ipc-contract'
import type { FlowNode } from './flow-model'
import {
  MAX_POPOVER_ANNOTATIONS,
  buildPopoverContent,
  featuresForNode,
  learningForModule,
  resolveActiveTab,
  type PopoverInput,
} from './popover-model'

// ── Fixtures ───────────────────────────────────────────────────────────────
const moduleNode: BlueprintNode = {
  id: 'module:app/src/main',
  kind: 'module',
  label: 'main',
  sourceFile: 'app/src/main',
  meta: { depth: 1, degree: 8 },
}

function moduleFlow(overrides: Partial<FlowNode> = {}): FlowNode {
  return { id: 'module:app/src/main', kind: 'module', label: 'main', childCount: 3, ...overrides }
}

function annotation(overrides: Partial<BlueprintAnnotation> = {}): BlueprintAnnotation {
  return {
    ts: '2026-07-15T00:00:00Z',
    runId: null,
    type: 'decision',
    text: 'A decision',
    anchors: [{ kind: 'module', ref: 'module:app/src/main' }],
    provenance: 'test',
    status: 'active',
    ...overrides,
  }
}

function feature(overrides: Partial<BlueprintFeature> = {}): BlueprintFeature {
  return {
    feature: 'coffee',
    plan: 'plan_coffee_v1.md',
    archived: false,
    phases: [{ phase: 'phase-1', label: 'Phase 1', title: 'Setup', files: ['app/src/main/index.ts'] }],
    fileCount: 1,
    ...overrides,
  }
}

function input(overrides: Partial<PopoverInput> = {}): PopoverInput {
  return {
    node: moduleFlow(),
    graphNodes: [moduleNode],
    annotations: [],
    features: [],
    reviewItems: [],
    ...overrides,
  }
}

// ── featuresForNode ──────────────────────────────────────────────────────────
describe('featuresForNode', () => {
  it('matches a feature and carries its plan-doc path (clickable → peek)', () => {
    expect(featuresForNode([moduleNode], [feature()])).toEqual([
      { slug: 'coffee', docPath: 'flow/plans/plan_coffee_v1.md' },
    ])
  })

  it('points an ARCHIVED (completed) feature at flow/archive/', () => {
    expect(featuresForNode([moduleNode], [feature({ archived: true })])).toEqual([
      { slug: 'coffee', docPath: 'flow/archive/plan_coffee_v1.md' },
    ])
  })

  it('requires exact sourceFile equality for a non-module node', () => {
    const ds: BlueprintNode = { id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite', sourceFile: 'app/db.ts' }
    const hit = feature({ feature: 'db', plan: 'plan_db_v1.md', phases: [{ phase: 'p', label: 'P', title: '', files: ['app/db.ts'] }] })
    const miss = feature({ feature: 'other', phases: [{ phase: 'p', label: 'P', title: '', files: ['app/db.ts/x'] }] })
    expect(featuresForNode([ds], [hit, miss])).toEqual([
      { slug: 'db', docPath: 'flow/plans/plan_db_v1.md' },
    ])
  })

  it('returns features sorted by slug, unique, omitting non-matching', () => {
    const b = feature({ feature: 'bravo' })
    const a = feature({ feature: 'alpha' })
    const none = feature({ feature: 'zulu', phases: [{ phase: 'p', label: 'P', title: '', files: ['other/x.ts'] }] })
    expect(featuresForNode([moduleNode], [b, a, none]).map((f) => f.slug)).toEqual(['alpha', 'bravo'])
  })

  it('returns [] for a ghost (no underlying graph nodes)', () => {
    expect(featuresForNode([], [feature()])).toEqual([])
  })
})

// ── buildPopoverContent ──────────────────────────────────────────────────────
describe('buildPopoverContent', () => {
  it('assembles eyebrow, label and mono id for a module', () => {
    const content = buildPopoverContent(input())
    expect(content.eyebrow).toBe('module')
    expect(content.label).toBe('main')
    expect(content.id).toBe('module:app/src/main')
    expect(content.ghost).toBe(false)
    expect(content.canDrill).toBe(true)
    expect(content.attach).toEqual({ nodeId: 'module:app/src/main', label: 'main', kind: 'module', proposal: false })
  })

  it('maps annotations to lines and marks stale ones', () => {
    const content = buildPopoverContent(
      input({
        annotations: [
          annotation({ text: 'live', status: 'active', type: 'rule' }),
          annotation({ text: 'gone', status: 'stale' }),
        ],
      }),
    )
    expect(content.annotations).toEqual([
      { type: 'rule', text: 'live', stale: false, peekPath: null },
      { type: 'decision', text: 'gone', stale: true, peekPath: null },
    ])
    expect(content.moreAnnotations).toBe(0)
  })

  it('surfaces a peek path from an annotation anchor that names a file', () => {
    const content = buildPopoverContent(
      input({
        annotations: [
          annotation({ text: 'see this', anchors: [{ kind: 'file', ref: 'app/src/main/index.ts' }] }),
          annotation({
            text: 'symbol scoped',
            anchors: [{ kind: 'symbol', ref: 'foo', file: 'app/src/main/foo.ts' }],
          }),
          annotation({ text: 'no file', anchors: [{ kind: 'module', ref: 'app/src/main' }] }),
        ],
      }),
    )
    expect(content.annotations.map((line) => line.peekPath)).toEqual([
      'app/src/main/index.ts',
      'app/src/main/foo.ts',
      null,
    ])
  })

  it('caps annotations and reports the overflow count', () => {
    const many = Array.from({ length: MAX_POPOVER_ANNOTATIONS + 3 }, (_, i) =>
      annotation({ text: `note ${i}` }),
    )
    const content = buildPopoverContent(input({ annotations: many }))
    expect(content.annotations).toHaveLength(MAX_POPOVER_ANNOTATIONS)
    expect(content.moreAnnotations).toBe(3)
  })

  it('surfaces feature membership from the features list', () => {
    const content = buildPopoverContent(input({ features: [feature()] }))
    expect(content.features).toEqual([{ slug: 'coffee', docPath: 'flow/plans/plan_coffee_v1.md' }])
  })

  it('shows ghost state + plan badge and hides the id for a ghost', () => {
    const content = buildPopoverContent(
      input({
        node: moduleFlow({ ghost: true, ghostState: 'proposed', sublabel: 'plan_x', childCount: 0 }),
        graphNodes: [],
      }),
    )
    expect(content.ghost).toBe(true)
    expect(content.ghostState).toBe('proposed')
    expect(content.planBadge).toBe('plan_x')
    expect(content.id).toBeNull()
    expect(content.eyebrow).toBe('module · proposal')
    expect(content.canDrill).toBe(false)
    expect(content.attach.proposal).toBe(true)
  })

  it('emits deduped review reason lines only when the node is badged', () => {
    const items: BlueprintMustReviewItem[] = [
      { rank: 1, severity: 'high', title: 'god node', detail: 'd', nodeId: 'module:app/src/main', source: 's' },
      { rank: 2, severity: 'ask', title: 'god node', detail: 'd2', nodeId: 'module:app/src/main', source: 's' },
      { rank: 3, severity: 'crit', title: 'spans communities', detail: 'd3', nodeId: 'module:app/src/main', source: 's' },
    ]
    const badged = buildPopoverContent(
      input({ node: moduleFlow({ mustReview: { severity: 'crit', title: 'spans communities', count: 3 } }), reviewItems: items }),
    )
    expect(badged.reviewReasons).toEqual(['god node', 'spans communities'])

    const unbadged = buildPopoverContent(input({ reviewItems: items }))
    expect(unbadged.reviewReasons).toEqual([])
  })

  it('canDrill is false for a module with no children', () => {
    expect(buildPopoverContent(input({ node: moduleFlow({ childCount: 0 }) })).canDrill).toBe(false)
  })

  it('attaches learning info for a module and defaults to unlearned', () => {
    const content = buildPopoverContent(input())
    expect(content.learning).toEqual({ status: null, action: 'learn' })
  })

  it('attaches learning info from the snapshot learning + investigations', () => {
    const content = buildPopoverContent(
      input({
        learning: [learnEntry({ status: 'learned' })],
        investigations: [note({ summary: 'main wires the IPC surface' })],
      }),
    )
    expect(content.learning).toEqual({
      status: 'learned',
      action: 'relearn',
      learnedAt: '2026-07-15T00:00:00Z',
      docHint: 'flow/brain/modules/app-src-main.md',
      noteSummary: 'main wires the IPC surface',
    })
  })

  it('has null learning for a ghost (no learning affordance)', () => {
    const content = buildPopoverContent(
      input({
        node: moduleFlow({ ghost: true, ghostState: 'proposed', childCount: 0 }),
        graphNodes: [],
        learning: [learnEntry({ status: 'learned' })],
      }),
    )
    expect(content.learning).toBeNull()
  })

  it('has null learning for a non-module node', () => {
    const ds: FlowNode = { id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite' }
    const content = buildPopoverContent(input({ node: ds, graphNodes: [] }))
    expect(content.learning).toBeNull()
  })

  it('surfaces sourceDir from the underlying graph node for a non-ghost module', () => {
    const content = buildPopoverContent(input())
    expect(content.sourceDir).toBe('app/src/main')
  })

  it('has null sourceDir for a ghost module (no underlying graph node)', () => {
    const content = buildPopoverContent(
      input({ node: moduleFlow({ ghost: true, ghostState: 'proposed', childCount: 0 }), graphNodes: [] }),
    )
    expect(content.sourceDir).toBeNull()
  })

  it('has null sourceDir for a non-module node', () => {
    const ds: FlowNode = { id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite' }
    const dsGraph: BlueprintNode = { id: 'datastore:sqlite', kind: 'datastore', label: 'SQLite', sourceFile: 'app/db.ts' }
    const content = buildPopoverContent(input({ node: ds, graphNodes: [dsGraph] }))
    expect(content.sourceDir).toBeNull()
  })
})

// ── learningForModule ────────────────────────────────────────────────────────
function learnEntry(overrides: Partial<BlueprintLearningEntry> = {}): BlueprintLearningEntry {
  return { module: 'app/src/main', status: 'learned', notedAt: '2026-07-15T00:00:00Z', ...overrides }
}

function note(overrides: Partial<BlueprintInvestigation> = {}): BlueprintInvestigation {
  return {
    anchorRefs: ['module:app/src/main'],
    summary: 'a note',
    provenance: 'observe',
    ts: '2026-07-15T00:00:00Z',
    fingerprint: 'fp',
    ...overrides,
  }
}

describe('learningForModule', () => {
  it('returns unlearned (status null, action learn) when no entry matches', () => {
    expect(learningForModule('app/src/main')).toEqual({ status: null, action: 'learn' })
  })

  it('matches a learning entry by path or module: id form and yields re-learn', () => {
    const byPath = learningForModule('module:app/src/main', [learnEntry()])
    expect(byPath.status).toBe('learned')
    expect(byPath.action).toBe('relearn')
    expect(byPath.learnedAt).toBe('2026-07-15T00:00:00Z')
    expect(byPath.docHint).toBe('flow/brain/modules/app-src-main.md')

    const idForm = learningForModule('app/src/main', [learnEntry({ module: 'module:app/src/main' })])
    expect(idForm.status).toBe('learned')
  })

  it('a learning pass in flight (learning) exposes no button', () => {
    const info = learningForModule('app/src/main', [learnEntry({ status: 'learning' })])
    expect(info.status).toBe('learning')
    expect(info.action).toBeNull()
    expect(info.docHint).toBeUndefined() // no doc yet while learning
  })

  it('a stale status offers re-learn and a doc hint', () => {
    const info = learningForModule('app/src/main', [learnEntry({ status: 'stale' })])
    expect(info.status).toBe('stale')
    expect(info.action).toBe('relearn')
    expect(info.docHint).toBe('flow/brain/modules/app-src-main.md')
  })

  it('matches an investigation note anchored directly or UNDER the module path', () => {
    const direct = learningForModule('app/src/main', [], [note({ summary: 'direct' })])
    expect(direct.noteSummary).toBe('direct')

    const under = learningForModule(
      'app/src/main',
      [],
      [note({ anchorRefs: ['module:app/src/main/agent'], summary: 'nested' })],
    )
    expect(under.noteSummary).toBe('nested')

    const sibling = learningForModule(
      'app/src/main',
      [],
      [note({ anchorRefs: ['module:app/src/mainframe'], summary: 'sibling' })],
    )
    expect(sibling.noteSummary).toBeUndefined() // prefix must be a path boundary
  })

  it('prefers a stale note summary over a non-stale one', () => {
    const info = learningForModule(
      'app/src/main',
      [],
      [
        note({ summary: 'fresh note', stale: false }),
        note({ summary: 'stale note', stale: true, fingerprint: 'fp2' }),
      ],
    )
    expect(info.noteSummary).toBe('stale note')
  })
})

// ── Tab selection: the user's pick survives background refreshes (#1029) ────
describe('resolveActiveTab', () => {
  const TABS = ['changes', 'overview', 'connections', 'review', 'files']

  it('leads with Changes on a fresh open when the changeset is engaged (#898)', () => {
    expect(
      resolveActiveTab({ visible: TABS, active: 'overview', userSelected: false, lead: 'changes' }),
    ).toBe('changes')
  })

  it('keeps the tab the USER selected when a refresh wants to lead elsewhere (#1029)', () => {
    // The exact report: reading the Review tab, an unrelated file write lands,
    // the board refreshes the Changes tab — the panel must NOT swap.
    expect(
      resolveActiveTab({ visible: TABS, active: 'review', userSelected: true, lead: 'changes' }),
    ).toBe('review')
  })

  it('still refreshes contents — a lead never wins over selection, repeatedly', () => {
    let active = 'review'
    for (let i = 0; i < 5; i++) {
      active = resolveActiveTab({ visible: TABS, active, userSelected: true, lead: 'changes' })!
    }
    expect(active).toBe('review') // sticky across every background tick
  })

  it('falls back when the user-selected tab disappears', () => {
    // The Review tab vanishes after "Mark reviewed" empties it.
    expect(
      resolveActiveTab({
        visible: ['changes', 'overview'],
        active: 'review',
        userSelected: true,
        lead: 'changes',
      }),
    ).toBe('changes')
    // …and with no lead either, the first visible tab.
    expect(
      resolveActiveTab({ visible: ['overview', 'files'], active: 'review', userSelected: true, lead: null }),
    ).toBe('overview')
  })

  it('holds the current tab across a refresh with no lead and no user pick', () => {
    expect(
      resolveActiveTab({ visible: TABS, active: 'connections', userSelected: false, lead: null }),
    ).toBe('connections')
  })

  it('ignores a lead whose tab is hidden', () => {
    expect(
      resolveActiveTab({ visible: ['overview', 'files'], active: null, userSelected: false, lead: 'changes' }),
    ).toBe('overview')
  })

  it('returns null when nothing is selectable', () => {
    expect(resolveActiveTab({ visible: [], active: 'review', userSelected: true, lead: 'changes' })).toBeNull()
  })
})
