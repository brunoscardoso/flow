/**
 * Brief scoping — the cut that lets a feature brief render WITHOUT opening the
 * code map.
 *
 * Regression guard for the reported behaviour: clicking a feature opened the
 * full 330-directory import graph, because forcing `codeMapOpen = true` was the
 * only way the brief could get nodes on the stage to decorate.
 */
import { distinguishingLabels, hasDrawableScope, learnableModulePaths, scopeGraphToBrief } from './brief-scope'

const GRAPH = {
  nodes: [
    { id: 'module:src/app/api/chat' },
    { id: 'module:src/components/chat' },
    { id: 'module:src/unrelated' },
    { id: 'datastore:postgres' },
    { id: 'endpoint:POST /stream' },
  ],
  edges: [
    { source: 'module:src/app/api/chat', target: 'datastore:postgres' },
    { source: 'module:src/components/chat', target: 'module:src/app/api/chat' },
    // One end outside the scope — a line to nowhere once scoped.
    { source: 'module:src/unrelated', target: 'module:src/app/api/chat' },
    { source: 'module:src/unrelated', target: 'endpoint:POST /stream' },
  ],
}

const CHAT_BRIEF = ['module:src/app/api/chat', 'module:src/components/chat', 'datastore:postgres']

describe('scopeGraphToBrief', () => {
  it('keeps only the components the brief names', () => {
    const scoped = scopeGraphToBrief(GRAPH, CHAT_BRIEF)

    expect(scoped.nodes.map((node) => node.id)).toEqual([
      'module:src/app/api/chat',
      'module:src/components/chat',
      'datastore:postgres',
    ])
    expect(scoped.nodes.map((node) => node.id)).not.toContain('module:src/unrelated')
  })

  it('drops an edge unless BOTH ends survive — no lines to nowhere', () => {
    const scoped = scopeGraphToBrief(GRAPH, CHAT_BRIEF)

    expect(scoped.edges).toEqual([
      { source: 'module:src/app/api/chat', target: 'datastore:postgres' },
      { source: 'module:src/components/chat', target: 'module:src/app/api/chat' },
    ])
  })

  it('preserves source order so layout is stable across re-renders', () => {
    const forward = scopeGraphToBrief(GRAPH, CHAT_BRIEF)
    const reversed = scopeGraphToBrief(GRAPH, [...CHAT_BRIEF].reverse())

    expect(reversed.nodes.map((n) => n.id)).toEqual(forward.nodes.map((n) => n.id))
  })

  it('reports brief nodes the graph does not contain, sorted, never dropping them silently', () => {
    const scoped = scopeGraphToBrief(GRAPH, ['module:src/app/api/chat', 'module:src/ghost', 'file:a.ts'])

    expect(scoped.missing).toEqual(['file:a.ts', 'module:src/ghost'])
    expect(scoped.nodes.map((n) => n.id)).toEqual(['module:src/app/api/chat'])
  })

  it('yields an empty scope when nothing resolves', () => {
    const scoped = scopeGraphToBrief(GRAPH, ['module:src/nope'])

    expect(scoped.nodes).toEqual([])
    expect(scoped.edges).toEqual([])
    expect(hasDrawableScope(scoped)).toBe(false)
  })

  it('yields an empty scope for a feature that claims no code', () => {
    const scoped = scopeGraphToBrief(GRAPH, [])

    expect(scoped).toEqual({ nodes: [], edges: [], missing: [] })
    expect(hasDrawableScope(scoped)).toBe(false)
  })

  it('never returns the whole graph — that was the bug', () => {
    const scoped = scopeGraphToBrief(GRAPH, CHAT_BRIEF)

    expect(scoped.nodes.length).toBeLessThan(GRAPH.nodes.length)
    expect(hasDrawableScope(scoped)).toBe(true)
  })

  it('does not mutate the source graph', () => {
    const snapshot = JSON.stringify(GRAPH)
    scopeGraphToBrief(GRAPH, CHAT_BRIEF)

    expect(JSON.stringify(GRAPH)).toBe(snapshot)
  })
})

// ── Learnable modules ────────────────────────────────────────
//
// Progressive learning is module-keyed in the app's orchestrator, so learning
// a FEATURE means learning the modules it claims.

