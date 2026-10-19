import {
  childrenOf,
  crumbs,
  depthDive,
  depthForward,
  depthNavLabels,
  depthPop,
  depthGoTo,
  depthPopTo,
  focusPathTo,
  pop,
  popTo,
  push,
  type DepthNavState,
  type FocusGraphInput,
  type FocusNode,
} from './focus-stack'

const graphWithDomains: FocusGraphInput = {
  nodes: [
    { kind: 'domain', id: 'domain:billing', name: 'Billing' },
    { kind: 'domain', id: 'domain:auth', name: 'Auth' },
    { kind: 'feature', id: 'feature:invoices', name: 'Invoices', parent: 'domain:billing' },
    { kind: 'feature', id: 'feature:tokens', name: 'Tokens', parent: 'domain:auth' },
    { kind: 'feature', id: 'feature:sso', name: 'SSO', parent: 'domain:auth' },
    { kind: 'part', id: 'part:invoice-pdf', name: 'Invoice PDF', parent: 'feature:invoices' },
    { kind: 'part', id: 'part:invoice-email', name: 'Invoice Email', parent: 'feature:invoices' },
  ],
}

const graphWithoutDomains: FocusGraphInput = {
  nodes: [
    { kind: 'feature', id: 'feature:invoices', name: 'Invoices' },
    { kind: 'feature', id: 'feature:tokens', name: 'Tokens' },
    { kind: 'part', id: 'part:invoice-pdf', name: 'Invoice PDF', parent: 'feature:invoices' },
  ],
}

function node(partial: Partial<FocusNode> & { id: string; kind: FocusNode['kind'] }): FocusNode {
  return {
    name: partial.id,
    kicker: '',
    drillable: false,
    // The production rule, not a per-test guess: only a `part` cannot be entered.
    canDrill: partial.kind !== 'part',
    childCount: 0,
    ...partial,
  }
}

describe('childrenOf', () => {
  it('at the root, returns domains when the graph has any', () => {
    const roots = childrenOf(graphWithDomains, null)
    expect(roots.map((n) => n.id)).toEqual(['domain:billing', 'domain:auth'])
  })

  it('falls back to feature-kind roots when no domain exists', () => {
    const roots = childrenOf(graphWithoutDomains, null)
    expect(roots.map((n) => n.id)).toEqual(['feature:invoices', 'feature:tokens'])
  })

  it('a domain’s children are its features', () => {
    const domain = childrenOf(graphWithDomains, null).find((n) => n.id === 'domain:auth')!
    const children = childrenOf(graphWithDomains, domain)
    expect(children.map((n) => n.id)).toEqual(['feature:tokens', 'feature:sso'])
    expect(children.every((n) => n.kind === 'feature')).toBe(true)
  })

  it('a feature’s children are its parts', () => {
    const feature = childrenOf(graphWithDomains, null)
      .flatMap((domain) => childrenOf(graphWithDomains, domain))
      .find((n) => n.id === 'feature:invoices')!
    const children = childrenOf(graphWithDomains, feature)
    expect(children.map((n) => n.id)).toEqual(['part:invoice-pdf', 'part:invoice-email'])
    expect(children.every((n) => n.kind === 'part')).toBe(true)
  })

  it('a part has no children', () => {
    const part = node({ kind: 'part', id: 'part:invoice-pdf' })
    expect(childrenOf(graphWithDomains, part)).toEqual([])
  })

  it('computes the domain kicker as a feature count', () => {
    const domain = childrenOf(graphWithDomains, null).find((n) => n.id === 'domain:auth')!
    expect(domain.kicker).toBe('2 features')
    expect(domain.drillable).toBe(true)
  })

  it('computes the feature kicker as a part count', () => {
    const feature = childrenOf(graphWithDomains, null)
      .flatMap((domain) => childrenOf(graphWithDomains, domain))
      .find((n) => n.id === 'feature:invoices')!
    expect(feature.kicker).toBe('2 parts')
  })

  it('prints NO kicker for a feature with no parts — the line said nothing', () => {
    const feature = childrenOf(graphWithDomains, null)
      .flatMap((domain) => childrenOf(graphWithDomains, domain))
      .find((n) => n.id === 'feature:sso')!
    // It used to say "no code claimed" — the SAME sentence under 16 of 19
    // nodes on a real board, which drowned the three counts that meant
    // something. The state is still readable: the node draws no has-children
    // ring, and drilling in says it in full (`emptyLevelReason`).
    expect(feature.kicker).toBe('')
    expect(feature.drillable).toBe(false)
  })

  it('prints NO kicker for an empty domain either', () => {
    const empty: FocusGraphInput = { nodes: [{ kind: 'domain', id: 'domain:x', name: 'X' }] }
    expect(childrenOf(empty, null)[0].kicker).toBe('')
  })

  it('gives a part an empty kicker — its explanation lives in the brief', () => {
    const feature = childrenOf(graphWithDomains, null)
      .flatMap((domain) => childrenOf(graphWithDomains, domain))
      .find((n) => n.id === 'feature:invoices')!
    const part = childrenOf(graphWithDomains, feature)[0]
    expect(part.kicker).toBe('')
  })
})

