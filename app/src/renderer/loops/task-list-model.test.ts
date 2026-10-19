/**
 * "Where does this project's work come from" — the setting that decides whether
 * the board has a Remote column at all.
 *
 * ONE QUESTION, N ANSWERS. A project has one list; the store keeps one answer
 * per loop, in each loop's committed directive. Everything here is about that
 * gap being faced rather than hidden: loops that disagree are SHOWN, a write
 * that lands half way SAYS so, and a path never reaches a sentence.
 */

import {
  TASK_LIST_CHOICES,
  taskListLabelFor,
  taskListOutcome,
  taskListProblem,
  taskListStateFor,
} from './task-list-model'
import type { LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

function snapshot(rows: Partial<LoopStatusRow>[], over: Partial<LoopsSnapshot> = {}): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows.map((row) => ({ loop: 'x', pause: null, locks: [], queue: null, ...row })) as LoopStatusRow[],
    globalPause: null,
    digest: null,
    generatedAt: null,
    ...over,
  } as LoopsSnapshot
}

describe('what this project reads now', () => {
  it('names a GitHub list by its repository', () => {
    const state = taskListStateFor(
      snapshot([{ loop: 'fix', queueKind: 'github', queueLocation: 'acme/widgets' }]),
    )
    expect(state.agreed).toEqual({ kind: 'github', repo: 'acme/widgets' })
    expect(state.summary).toContain('GitHub · acme/widgets')
  })

  it('never prints a ledger’s PATH — only the file’s own name', () => {
    // Forbidden-pattern #12: a path in UI text hands the reader an internal.
    const label = taskListLabelFor({
      loop: 'fix',
      queueKind: 'ledger',
      queueLocation: 'flow/loops/queue.jsonl',
    } as LoopStatusRow)
    expect(label).toBe('This project · queue')
    expect(label).not.toContain('/')
  })

  it('SHOWS a disagreement rather than picking one of the answers', () => {
    const state = taskListStateFor(
      snapshot([
        { loop: 'fix', queueKind: 'github', queueLocation: 'acme/widgets' },
        { loop: 'find', queueKind: 'ledger', queueLocation: 'flow/loops/queue.jsonl' },
      ]),
    )
    expect(state.agreed).toBeNull()
    expect(state.disagreement.map((entry) => entry.loop)).toEqual(['fix', 'find'])
    // Both loops are still what a write would touch — the point is to fix the
    // disagreement, not to refuse because of it.
    expect(state.loops).toEqual(['fix', 'find'])
  })

  it('counts a loop nobody could read out of the write, and says nothing about its list', () => {
    // The CLI refuses to rewrite a directive it could not parse, so offering to
    // change it would be an offer the write cannot honour.
    const state = taskListStateFor(
      snapshot([
        { loop: 'fix', queueKind: 'github', queueLocation: 'acme/widgets' },
        { loop: 'broken', directiveError: 'scope: is not a list' },
      ]),
    )
    expect(state.loops).toEqual(['fix'])
    expect(state.agreed).toEqual({ kind: 'github', repo: 'acme/widgets' })
  })

  it('"could not read" and "has none" are different answers', () => {
    expect(taskListStateFor(null).known).toBe(false)
    expect(taskListStateFor(null).summary).toMatch(/Couldn’t read|Couldn't read/)
    const none = taskListStateFor(snapshot([]))
    expect(none.known).toBe(true)
    expect(none.summary).toMatch(/no loops/)
  })
})

describe('what a person may ask for', () => {
  it('offers GitHub first — it is the one that needs a name typed after it', () => {
    expect(TASK_LIST_CHOICES.map((choice) => choice.kind)).toEqual(['github', 'ledger'])
  })

  it('refuses a repository that is not one, before the write leaves the app', () => {
    expect(taskListProblem({ kind: 'github', repo: '' })).toMatch(/owner and name/)
    expect(taskListProblem({ kind: 'github', repo: 'widgets' })).toMatch(/acme\/widgets/)
    expect(taskListProblem({ kind: 'github', repo: 'acme/widgets' })).toBeNull()
  })

  it('asks the project’s own list for no location at all', () => {
    expect(taskListProblem({ kind: 'ledger', repo: '' })).toBeNull()
  })
})

describe('what N writes did', () => {
  it('says how many took it', () => {
    expect(taskListOutcome(['fix'], [])).toContain('1 loop')
    expect(taskListOutcome(['fix', 'find'], [])).toContain('2 loops')
  })

  it('names a HALF-LANDED write as exactly that', () => {
    // Reporting either half alone leaves a person believing the project agrees
    // when it does not.
    const said = taskListOutcome(['fix'], ['find'])
    expect(said).toContain('fix')
    expect(said).toContain('find')
    expect(said).toContain('did not')
  })

  it('says nothing changed when nothing did', () => {
    expect(taskListOutcome([], ['fix', 'find'])).toMatch(/Nothing changed/)
  })
})
