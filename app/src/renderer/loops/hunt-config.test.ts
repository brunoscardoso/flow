/**
 * The "keep looking" model — the loop option that now sits beside the work that
 * prompted it, instead of being a switch on a control centre.
 *
 * What has to hold, and why each one is here:
 *
 *  1. TURNING IT ON WITHOUT A RULE CANNOT CREATE. The whole point of moving a
 *     hunt onto a create form is that it arrives with the thing that ends it;
 *     an empty custom rule is a hunt with no way to end and is refused, never
 *     quietly downgraded to the backstop.
 *  2. THE NUMBER LIVES IN ONE PLACE. A `findings` hunt sends `cap` and nothing
 *     else; a `duration` or `custom` hunt sends NO cap, so the CLI's own
 *     default applies rather than a number this app invented.
 *  3. NONE, ONE AND SEVERAL PRODUCERS ARE THREE DIFFERENT ANSWERS, and so is
 *     "not read yet" — a control that showed the last two alike would tell a
 *     person their project has no producer every time the read was slow.
 */

import {
  describeHuntConfig,
  emptyHuntConfig,
  huntConfigNote,
  huntConfigRefusal,
  huntRequest,
  huntTargetFor,
  DEFAULT_HUNT_FINDINGS,
} from './hunt-config'
import { MAX_HUNT_RULE_LENGTH } from './hunt-limits'
import type { LoopsSnapshot, LoopStatusRow } from '../../shared/ipc-contract'

function on(over: Partial<ReturnType<typeof emptyHuntConfig>> = {}) {
  return { ...emptyHuntConfig(), on: true, ...over }
}

function snapshot(rows: Partial<LoopStatusRow>[]): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows.map((row) => ({
      loop: 'x',
      pause: null,
      locks: [],
      queue: null,
      ...row,
    })) as LoopStatusRow[],
    globalPause: null,
    digest: null,
    generatedAt: null,
  } as LoopsSnapshot
}

describe('a hunt switched on has to say how it ends', () => {
  test('a hunt that is OFF is never a refusal — the normal case must not block a create', () => {
    expect(huntConfigRefusal(emptyHuntConfig())).toBeNull()
    expect(huntRequest(emptyHuntConfig())).toBeNull()
    expect(describeHuntConfig(emptyHuntConfig())).toBe('')
  })

  test('a custom rule with nothing typed refuses, and refuses a request with it', () => {
    const config = on({ kind: 'custom', rule: '   ' })
    expect(huntConfigRefusal(config)).toMatch(/Say what should make it stop/)
    // Belt and braces: a caller that ignored the refusal still gets no request.
    expect(huntRequest(config)).toBeNull()
  })

  test('a rule longer than a sentence refuses rather than being cut in half', () => {
    const config = on({ kind: 'custom', rule: 'x'.repeat(MAX_HUNT_RULE_LENGTH + 1) })
    expect(huntConfigRefusal(config)).toMatch(/too long/)
  })

  test('the findings number has to be at least one', () => {
    expect(huntConfigRefusal(on({ findings: 0 }))).toMatch(/at least one/)
    expect(huntConfigRefusal(on({ findings: 1 }))).toBeNull()
  })

  test('an hour nobody offered refuses — the picker is the list of real answers', () => {
    expect(huntConfigRefusal(on({ kind: 'duration', hours: 7 }))).toMatch(/how long/)
    expect(huntConfigRefusal(on({ kind: 'duration', hours: 24 }))).toBeNull()
  })
})

