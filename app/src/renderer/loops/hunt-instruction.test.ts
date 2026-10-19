// The one instruction-building code path (loops-on-the-board, Phase 7, Task 7.5).
//
// THE PREMISE THIS FILE CORRECTS: the plan asked for three entry points — a
// board composer, a card menu, a thread `/loop` — to be converged. None of the
// three existed. What is tested here is the path itself and the one caller that
// does exist (the hunt card), not three surfaces invented to have something to
// converge.

import { huntControlFor, normalizeHuntText } from './hunt-instruction'
import { MAX_HUNT_TEXT_LENGTH } from './hunt-limits'
import type { BoardHunt } from '../tasks/board-model'
import type { LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

function hunt(overrides: Partial<BoardHunt> = {}): BoardHunt {
  return {
    key: 'find ui gaps',
    text: 'find UI gaps',
    loops: ['find'],
    topics: ['codemap'],
    filed: 20,
    cap: 20,
    quietRuns: 0,
    status: 'capped',
    ageLabel: '3d ago',
    ...overrides,
  }
}

function row(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'find',
    pause: null,
    locks: [],
    queue: null,
    ...overrides,
  }
}

function loops(rows: LoopStatusRow[] = [row()]): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows,
    globalPause: null,
    digest: null,
    generatedAt: null,
  }
}

describe('normalizeHuntText — one sentence, one instruction', () => {
  it('applies the CLI\'s own identity rule', () => {
    // `instructionKey` collapses whitespace and trims; retyping a sentence must
    // resume the hunt rather than start a second one. Two surfaces normalizing
    // differently is exactly how one hunt becomes two.
    expect(normalizeHuntText('  find   UI\ngaps ')).toBe('find UI gaps')
  })
})

describe('huntControlFor', () => {
  it('offers nothing for a RUNNING hunt — the press would do nothing', () => {
    // `startInstruction` returns an active instruction exactly as it stands.
    expect(huntControlFor(hunt({ status: 'active' }), loops())).toBeNull()
  })

  it('resumes a capped hunt through `loop resume --loop <n> --focus <text>`', () => {
    const control = huntControlFor(hunt(), loops())
    expect(control?.actionable).toBe(true)
    expect(control?.intent).toEqual({
      loop: 'find',
      focus: 'find UI gaps',
      cap: 20,
    })
  })

  it('names the WHOLE consequence, not just the hunt', () => {
    // The same invocation lifts the loop's pause AND restarts the count at 0.
    // A control that promised only "resume hunt" would be a button that does not
    // name the scope the CLI acts on.
    const control = huntControlFor(hunt(), loops())
    expect(control?.title).toContain("lifts find's pause")
    expect(control?.title).toContain('restarts the count at 0')
  })

  it('refuses to guess the loop when two producers report one hunt', () => {
    // The instruction store records no owner, so `loop status` reports the same
    // hunts on every producer row. Picking the first would invent the one fact
    // the CLI is explicit about not having.
    const control = huntControlFor(hunt({ loops: ['find', 'hunt'] }), loops())
    expect(control?.actionable).toBe(false)
    expect(control?.blockedReason).toContain('find and hunt')
    expect(control?.blockedReason).toContain('records which one owns it')
    // NO COMMAND IN A SENTENCE A PERSON READS.
    expect(control?.blockedReason).not.toContain('planflow-ai')
  })

  it('has no working control for a loop switched off in its DIRECTIVE', () => {
    // Resuming the hunt would leave the loop that files for it stopped, so the
    // press would half-work. The reason says THAT — it no longer hands the
    // reader a file to open (forbidden pattern #12).
    const control = huntControlFor(hunt(), loops([row({ directivePaused: true })]))
    expect(control?.actionable).toBe(false)
    expect(control?.blockedReason).toContain('switched off')
    expect(control?.blockedReason).not.toContain('loops/')
    expect(control?.blockedReason).not.toContain('.md')
  })

  it('still resumes when the pause is one the CLI can lift', () => {
    const control = huntControlFor(
      hunt(),
      loops([row({ directivePaused: true, pause: { scope: 'loop', reason: 'x', since: '' } })]),
    )
    expect(control?.actionable).toBe(true)
  })

  it('refuses an over-long sentence HERE rather than after a spawn', () => {
    const control = huntControlFor(hunt({ text: 'x'.repeat(MAX_HUNT_TEXT_LENGTH + 1) }), loops())
    expect(control?.actionable).toBe(false)
    expect(control?.blockedReason).toContain(String(MAX_HUNT_TEXT_LENGTH))
  })

  it('still offers the control when no status snapshot is in hand', () => {
    // The snapshot only adds the directive-pause veto; without it the CLI is
    // still the authority, and it will refuse on its own terms if it must.
    expect(huntControlFor(hunt(), null)?.actionable).toBe(true)
  })

  it('normalizes the focus once, in the intent', () => {
    const control = huntControlFor(hunt({ text: '  find   UI gaps  ' }), loops())
    expect(control?.intent?.focus).toBe('find UI gaps')
  })
})
