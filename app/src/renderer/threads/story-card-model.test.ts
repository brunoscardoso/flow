import type { BlueprintAnchor, BlueprintStory, BlueprintStoryStep } from '../../shared/ipc-contract'
import {
  CHIP_CAP,
  anchorPeekPath,
  anchorPrimaryAction,
  capChips,
  clampStep,
  shouldAutoExpand,
  shouldRenderStory,
  storyIdentity,
  StoryMinimizeMemory,
  StoryOwnership,
} from './story-card-model'

const step = (over: Partial<BlueprintStoryStep> = {}): BlueprintStoryStep => ({
  id: 'the-problem',
  title: 'The problem',
  body: 'Some prose.',
  anchors: [],
  flow: [],
  phases: [],
  decisions: [],
  rejected: [],
  questions: [],
  unresolvedAnchors: [],
  draft: false,
  ...over,
})

const story = (over: Partial<BlueprintStory> = {}): BlueprintStory => ({
  plan: 'blueprint-v2',
  sourcePath: 'flow/plans/plan_blueprint-v2_v1.md',
  mode: 'strict',
  steps: [step()],
  warnings: [],
  ...over,
})

describe('clampStep', () => {
  it('passes through an in-range index', () => {
    expect(clampStep(2, 5)).toBe(2)
  })

  it('clamps below zero to zero and above the last to the last', () => {
    expect(clampStep(-3, 5)).toBe(0)
    expect(clampStep(9, 5)).toBe(4)
  })

  it('floors fractional indices', () => {
    expect(clampStep(2.9, 5)).toBe(2)
  })

  it('returns 0 for an empty story or a non-finite index', () => {
    expect(clampStep(3, 0)).toBe(0)
    expect(clampStep(Number.NaN, 5)).toBe(0)
    expect(clampStep(Number.POSITIVE_INFINITY, 5)).toBe(0)
  })
})

describe('capChips', () => {
  it('passes every item through at or under the cap', () => {
    const items = ['a', 'b', 'c']
    expect(capChips(items, 6)).toEqual([
      { text: 'a', overflow: false },
      { text: 'b', overflow: false },
      { text: 'c', overflow: false },
    ])
  })

  it('shows exactly the cap items when equal to the cap', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f']
    const capped = capChips(items, 6)
    expect(capped).toHaveLength(6)
    expect(capped.every((c) => !c.overflow)).toBe(true)
  })

  it('collapses the tail into a single "…and K more" overflow entry', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const capped = capChips(items, 6)
    // Never more than `cap` rendered entries.
    expect(capped).toHaveLength(6)
    expect(capped.slice(0, 5).map((c) => c.text)).toEqual(['a', 'b', 'c', 'd', 'e'])
    // 8 total − 5 shown = 3 remaining.
    expect(capped[5]).toEqual({ text: '…and 3 more', overflow: true })
  })

  it('defaults to CHIP_CAP', () => {
    const items = Array.from({ length: CHIP_CAP + 4 }, (_, i) => `item-${i}`)
    const capped = capChips(items)
    expect(capped).toHaveLength(CHIP_CAP)
    expect(capped[CHIP_CAP - 1].overflow).toBe(true)
    expect(capped[CHIP_CAP - 1].text).toBe(`…and 5 more`)
  })

  it('treats an empty group as no chips', () => {
    expect(capChips([], 6)).toEqual([])
  })
})