describe('what each rule actually asks the CLI for', () => {
  test('findings sends the number as the cap, and nothing else', () => {
    expect(huntRequest(on({ findings: 5 }))).toEqual({ cap: 5, stop: { kind: 'findings' } })
  })

  test('time and a rule send NO cap — the backstop is the CLI’s, not one this app made up', () => {
    expect(huntRequest(on({ kind: 'duration', hours: 4 }))).toEqual({
      stop: { kind: 'duration', hours: 4 },
    })
    expect(huntRequest(on({ kind: 'custom', rule: '  the same bug twice  ' }))).toEqual({
      stop: { kind: 'custom', rule: 'the same bug twice' },
    })
  })

  test('the default is a small number of findings, not the backstop', () => {
    // Twenty findings is most of a day's reading; a person choosing is offered
    // the answer the user gave as their own example.
    expect(emptyHuntConfig().findings).toBe(DEFAULT_HUNT_FINDINGS)
    expect(DEFAULT_HUNT_FINDINGS).toBeLessThan(20)
  })

  test('every rule describes itself, and only names what was chosen', () => {
    expect(describeHuntConfig(on({ findings: 1 }))).toContain('1 thing')
    expect(describeHuntConfig(on({ kind: 'duration', hours: 1 }))).toContain('1 hour')
    // No number in the time form: nobody picked the backstop, so nothing claims one.
    expect(describeHuntConfig(on({ kind: 'duration', hours: 2 }))).not.toMatch(/\d+ findings/)
    expect(describeHuntConfig(on({ kind: 'custom', rule: 'it repeats' }))).toContain('it repeats')
  })
})

describe('which loop a hunt would run as', () => {
  test('not read yet is its own answer, not "this project has none"', () => {
    const target = huntTargetFor(null)
    expect(target.ok).toBe(false)
    expect(target.ok ? '' : target.reason).toMatch(/Still reading/)
  })

  test('one producer settles it with no question asked', () => {
    const target = huntTargetFor(snapshot([{ loop: 'find', engine: 'producer' }, { loop: 'fix', engine: 'consumer' }]))
    expect(target).toEqual({ ok: true, loop: 'find' })
  })

  test('no producer is named, never presented as a switch that would fail on press', () => {
    const target = huntTargetFor(snapshot([{ loop: 'fix', engine: 'consumer' }]))
    expect(target.ok).toBe(false)
    expect(target.ok ? '' : target.reason).toMatch(/no loop that looks for work/)
    expect(target.ok ? [] : (target.loops ?? [])).toEqual([])
  })

  test('several producers ask rather than picking one alphabetically', () => {
    const target = huntTargetFor(
      snapshot([
        { loop: 'sweep', engine: 'producer' },
        { loop: 'find', engine: 'producer' },
      ]),
    )
    expect(target.ok).toBe(false)
    expect(target.ok ? [] : target.loops).toEqual(['find', 'sweep'])
  })

  test('a producer whose directive would not parse is not offered as one', () => {
    // It is still a loop and still reported — but it cannot be run, and offering
    // it would put a refusal behind a switch somebody just pressed.
    const target = huntTargetFor(
      snapshot([
        { loop: 'find', engine: 'producer', directiveError: 'scope: is not a list' },
        { loop: 'sweep', engine: 'producer' },
      ]),
    )
    expect(target).toEqual({ ok: true, loop: 'sweep' })
  })
})

describe('the line under the controls says only what they do not', () => {
  test('a findings rule needs no note — the row already reads "5 findings"', () => {
    expect(huntConfigNote(on({ findings: 5 }))).toBeNull()
  })

  test('a custom rule needs none either — the sentence is in the field above it', () => {
    expect(huntConfigNote(on({ kind: 'custom', rule: 'the same bug twice' }))).toBeNull()
  })

  test('TIME does, because "2 hours" does not say it can also end early', () => {
    // Somebody who set a hunt for the afternoon deserves to know the list
    // filling up will stop it first.
    const note = huntConfigNote(on({ kind: 'duration', hours: 2 }))
    expect(note).toContain('2 hours')
    expect(note).toContain('sooner')
  })

  test('a hunt that is off says nothing at all', () => {
    expect(huntConfigNote(emptyHuntConfig())).toBeNull()
  })
})