describe('learnableModulePaths', () => {
  it('returns the resolved module anchors, stripped and sorted', () => {
    expect(
      learnableModulePaths([
        { ref: 'module:src/components/chat', resolved: true },
        { ref: 'module:src/app/api/chat', resolved: true },
      ]),
    ).toEqual(['src/app/api/chat', 'src/components/chat'])
  })

  it('skips UNRESOLVED anchors — queueing work that cannot succeed is not progress', () => {
    expect(
      learnableModulePaths([
        { ref: 'module:src/real', resolved: true },
        { ref: 'module:src/ghost', resolved: false },
      ]),
    ).toEqual(['src/real'])
  })

  it('reaches a file anchor through its PARENT DIRECTORY', () => {
    // The failure this fixes: "Chat Session Cache Rework" carries 14 anchors, all
    // `file:`, and offered no Learn at all — the feature with the most known
    // about it was the one you could not learn.
    expect(
      learnableModulePaths([
        { ref: 'file:src/hooks/useMessageCatchup.ts', resolved: true },
        { ref: 'file:src/stores/chatStore.ts', resolved: true },
      ]),
    ).toEqual(['src/hooks', 'src/stores'])
  })

  it('collapses several files in one directory to a single module', () => {
    expect(
      learnableModulePaths([
        { ref: 'file:src/hooks/a.ts', resolved: true },
        { ref: 'file:src/hooks/b.ts', resolved: true },
        { ref: 'module:src/hooks', resolved: true },
      ]),
    ).toEqual(['src/hooks'])
  })

  it('skips a repo-root file, which names no directory', () => {
    expect(learnableModulePaths([{ ref: 'file:README.md', resolved: true }])).toEqual([])
  })

  it('skips anchors that name neither a module nor a file', () => {
    expect(
      learnableModulePaths([
        { ref: 'endpoint:POST /stream', resolved: true },
        { ref: 'datastore:postgres', resolved: true },
        { ref: 'module:src/keep', resolved: true },
      ]),
    ).toEqual(['src/keep'])
  })

  it('dedupes so a module claimed twice is learned once', () => {
    expect(
      learnableModulePaths([
        { ref: 'module:src/a', resolved: true },
        { ref: 'module:src/a', resolved: true },
      ]),
    ).toEqual(['src/a'])
  })

  it('is empty for a feature that claims nothing learnable', () => {
    expect(learnableModulePaths([])).toEqual([])
    expect(learnableModulePaths([{ ref: 'module:', resolved: true }])).toEqual([])
  })
})

// ── Distinguishing labels ────────────────────────────────────────────────
//
// A feature's anchors are usually directories named after the feature, so a
// brief drew five cards labelled chat / chat / chats / chats / chats — all
// truthful, none useful.

describe('distinguishingLabels', () => {
  it('keeps the basename when it is already unique', () => {
    const labels = distinguishingLabels(['module:src/auth', 'module:src/billing'])
    expect(labels.get('module:src/auth')).toBe('auth')
    expect(labels.get('module:src/billing')).toBe('billing')
  })

  it('extends only the labels that collide', () => {
    const labels = distinguishingLabels([
      'module:src/app/api/chat',
      'module:src/app/sdk/chat',
      'module:src/billing',
    ])
    expect(labels.get('module:src/app/api/chat')).toBe('api/chat')
    expect(labels.get('module:src/app/sdk/chat')).toBe('sdk/chat')
    // untouched — it never collided
    expect(labels.get('module:src/billing')).toBe('billing')
  })

  it('tells the real Chats brief apart', () => {
    const labels = distinguishingLabels([
      'module:src/app/api/chat',
      'module:src/app/sdk/chat',
      'module:e2e/tests/chats',
      'module:src/app/api/spaces/chats',
      'module:src/app/app/(protected)/chats',
    ])
    expect([...labels.values()].sort()).toEqual([
      '(protected)/chats',
      'api/chat',
      'sdk/chat',
      'spaces/chats',
      'tests/chats',
    ])
    expect(new Set(labels.values()).size).toBe(5) // all distinct
  })

  it('stops growing when two ids are genuinely identical', () => {
    const labels = distinguishingLabels(['module:src/a', 'module:src/a'])
    expect(labels.get('module:src/a')).toBe('a')
  })

  it('handles ids with no kind prefix and single-segment paths', () => {
    const labels = distinguishingLabels(['prisma', 'module:src'])
    expect(labels.get('prisma')).toBe('prisma')
    expect(labels.get('module:src')).toBe('src')
  })
})
