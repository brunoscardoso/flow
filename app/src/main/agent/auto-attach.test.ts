// Auto-attach decision tests (multi-project threads, phase 6) — the pure
// logic behind attach-then-allow: a write into a KNOWN project root that is
// not in the thread's root set attaches that root; a write outside every known
// root stays blocked exactly as today (returns null / blockedOutsideKnown).

import { attachRootForWritePath, bashAttachDecision, TurnAttachTracker } from './auto-attach'

const PRIMARY = '/work/app'
const KNOWN_SIBLING = '/work/lib'
const THREAD_ROOTS = [PRIMARY]
const KNOWN = [PRIMARY, KNOWN_SIBLING]

describe('attachRootForWritePath', () => {
  it('returns the known root containing an escaping write', () => {
    expect(attachRootForWritePath('/work/lib/src/index.ts', THREAD_ROOTS, KNOWN)).toBe(
      KNOWN_SIBLING,
    )
  })

  it('returns null for a write already inside a thread root (nothing to attach)', () => {
    expect(attachRootForWritePath('/work/app/src/index.ts', THREAD_ROOTS, KNOWN)).toBeNull()
  })

  it('returns null for a write outside every known root — stays blocked as today', () => {
    expect(attachRootForWritePath('/elsewhere/evil.ts', THREAD_ROOTS, KNOWN)).toBeNull()
  })

  it('returns null for a root already attached to the thread', () => {
    expect(
      attachRootForWritePath('/work/lib/x.ts', [PRIMARY, KNOWN_SIBLING], KNOWN),
    ).toBeNull()
  })

  it('resolves relative paths against the primary root', () => {
    // ../lib/x.ts from /work/app lands in /work/lib — the known sibling.
    expect(attachRootForWritePath('../lib/x.ts', THREAD_ROOTS, KNOWN)).toBe(KNOWN_SIBLING)
    // a plain relative path stays inside the primary — no attach.
    expect(attachRootForWritePath('src/x.ts', THREAD_ROOTS, KNOWN)).toBeNull()
  })

  it('never matches a prefix-sibling (lexical nesting, not startsWith)', () => {
    expect(attachRootForWritePath('/work/lib-evil/x.ts', THREAD_ROOTS, KNOWN)).toBeNull()
  })

  it('returns null with no thread roots or no path (nothing enforced)', () => {
    expect(attachRootForWritePath('/work/lib/x.ts', [], KNOWN)).toBeNull()
    expect(attachRootForWritePath(null, THREAD_ROOTS, KNOWN)).toBeNull()
    expect(attachRootForWritePath('', THREAD_ROOTS, KNOWN)).toBeNull()
  })
})

describe('bashAttachDecision', () => {
  it('attaches the known root a redirection writes into', () => {
    const decision = bashAttachDecision('echo hi > /work/lib/out.txt', THREAD_ROOTS, KNOWN)
    expect(decision).toEqual({ attach: [KNOWN_SIBLING], blockedOutsideKnown: false })
  })

  it('attaches nothing for writes that stay inside thread roots', () => {
    const decision = bashAttachDecision('echo hi > /work/app/out.txt', THREAD_ROOTS, KNOWN)
    expect(decision).toEqual({ attach: [], blockedOutsideKnown: false })
  })

  it('flags blockedOutsideKnown — and attaches NOTHING — when any target escapes every known root', () => {
    const decision = bashAttachDecision(
      'cp /work/lib/a.txt /elsewhere/b.txt',
      THREAD_ROOTS,
      KNOWN,
    )
    expect(decision.blockedOutsideKnown).toBe(true)
    expect(decision.attach).toEqual([])
  })

  it('skips temp and /dev sinks (never an attach trigger)', () => {
    expect(bashAttachDecision('echo hi > /dev/null', THREAD_ROOTS, KNOWN)).toEqual({
      attach: [],
      blockedOutsideKnown: false,
    })
    expect(bashAttachDecision('echo hi > /tmp/scratch.txt', THREAD_ROOTS, KNOWN)).toEqual({
      attach: [],
      blockedOutsideKnown: false,
    })
  })

  it('dedupes multiple targets in the same known root', () => {
    const decision = bashAttachDecision(
      'tee /work/lib/a.txt > /work/lib/b.txt',
      THREAD_ROOTS,
      KNOWN,
    )
    expect(decision).toEqual({ attach: [KNOWN_SIBLING], blockedOutsideKnown: false })
  })

  it('resolves relative write targets against the primary root', () => {
    const decision = bashAttachDecision('echo hi > ../lib/out.txt', THREAD_ROOTS, KNOWN)
    expect(decision).toEqual({ attach: [KNOWN_SIBLING], blockedOutsideKnown: false })
  })

  it('returns empty for an empty command or no thread roots', () => {
    expect(bashAttachDecision('', THREAD_ROOTS, KNOWN)).toEqual({
      attach: [],
      blockedOutsideKnown: false,
    })
    expect(bashAttachDecision('echo hi > /work/lib/x', [], KNOWN)).toEqual({
      attach: [],
      blockedOutsideKnown: false,
    })
  })
})

describe('TurnAttachTracker', () => {
  it('marks a root once per turn — repeats within the turn are debounced', () => {
    const tracker = new TurnAttachTracker()
    expect(tracker.markAttached('t1', KNOWN_SIBLING)).toBe(true)
    expect(tracker.markAttached('t1', KNOWN_SIBLING)).toBe(false)
    // A different root in the same turn is independent.
    expect(tracker.markAttached('t1', '/work/other')).toBe(true)
  })

  it('beginTurn resets the thread — the next turn can attach again', () => {
    const tracker = new TurnAttachTracker()
    tracker.markAttached('t1', KNOWN_SIBLING)
    tracker.beginTurn('t1')
    expect(tracker.markAttached('t1', KNOWN_SIBLING)).toBe(true)
  })

  it('threads are independent', () => {
    const tracker = new TurnAttachTracker()
    tracker.markAttached('t1', KNOWN_SIBLING)
    expect(tracker.markAttached('t2', KNOWN_SIBLING)).toBe(true)
  })

  it('clearThread drops the memory', () => {
    const tracker = new TurnAttachTracker()
    tracker.markAttached('t1', KNOWN_SIBLING)
    tracker.clearThread('t1')
    expect(tracker.markAttached('t1', KNOWN_SIBLING)).toBe(true)
  })
})