describe('anchorPrimaryAction', () => {
  // The chip is what a reader aims at, so it does the thing they came for:
  // read the code. Attaching the reference moves to the control beside it.
  it('opens the file a file-kind anchor names', () => {
    expect(anchorPrimaryAction({ kind: 'file', ref: 'app/src/main/index.ts' })).toEqual({
      kind: 'open',
      path: 'app/src/main/index.ts',
    })
  })

  it('opens the scoping file of a symbol-kind anchor, not its symbol name', () => {
    const anchor: BlueprintAnchor = {
      kind: 'symbol',
      ref: 'RunManager',
      file: 'app/src/main/agents/run-manager.ts',
    }
    // `ref` here is a symbol, which is not a path — opening it would ask the
    // editor's resolver to find a file called "RunManager".
    expect(anchorPrimaryAction(anchor)).toEqual({
      kind: 'open',
      path: 'app/src/main/agents/run-manager.ts',
    })
  })

  it('attaches an anchor kind that names no one file', () => {
    // Not a fallback for a failed open: there is nothing to open, and the kind
    // says so before the click, so the chip can state which action it is.
    expect(anchorPrimaryAction({ kind: 'endpoint', ref: 'GET /api/v1/notifications/settings' })).toEqual({ kind: 'attach' })
    expect(anchorPrimaryAction({ kind: 'module', ref: 'src/cli/blueprint' })).toEqual({ kind: 'attach' })
    expect(anchorPrimaryAction({ kind: 'table', ref: 'messages' })).toEqual({ kind: 'attach' })
    expect(anchorPrimaryAction({ kind: 'symbol', ref: 'RunManager' })).toEqual({ kind: 'attach' })
  })

  it('agrees with anchorPeekPath on which anchors name a file', () => {
    // One rule, two readers: a kind that gains a path must not start opening in
    // one place and attaching in the other.
    const anchors: BlueprintAnchor[] = [
      { kind: 'file', ref: 'a.ts' },
      { kind: 'symbol', ref: 'S', file: 'b.ts' },
      { kind: 'symbol', ref: 'S' },
      { kind: 'module', ref: 'src/cli' },
      { kind: 'table', ref: 't' },
      { kind: 'endpoint', ref: 'GET /x' },
    ]
    for (const anchor of anchors) {
      const path = anchorPeekPath(anchor)
      const action = anchorPrimaryAction(anchor)
      expect(action.kind === 'open' ? action.path : null).toBe(path)
    }
  })
})

describe('anchorPeekPath', () => {
  it('resolves a file-kind anchor to its ref', () => {
    const anchor: BlueprintAnchor = { kind: 'file', ref: 'app/src/main/index.ts' }
    expect(anchorPeekPath(anchor)).toBe('app/src/main/index.ts')
  })

  it('resolves a symbol-kind anchor with a file scope to that file', () => {
    const anchor: BlueprintAnchor = { kind: 'symbol', ref: 'RunManager', file: 'app/src/main/agents/run-manager.ts' }
    expect(anchorPeekPath(anchor)).toBe('app/src/main/agents/run-manager.ts')
  })

  it('returns null for a symbol-kind anchor with no file scope', () => {
    expect(anchorPeekPath({ kind: 'symbol', ref: 'RunManager' })).toBeNull()
  })

  it('returns null for module/table/endpoint anchor kinds', () => {
    expect(anchorPeekPath({ kind: 'module', ref: 'app/src/main' })).toBeNull()
    expect(anchorPeekPath({ kind: 'table', ref: 'users' })).toBeNull()
    expect(anchorPeekPath({ kind: 'endpoint', ref: 'derive' })).toBeNull()
  })
})

describe('storyIdentity', () => {
  it('is stable for structurally identical stories', () => {
    expect(storyIdentity(story())).toBe(storyIdentity(story()))
  })

  it('changes when a step body changes', () => {
    const a = storyIdentity(story({ steps: [step({ body: 'original' })] }))
    const b = storyIdentity(story({ steps: [step({ body: 'edited' })] }))
    expect(a).not.toBe(b)
  })

  it('changes when the plan name changes', () => {
    const a = storyIdentity(story({ plan: 'one' }))
    const b = storyIdentity(story({ plan: 'two' }))
    expect(a).not.toBe(b)
  })

  it('changes when a step is added', () => {
    const a = storyIdentity(story({ steps: [step({ id: 's1' })] }))
    const b = storyIdentity(story({ steps: [step({ id: 's1' }), step({ id: 's2' })] }))
    expect(a).not.toBe(b)
  })

  it('changes when steps are reordered', () => {
    const s1 = step({ id: 's1', body: 'first' })
    const s2 = step({ id: 's2', body: 'second' })
    const a = storyIdentity(story({ steps: [s1, s2] }))
    const b = storyIdentity(story({ steps: [s2, s1] }))
    expect(a).not.toBe(b)
  })

  it('ignores kicker/title/anchor changes that do not alter the reading', () => {
    const a = storyIdentity(story({ steps: [step({ kicker: 'A', title: 'X' })] }))
    const b = storyIdentity(story({ steps: [step({ kicker: 'B', title: 'Y' })] }))
    expect(a).toBe(b)
  })
})