/**
 * THE REPORTED SYMPTOM, ASSERTED DIRECTLY.
 *
 * Chats on the real board has ten parts and two change records, and it read
 * "2 PARTS" — the two plan names were the only things on its level and the ten
 * parts were nowhere. Both halves came from one cause: change records were
 * entering the graph labelled `part`, so they were counted AND shown.
 *
 * The count and the ring are asserted together on purpose. They come from the
 * same `directChildren` call, and the only way this test could pass while the
 * board still lied is if that stopped being true.
 */
describe('a feature counts its PARTS, never the changes that touched it', () => {
  const chats: FocusGraphInput = {
    nodes: [
      { kind: 'feature', id: 'feature:chats', name: 'Chats' },
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'part' as const,
        id: `feature:chats/part-${i + 1}`,
        name: `Part ${i + 1}`,
        parent: 'feature:chats',
      })),
      { kind: 'change', id: 'feature:chat-session-cache-rework', name: 'Chat Session Cache Rework', parent: 'feature:chats' },
      {
        kind: 'change',
        id: 'feature:duplicate-messages',
        name: 'Duplicate Messages on Chat Switch — ACME-2293',
        parent: 'feature:chats',
      },
    ],
  }

  it('reads "10 parts" on a feature with 10 parts and 2 changes — not "2 parts"', () => {
    const feature = childrenOf(chats, null).find((n) => n.id === 'feature:chats')!
    expect(feature.kicker).toBe('10 parts')
    expect(feature.childCount).toBe(10)
  })

  it('puts those ten parts on the level, and neither change record', () => {
    const feature = childrenOf(chats, null).find((n) => n.id === 'feature:chats')!
    const level = childrenOf(chats, feature)
    expect(level).toHaveLength(10)
    expect(level.every((n) => n.kind === 'part')).toBe(true)
    expect(level.map((n) => n.name)).not.toContain('Chat Session Cache Rework')
    expect(level.map((n) => n.name)).not.toContain('Duplicate Messages on Chat Switch — ACME-2293')
  })

  it('keeps a change record off the ROOT ring too, even with no parent it can find', () => {
    const orphaned: FocusGraphInput = {
      nodes: [
        { kind: 'feature', id: 'feature:chats', name: 'Chats' },
        { kind: 'change', id: 'feature:loose-plan', name: 'Loose Plan' },
      ],
    }
    expect(childrenOf(orphaned, null).map((n) => n.id)).toEqual(['feature:chats'])
  })
})

