import {
  conflictRiskLabel,
  mergeSideControl,
  nextSidePress,
  MERGE_SIDE_ICON,
} from './source-control-actions'

/**
 * The conflict row asks for a decision, so it has to be readable and it has to
 * be hard to make by accident. Reported live, twice:
 *
 * 1. In a narrow sidebar the two bare stage words sat against the filename, and
 *    a click meant to open the file resolved the conflict to one side instead.
 * 2. The fix for (1) put the BRANCH NAME in the control, and a 53-character
 *    branch in a 28px row rendered as
 *    "Jse ACME-2446-rework-the-session-cache-for-the-new-route" —
 *    a clipped verb on a control that no longer looked like a button.
 *
 * What holds both: a fixed role word (a choice, not a folder), a glyph, and the
 * branch name promoted OUT of the control into the section legend.
 */
describe('choosing a side takes two presses', () => {
  it('previews first, applies second', () => {
    const first = nextSidePress(undefined, 'ours')
    expect(first).toEqual({ action: 'preview', armed: 'ours' })
    expect(nextSidePress(first.armed, 'ours')).toEqual({ action: 'apply', armed: undefined })
  })

  it('arming the other side moves the arming instead of loading two buttons', () => {
    const armed = nextSidePress('ours', 'theirs')
    expect(armed).toEqual({ action: 'preview', armed: 'theirs' })
    // …and the side that was armed a moment ago no longer applies on one press.
    expect(nextSidePress(armed.armed, 'ours')).toEqual({ action: 'preview', armed: 'ours' })
  })
})

describe('the side controls say what they do, at a width the design chose', () => {
  const branch = { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true } as const
  const long = {
    kind: 'theirs',
    ref: 'MERGE_HEAD',
    branch: 'ACME-2446-rework-the-session-cache-for-the-new-router',
    isCurrentUser: false,
  } as const

  it('reads as a role word, never as a branch name', () => {
    expect(mergeSideControl('ours', false, branch).text).toBe('Current')
    expect(mergeSideControl('theirs', false, long).text).toBe('Incoming')
  })

  it('has a label whose width the repository cannot change', () => {
    // The bug: the label was as long as whatever the branch happened to be
    // called, so no panel width could be wide enough.
    for (const identity of [branch, long, undefined]) {
      expect(mergeSideControl('theirs', false, identity).text).toBe('Incoming')
      expect(mergeSideControl('theirs', true, identity).text).toBe('Confirm')
    }
    expect(mergeSideControl('ours', false, long).text.length).toBeLessThanOrEqual(9)
  })

  it('still names the real branch — in the title, where length is free', () => {
    expect(mergeSideControl('ours', false, branch).title).toContain('main')
    expect(mergeSideControl('theirs', false, long).title).toContain(long.branch)
  })

  it('names a side in the title even when the branch is unknown', () => {
    expect(mergeSideControl('ours', false).title).toContain('the current side')
    expect(mergeSideControl('theirs', false).title).toContain('the incoming side')
  })

  it('the second press is a fixed Confirm, and warns what it costs', () => {
    const armed = mergeSideControl('theirs', true, long)
    expect(armed.text).toBe('Confirm')
    expect(armed.title).toMatch(/dropped/i)
    expect(armed.armed).toBe(true)
  })

  it('separates the two sides by SHAPE, so colour is never the only channel', () => {
    const ours = mergeSideControl('ours', false, branch)
    const theirs = mergeSideControl('theirs', false, long)
    expect(ours.icon).toBe(MERGE_SIDE_ICON.ours)
    expect(theirs.icon).toBe(MERGE_SIDE_ICON.theirs)
    expect(ours.icon).not.toBe(theirs.icon)
    expect(ours.accent).toBe('a')
    expect(theirs.accent).toBe('b')
  })
})

describe('the risk badge names what was found', () => {
  it('describes the edits rather than grading the file', () => {
    // "RISKY" told the reader to be careful without saying what about — while
    // they were deciding whether one side could be taken whole.
    expect(conflictRiskLabel('risky').text).toBe('Overlapping')
    expect(conflictRiskLabel('safe').text).toBe('Separate')
    expect(conflictRiskLabel('pending').text).toMatch(/check/i)
  })

  it('is short enough to render whole — "Separate ed" was the old one clipping', () => {
    for (const badge of ['safe', 'risky', 'pending'] as const) {
      expect(conflictRiskLabel(badge).text.length).toBeLessThanOrEqual(11)
    }
  })

  it('explains each one in words a person can act on', () => {
    expect(conflictRiskLabel('risky').detail).toMatch(/same lines/i)
    expect(conflictRiskLabel('safe').detail).toMatch(/different parts/i)
  })
})