describe('shouldAutoExpand', () => {
  it('expands when there is no memory', () => {
    expect(shouldAutoExpand(undefined, 'id-1')).toBe(true)
  })

  it('expands when the identity changed', () => {
    expect(shouldAutoExpand({ identity: 'old', minimized: true }, 'new')).toBe(true)
  })

  it('honors the remembered minimized flag for the same identity', () => {
    expect(shouldAutoExpand({ identity: 'id', minimized: true }, 'id')).toBe(false)
    expect(shouldAutoExpand({ identity: 'id', minimized: false }, 'id')).toBe(true)
  })
})

describe('StoryMinimizeMemory', () => {
  it('expands and records a fresh identity on first resolve', () => {
    const memory = new StoryMinimizeMemory()
    expect(memory.resolveAutoExpand('t1', 'id-1')).toBe(true)
    expect(memory.peek('t1')).toEqual({ identity: 'id-1', minimized: false })
  })

  it('honors a remembered minimize choice for the same identity', () => {
    const memory = new StoryMinimizeMemory()
    memory.resolveAutoExpand('t1', 'id-1')
    memory.setMinimized('t1', 'id-1', true)
    expect(memory.resolveAutoExpand('t1', 'id-1')).toBe(false)
  })

  it('re-expands and resets when the identity changes', () => {
    const memory = new StoryMinimizeMemory()
    memory.resolveAutoExpand('t1', 'id-1')
    memory.setMinimized('t1', 'id-1', true)
    // A new story in the same thread wipes the old minimize choice.
    expect(memory.resolveAutoExpand('t1', 'id-2')).toBe(true)
    expect(memory.peek('t1')).toEqual({ identity: 'id-2', minimized: false })
  })

  it('keys memory per thread', () => {
    const memory = new StoryMinimizeMemory()
    memory.resolveAutoExpand('t1', 'id-1')
    memory.setMinimized('t1', 'id-1', true)
    // A different thread with the same identity is independent.
    expect(memory.resolveAutoExpand('t2', 'id-1')).toBe(true)
    // t1 still remembers its minimized choice.
    expect(memory.resolveAutoExpand('t1', 'id-1')).toBe(false)
  })

  it('forgets a thread on clear', () => {
    const memory = new StoryMinimizeMemory()
    memory.resolveAutoExpand('t1', 'id-1')
    memory.setMinimized('t1', 'id-1', true)
    memory.clear('t1')
    expect(memory.peek('t1')).toBeUndefined()
    expect(memory.resolveAutoExpand('t1', 'id-1')).toBe(true)
  })
})