describe('what gates a dive is the KIND, not the count', () => {
  it('a childless feature still reports drillable:false — it is a label', () => {
    const feature = childrenOf(graphWithDomains, null)
      .flatMap((domain) => childrenOf(graphWithDomains, domain))
      .find((n) => n.id === 'feature:sso')!
    expect(feature.drillable).toBe(false)
    // …but it can still be ENTERED. That split is the whole fix: the gesture
    // must not change meaning because a store happens to be empty today.
    expect(feature.canDrill).toBe(true)
  })

  it('only a part is un-enterable — domains and features always canDrill', () => {
    const domain = childrenOf(graphWithDomains, null).find((n) => n.id === 'domain:auth')!
    const feature = childrenOf(graphWithDomains, domain).find((n) => n.id === 'feature:tokens')!
    const invoices = childrenOf(graphWithDomains, null)
      .flatMap((d) => childrenOf(graphWithDomains, d))
      .find((n) => n.id === 'feature:invoices')!
    const part = childrenOf(graphWithDomains, invoices)[0]
    expect(domain.canDrill).toBe(true)
    expect(feature.canDrill).toBe(true)
    expect(part.canDrill).toBe(false)
  })

  it('push ACCEPTS a childless feature — the empty level is a real place', () => {
    const bare = node({ kind: 'feature', id: 'feature:sso', drillable: false, childCount: 0 })
    expect(push([], bare).map((n) => n.id)).toEqual(['feature:sso'])
  })

  it('push refuses a part — a single artifact has nothing inside it', () => {
    const leaf = node({ kind: 'part', id: 'part:x', drillable: false, childCount: 0 })
    expect(push([], leaf)).toEqual([])
  })

  it('push accepts a node with children', () => {
    const branch = node({ kind: 'domain', id: 'domain:auth', drillable: true, childCount: 2 })
    expect(push([], branch).map((n) => n.id)).toEqual(['domain:auth'])
  })

  it('push accepts a CHILDLESS DOMAIN too — the rule is kind, not count', () => {
    // A domain whose features were all deleted is still a place; refusing it
    // here is the same class of bug the childless-feature refusal was.
    const empty = node({ kind: 'domain', id: 'domain:ghost', drillable: false, childCount: 0 })
    expect(push([], empty).map((n) => n.id)).toEqual(['domain:ghost'])
  })

  it('a part with children on it STILL refuses — canDrill answers, drillable does not', () => {
    // A hand-edited store can hang a child off a part. `drillable` would say
    // yes; the gate is `canDrill`, which is a function of the kind alone.
    const impossible = node({ kind: 'part', id: 'part:x', drillable: true, childCount: 3 })
    expect(push([], impossible)).toEqual([])
    expect(depthDive({ stack: [], forward: [] }, impossible).stack).toEqual([])
  })

  it('a dive into a part does not even disturb the forward trail', () => {
    // The no-move branch of `depthDive` — a refused push must not be mistaken
    // for "somewhere new", which is what clears Forward.
    const forward = [node({ kind: 'feature', id: 'feature:tokens', name: 'Tokens' })]
    const leaf = node({ kind: 'part', id: 'part:x' })
    const after = depthDive({ stack: [], forward }, leaf)
    expect(after.stack).toEqual([])
    expect(after.forward).toEqual(forward)
  })
})

