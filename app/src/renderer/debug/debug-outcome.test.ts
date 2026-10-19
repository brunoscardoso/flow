/**
 * The sentence shown when a session ends. Everything about what a session HOLDS
 * is tested where that lives; this is about what a person is told.
 */
import { outcomeOf } from './debug-outcome'
import type { DebugStopResult } from '../../shared/debug-session-ipc'

function result(over: Partial<DebugStopResult> = {}): DebugStopResult {
  return {
    artifactDir: '/repos/app/flow/.debug-sessions/dbg-1',
    timelinePath: 'flow/.debug-sessions/dbg-1/timeline.md',
    projectRoot: '/repos/app',
    summary: '…',
    records: 12,
    end: 'finished',
    ...over,
  }
}

describe('what the control says when a session ends', () => {
  it('says where the record went, in terms of what to do next', () => {
    expect(outcomeOf(result())).toBe(
      'The debug session captured 12 records — it is open, and attached to your next message.',
    )
  })

  it('never puts a PATH in the sentence', () => {
    // forbidden-pattern #12: a path is an internal detail the reader cannot act
    // on. The chip carries it for the agent; the person gets a sentence.
    for (const r of [result(), result({ timelinePath: null }), result({ records: 0 })]) {
      const text = outcomeOf(r)
      expect(text).not.toContain('/repos/')
      expect(text).not.toContain('.debug-sessions')
      expect(text).not.toContain('timeline.md')
    }
  })

  it('distinguishes "nothing happened" from "nowhere to save it"', () => {
    // Two different problems with two different remedies, and reporting either
    // as the other sends somebody looking in the wrong place.
    expect(outcomeOf(result({ records: 0 }))).toContain('recorded nothing')
    expect(outcomeOf(result({ timelinePath: null }))).toContain('could not be saved')
  })

  it('counts one record in the singular', () => {
    expect(outcomeOf(result({ records: 1 }))).toContain('1 record —')
  })
})
