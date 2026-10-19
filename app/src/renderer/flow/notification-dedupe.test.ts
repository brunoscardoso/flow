import {
  blockedPromptGate,
  createShownPromptRegistry,
  isStickyPrompt,
  shouldElevateToasts,
} from './notification-dedupe'

const shown = (...ids: string[]) => {
  const set = new Set(ids)
  return (id: string) => set.has(id)
}

describe('blockedPromptGate (#231)', () => {
  it('forwards a first-seen blocked prompt and reports its id to record', () => {
    expect(blockedPromptGate({ kind: 'blocked-prompt', promptId: 'p1' }, shown())).toEqual({
      forward: true,
      recordPromptId: 'p1',
    })
  })

  it('DROPS a blocked prompt already shown via the other channel (preserves the live card)', () => {
    // The core #231 race: state channel showed p1 first; the push must not rebuild it.
    expect(blockedPromptGate({ kind: 'blocked-prompt', promptId: 'p1' }, shown('p1'))).toEqual({
      forward: false,
      recordPromptId: null,
    })
  })

  it('always forwards non-blocked-prompt notifications (nothing to record)', () => {
    expect(blockedPromptGate({ kind: 'state-change', promptId: undefined }, shown('p1'))).toEqual({
      forward: true,
      recordPromptId: null,
    })
    expect(blockedPromptGate({ kind: 'heartbeat-event', promptId: undefined }, shown())).toEqual({
      forward: true,
      recordPromptId: null,
    })
  })

  it('forwards a blocked-prompt notification that lacks a promptId (cannot dedupe)', () => {
    expect(blockedPromptGate({ kind: 'blocked-prompt', promptId: undefined }, shown('p1'))).toEqual({
      forward: true,
      recordPromptId: null,
    })
  })
})

describe('isStickyPrompt (#423)', () => {
  it('is true for a blocked-prompt with a promptId (the reply card)', () => {
    expect(isStickyPrompt({ kind: 'blocked-prompt', promptId: 'p1' })).toBe(true)
  })
  it('is false for a blocked-prompt with no promptId, or any other kind', () => {
    expect(isStickyPrompt({ kind: 'blocked-prompt', promptId: undefined })).toBe(false)
    expect(isStickyPrompt({ kind: 'state-change', promptId: undefined })).toBe(false)
    expect(isStickyPrompt({ kind: 'heartbeat-event', promptId: 'p1' })).toBe(false)
  })
})

describe('shouldElevateToasts (#459)', () => {
  it('elevates the toast stack above the inbox while any sticky prompt is live', () => {
    expect(shouldElevateToasts(1)).toBe(true)
    expect(shouldElevateToasts(3)).toBe(true)
  })
  it('does not elevate when no sticky prompt is live (inbox keeps priority)', () => {
    expect(shouldElevateToasts(0)).toBe(false)
  })

  it('elevates while a persistent actionable toast is live, even with no prompt (#769)', () => {
    expect(shouldElevateToasts(0, 1)).toBe(true)
    expect(shouldElevateToasts(0, 0)).toBe(false)
    expect(shouldElevateToasts(1, 2)).toBe(true)
  })
})

describe('createShownPromptRegistry (#970)', () => {
  it('records and reports shown prompt ids', () => {
    const registry = createShownPromptRegistry()
    expect(registry.has('p1')).toBe(false)
    registry.record('p1', '/root/a')
    expect(registry.has('p1')).toBe(true)
  })

  it('pruning a dropped root forgets ONLY that root\'s ids, so a re-added root re-toasts', () => {
    // The #970 race: an untouched prompt file keeps the same mtime-derived id
    // forever, so a removed+re-added root's prompt re-delivers the SAME id —
    // without pruning it is deduped away and no reply card is rebuilt.
    const registry = createShownPromptRegistry()
    registry.record('p1', '/root/a')
    registry.record('p2', '/root/a')
    registry.record('p3', '/root/b')

    expect(registry.pruneRoot('/root/a')).toBe(2)
    expect(registry.has('p1')).toBe(false)
    expect(registry.has('p2')).toBe(false)
    expect(registry.has('p3')).toBe(true)

    // The re-delivered prompt is no longer deduped and records again.
    registry.record('p1', '/root/a')
    expect(registry.has('p1')).toBe(true)
  })

  it('pruning an unknown root is a no-op', () => {
    const registry = createShownPromptRegistry()
    registry.record('p1', '/root/a')
    expect(registry.pruneRoot('/root/never-seen')).toBe(0)
    expect(registry.has('p1')).toBe(true)
  })
})