describe('StoryOwnership', () => {
  it('reports no owner for an unclaimed plan', () => {
    const owners = new StoryOwnership()
    expect(owners.ownerOf('/root', 'planA')).toBeUndefined()
  })

  it('claims a plan for a thread and reads it back', () => {
    const owners = new StoryOwnership()
    expect(owners.claim('/root', 'planA', 'threadT')).toBe(true)
    expect(owners.ownerOf('/root', 'planA')).toBe('threadT')
  })

  it('claiming the same (root, plan, thread) again is a no-op (returns false)', () => {
    const owners = new StoryOwnership()
    owners.claim('/root', 'planA', 'threadT')
    expect(owners.claim('/root', 'planA', 'threadT')).toBe(false)
  })

  it('re-claiming a plan for a different thread transfers ownership (returns true)', () => {
    const owners = new StoryOwnership()
    owners.claim('/root', 'planA', 'threadT')
    expect(owners.claim('/root', 'planA', 'threadU')).toBe(true)
    expect(owners.ownerOf('/root', 'planA')).toBe('threadU')
  })

  it('keys ownership per (root, plan) — independent projects and plans', () => {
    const owners = new StoryOwnership()
    owners.claim('/rootA', 'plan1', 'tA')
    owners.claim('/rootB', 'plan1', 'tB')
    owners.claim('/rootA', 'plan2', 'tC')
    expect(owners.ownerOf('/rootA', 'plan1')).toBe('tA')
    expect(owners.ownerOf('/rootB', 'plan1')).toBe('tB')
    expect(owners.ownerOf('/rootA', 'plan2')).toBe('tC')
  })

  it('ownerOf is undefined for a null root', () => {
    const owners = new StoryOwnership()
    owners.claim('/root', 'planA', 'threadT')
    expect(owners.ownerOf(null, 'planA')).toBeUndefined()
  })

  it('round-trips through toJSON + constructor (persistence)', () => {
    const owners = new StoryOwnership()
    owners.claim('/root', 'planA', 'threadT')
    owners.claim('/root', 'planB', 'threadU')
    const rehydrated = new StoryOwnership(JSON.parse(JSON.stringify(owners.toJSON())))
    expect(rehydrated.ownerOf('/root', 'planA')).toBe('threadT')
    expect(rehydrated.ownerOf('/root', 'planB')).toBe('threadU')
  })

  it('hydration skips malformed / empty entries without throwing', () => {
    const owners = new StoryOwnership({
      '/root': { planA: 'threadT', planBad: '', planWorse: null as unknown as string },
      '/empty': {},
      '/nullish': null as unknown as Record<string, string>,
    })
    expect(owners.ownerOf('/root', 'planA')).toBe('threadT')
    expect(owners.ownerOf('/root', 'planBad')).toBeUndefined()
    expect(owners.ownerOf('/root', 'planWorse')).toBeUndefined()
    expect(owners.ownerOf('/empty', 'anything')).toBeUndefined()
  })

  it('claims with an anchor and reports it', () => {
    const owners = new StoryOwnership()
    expect(owners.claim('/root', 'planA', 'threadT', '2026-07-22T10:00:00.000Z')).toBe(true)
    expect(owners.anchorOf('/root', 'planA')).toBe('2026-07-22T10:00:00.000Z')
    // Round-trips through the serialized snapshot.
    const rehydrated = new StoryOwnership(owners.toJSON())
    expect(rehydrated.ownerOf('/root', 'planA')).toBe('threadT')
    expect(rehydrated.anchorOf('/root', 'planA')).toBe('2026-07-22T10:00:00.000Z')
  })

  it('a re-claim by the same thread keeps the existing anchor (re-narrate must not move the card)', () => {
    const owners = new StoryOwnership()
    owners.claim('/root', 'planA', 'threadT', '2026-07-22T10:00:00.000Z')
    expect(owners.claim('/root', 'planA', 'threadT', '2026-07-22T11:00:00.000Z')).toBe(false)
    expect(owners.anchorOf('/root', 'planA')).toBe('2026-07-22T10:00:00.000Z')
  })

  it('parses legacy string records with no anchor, and backfills via setAnchor exactly once', () => {
    const owners = new StoryOwnership({ '/root': { planA: 'threadT' } })
    expect(owners.ownerOf('/root', 'planA')).toBe('threadT')
    expect(owners.anchorOf('/root', 'planA')).toBeUndefined()
    expect(owners.setAnchor('/root', 'planA', '2026-07-22T10:00:00.000Z')).toBe(true)
    expect(owners.anchorOf('/root', 'planA')).toBe('2026-07-22T10:00:00.000Z')
    // Already anchored / unknown records are not overwritten.
    expect(owners.setAnchor('/root', 'planA', '2026-07-22T12:00:00.000Z')).toBe(false)
    expect(owners.anchorOf('/root', 'planA')).toBe('2026-07-22T10:00:00.000Z')
    expect(owners.setAnchor('/root', 'unknown', '2026-07-22T10:00:00.000Z')).toBe(false)
    expect(owners.setAnchor(null, 'planA', '2026-07-22T10:00:00.000Z')).toBe(false)
  })

  it('parses persisted record objects (the post-anchor format)', () => {
    const owners = new StoryOwnership({
      '/root': {
        planA: { threadId: 'threadT', anchorAt: '2026-07-22T10:00:00.000Z' },
        planNoAnchor: { threadId: 'threadU' },
        planBad: { threadId: '' },
      },
    })
    expect(owners.ownerOf('/root', 'planA')).toBe('threadT')
    expect(owners.anchorOf('/root', 'planA')).toBe('2026-07-22T10:00:00.000Z')
    expect(owners.ownerOf('/root', 'planNoAnchor')).toBe('threadU')
    expect(owners.anchorOf('/root', 'planNoAnchor')).toBeUndefined()
    expect(owners.ownerOf('/root', 'planBad')).toBeUndefined()
  })
})

describe('shouldRenderStory', () => {
  it('renders only in the owning thread', () => {
    expect(shouldRenderStory('threadT', 'threadT')).toBe(true)
  })

  it('does not render in a different thread', () => {
    expect(shouldRenderStory('threadT', 'threadU')).toBe(false)
  })

  it('does not render an unclaimed story (no owner) in any thread', () => {
    expect(shouldRenderStory(undefined, 'threadT')).toBe(false)
  })

  it('does not render when there is no active thread', () => {
    expect(shouldRenderStory('threadT', null)).toBe(false)
    expect(shouldRenderStory(undefined, null)).toBe(false)
  })
})