describe('push / pop / popTo', () => {
  const domain = node({ kind: 'domain', id: 'domain:auth', name: 'Auth', drillable: true, childCount: 2 })
  const feature = node({ kind: 'feature', id: 'feature:tokens', name: 'Tokens', drillable: true, childCount: 1 })
  const part = node({ kind: 'part', id: 'part:x', name: 'X', drillable: false, childCount: 0 })

  it('push appends without mutating the input', () => {
    const before: FocusNode[] = [domain]
    const after = push(before, feature)
    expect(after).toEqual([domain, feature])
    expect(before).toEqual([domain]) // untouched
  })

  it('pop removes the top entry', () => {
    expect(pop([domain, feature])).toEqual([domain])
  })

  it('pop at the root is a no-op', () => {
    expect(pop([])).toEqual([])
  })

  it('popTo(0) truncates all the way to the root', () => {
    expect(popTo([domain, feature], 0)).toEqual([])
  })

  it('popTo(N) keeps exactly the first N entries', () => {
    expect(popTo([domain, feature], 1)).toEqual([domain])
  })

  it('popTo beyond the stack length is a no-op', () => {
    expect(popTo([domain], 5)).toEqual([domain])
  })

  it('popTo a negative depth is a no-op', () => {
    expect(popTo([domain], -1)).toEqual([domain])
  })

  it('popTo a NON-INTEGER depth is a no-op — a crumb index is never fractional', () => {
    // `slice(0, 1.5)` would silently truncate. Refusing surfaces the caller bug
    // rather than landing on a depth nobody asked for.
    expect(popTo([domain, feature], 1.5)).toEqual([domain, feature])
    expect(popTo([domain, feature], Number.NaN)).toEqual([domain, feature])
    expect(popTo([domain, feature], Number.POSITIVE_INFINITY)).toEqual([domain, feature])
  })

  it('popTo(stack.length) is the identity — the current depth is in range', () => {
    expect(popTo([domain, feature], 2)).toEqual([domain, feature])
  })

  it('none of push/pop/popTo mutate the array they are given', () => {
    const original = [domain, feature]
    push(original, part)
    pop(original)
    popTo(original, 0)
    expect(original).toEqual([domain, feature])
  })
})

describe('crumbs', () => {
  const domain = node({ kind: 'domain', id: 'domain:auth', name: 'Auth', drillable: true, childCount: 2 })
  const feature = node({ kind: 'feature', id: 'feature:tokens', name: 'Tokens', drillable: true, childCount: 1 })

  it('at depth 0, only the root crumb exists and it is current', () => {
    expect(crumbs([], 'Features')).toEqual([{ id: null, name: 'Features', current: true }])
  })

  it('at depth 1, the root is not current and the one entry is', () => {
    expect(crumbs([domain], 'Features')).toEqual([
      { id: null, name: 'Features', current: false },
      { id: 'domain:auth', name: 'Auth', current: true },
    ])
  })

  it('at depth N, only the LAST entry is current', () => {
    const trail = crumbs([domain, feature], 'Features')
    expect(trail).toEqual([
      { id: null, name: 'Features', current: false },
      { id: 'domain:auth', name: 'Auth', current: false },
      { id: 'feature:tokens', name: 'Tokens', current: true },
    ])
  })
})

describe('depth navigation — what the header arrows drive (Fix C)', () => {
  const a = node({ kind: 'domain', id: 'domain:a', name: 'Agent', drillable: true, childCount: 3 })
  const b = node({ kind: 'feature', id: 'feature:b', name: 'Chats', drillable: true, childCount: 2 })
  const leaf = node({ kind: 'part', id: 'part:c', name: 'Leaf' })
  const empty: DepthNavState = { stack: [], forward: [] }

  it('a dive deepens the stack and clears a stale forward trail', () => {
    const popped = depthPop(depthDive(empty, a))
    expect(popped.forward.map((n) => n.id)).toEqual(['domain:a'])
    const elsewhere = depthDive(popped, b)
    expect(elsewhere.stack.map((n) => n.id)).toEqual(['feature:b'])
    expect(elsewhere.forward).toEqual([])
  })

  it('diving into exactly what Forward offered KEEPS the rest of the trail', () => {
    const deep = depthDive(depthDive(empty, a), b)
    const atRoot = depthPopTo(deep, 0)
    expect(atRoot.forward.map((n) => n.id)).toEqual(['domain:a', 'feature:b'])
    // Re-entering by hand is the same journey the arrow was offering.
    const again = depthDive(atRoot, a)
    expect(again.forward.map((n) => n.id)).toEqual(['feature:b'])
  })

  it('back and forward round-trip a two-level dive without losing a level', () => {
    const deep = depthDive(depthDive(empty, a), b)
    const out = depthPop(depthPop(deep))
    expect(out.stack).toEqual([])
    const back = depthForward(depthForward(out))
    expect(back.stack.map((n) => n.id)).toEqual(['domain:a', 'feature:b'])
    expect(back.forward).toEqual([])
  })

  it('a breadcrumb jump is ONE move that Forward can walk back down', () => {
    const deep = depthDive(depthDive(empty, a), b)
    const jumped = depthPopTo(deep, 0)
    expect(jumped.stack).toEqual([])
    expect(depthForward(jumped).stack.map((n) => n.id)).toEqual(['domain:a'])
  })

  it('no-ops at the ends rather than throwing', () => {
    expect(depthPop(empty)).toEqual({ stack: [], forward: [] })
    expect(depthForward(empty)).toEqual({ stack: [], forward: [] })
    // A part is not a level — the stack does not move. A childless FEATURE
    // would move, which is the point of the kind test.
    expect(depthDive(empty, leaf).stack).toEqual([])
    const bare = node({ kind: 'feature', id: 'feature:bare', name: 'Bare' })
    expect(depthDive(empty, bare).stack.map((n) => n.id)).toEqual(['feature:bare'])
  })

  it('the arrows NAME where they go at this depth', () => {
    expect(depthNavLabels(empty, 'Features')).toEqual({
      backEnabled: false,
      backTitle: 'Already at Features',
      forwardEnabled: false,
      forwardTitle: 'Nothing to go forward into',
    })
    const deep = depthDive(depthDive(empty, a), b)
    expect(depthNavLabels(deep, 'Features').backTitle).toBe('Back out to Agent')
    const out = depthPop(deep)
    expect(depthNavLabels(out, 'Features')).toMatchObject({
      backEnabled: true,
      backTitle: 'Back out to Features',
      forwardEnabled: true,
      forwardTitle: 'Forward into Chats',
    })
  })
})

describe('focusPathTo / depthGoTo — reaching a node the ring does not show', () => {
  it('returns the ancestor trail, with the target left OFF it (it goes on the ring)', () => {
    const found = focusPathTo(graphWithDomains, 'part:invoice-pdf')
    expect(found?.stack.map((n) => n.id)).toEqual(['domain:billing', 'feature:invoices'])
    expect(found?.nodeId).toBe('part:invoice-pdf')
  })

  it('returns an EMPTY trail for a node already on the root ring', () => {
    expect(focusPathTo(graphWithDomains, 'domain:auth')?.stack).toEqual([])
  })

  it('returns null for a node this graph does not contain', () => {
    expect(focusPathTo(graphWithDomains, 'feature:nope')).toBeNull()
  })

  it('does not hang on a cyclic parent chain in a hand-edited store', () => {
    const cyclic: FocusGraphInput = {
      nodes: [
        { kind: 'domain', id: 'domain:a', name: 'A' },
        { kind: 'feature', id: 'feature:x', name: 'X', parent: 'feature:y' },
        { kind: 'feature', id: 'feature:y', name: 'Y', parent: 'feature:x' },
      ],
    }
    expect(focusPathTo(cyclic, 'feature:zzz')).toBeNull()
  })

  it('depthGoTo lands exactly where focusPathTo said, through the SAME algebra', () => {
    const found = focusPathTo(graphWithDomains, 'part:invoice-pdf')!
    const state = depthGoTo({ stack: [], forward: [] }, found.stack)
    expect(state.stack.map((n) => n.id)).toEqual(['domain:billing', 'feature:invoices'])
    // The crumbs the board draws come from that same stack, so depth cannot
    // disagree with itself after a jump.
    expect(crumbs(state.stack, 'Features').map((c) => c.name)).toEqual([
      'Features',
      'Billing',
      'Invoices',
    ])
    // And Back still walks out one level at a time.
    expect(depthPop(state).stack.map((n) => n.id)).toEqual(['domain:billing'])
  })

  it('depthGoTo([]) is a jump to the root, not a no-op', () => {
    const deep = depthGoTo({ stack: [], forward: [] }, focusPathTo(graphWithDomains, 'feature:tokens')!.stack)
    expect(deep.stack).toHaveLength(1)
    expect(depthGoTo(deep, []).stack).toEqual([])
  })
})
