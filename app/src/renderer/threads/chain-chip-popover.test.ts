import { chainChipState, type ChainChipState } from './chain-chip'
import {
  PR_LINK_LABEL,
  POPOVER_TITLE,
  STOP_EXPLAIN,
  STOP_LABEL,
  chainChipPopover,
} from './chain-chip-popover'
import type { ChainState } from '../../shared/ipc-contract'

const chain = (over: Partial<ChainState> = {}): ChainState => ({
  threadId: 't1',
  running: false,
  step: null,
  waitingOnYou: false,
  stoppedReason: null,
  prUrl: null,
  notPublished: null,
  ...over,
})

/** The chip state for one wire shape — every case here has one. */
function stateFor(over: Partial<ChainState>): ChainChipState {
  const state = chainChipState(chain(over))
  if (state === null) throw new Error('this shape was expected to draw a chip')
  return state
}

const SHAPES: Array<Partial<ChainState>> = [
  { running: true },
  { running: true, step: 'Planning the work' },
  { running: true, waitingOnYou: true },
  { stoppedReason: 'Everything on the list is done.' },
  { stoppedReason: 'The last step did not finish, so nothing more was started.' },
  { notPublished: 'Nobody has said where this branch should go.' },
  { stoppedReason: 'Everything on the list is done.', prUrl: 'https://example.invalid/pr/7' },
]

describe('what stopping does, and what it does not', () => {
  it('says both halves: nothing further starts, and the running step is not interrupted', () => {
    const popover = chainChipPopover(stateFor({ running: true, step: 'Building it' }))
    expect(popover.stop).toEqual({ label: STOP_LABEL, explain: STOP_EXPLAIN })
    // The first promise: no further step is issued.
    expect(STOP_EXPLAIN).toMatch(/Nothing further is started/)
    // The second, which is the one a person would otherwise assume wrongly: the
    // turn in flight keeps running and finishes.
    expect(STOP_EXPLAIN).toMatch(/not interrupted/)
    expect(STOP_EXPLAIN).toMatch(/finishes/)
  })

  it('offers stopping while it holds for an answer — a hold is still a live run', () => {
    expect(chainChipPopover(stateFor({ running: true, waitingOnYou: true })).stop).not.toBeNull()
  })

  it('offers nothing to stop once the run is over', () => {
    for (const shape of SHAPES.filter((shape) => shape.running !== true)) {
      expect(chainChipPopover(stateFor(shape)).stop).toBeNull()
    }
  })
})

describe('what it says in each state', () => {
  it('is about autopilot, whatever autopilot is doing', () => {
    for (const shape of SHAPES) {
      expect(chainChipPopover(stateFor(shape)).title).toBe(POPOVER_TITLE)
    }
  })

  it('shows the step as the status while it runs', () => {
    expect(chainChipPopover(stateFor({ running: true, step: 'Planning the work' })).status).toBe(
      'Planning the work.',
    )
  })

  it('tells the waiting person that their reply is what starts the next step', () => {
    const popover = chainChipPopover(stateFor({ running: true, waitingOnYou: true }))
    expect(popover.status).toMatch(/Waiting for your answer/)
    expect(popover.note).toMatch(/Your reply starts the next step/)
  })

  it('explains the unpublished ending as work that exists and waits on a person', () => {
    const popover = chainChipPopover(
      stateFor({ notPublished: 'The changes were rated high risk, so publishing waits for you.' }),
    )
    expect(popover.status).toMatch(/built, reviewed and saved/)
    expect(popover.note).toMatch(/publishing it is yours to do/)
    // Main's sentence is passed through untouched — one refusal, one wording.
    expect(popover.detail).toBe('The changes were rated high risk, so publishing waits for you.')
  })

  it('offers the pull request as something to open, not as a string to read', () => {
    const popover = chainChipPopover(
      stateFor({ stoppedReason: 'Everything on the list is done.', prUrl: 'https://example.invalid/pr/7' }),
    )
    expect(popover.link).toEqual({ label: PR_LINK_LABEL, url: 'https://example.invalid/pr/7' })
    expect(popover.status).not.toContain('https://')
  })

  it('carries a self-stop reason verbatim rather than re-wording it', () => {
    expect(chainChipPopover(stateFor({ stoppedReason: 'Everything on the list is done.' }))).toMatchObject(
      { status: 'Not running on this conversation.', detail: 'Everything on the list is done.' },
    )
  })
})

describe('the words', () => {
  it('names no path, command or config key (forbidden-pattern #12)', () => {
    const everything = SHAPES.map((shape) => {
      const popover = chainChipPopover(stateFor(shape))
      return [popover.title, popover.status, popover.note ?? '', popover.stop?.label ?? '', popover.stop?.explain ?? '', popover.link?.label ?? '']
        .join(' ')
    }).join(' ')
    expect(everything).not.toMatch(
      /planflow-ai|\.flowconfig|\/execute-plan|\/create-plan|\/discovery-plan|\/review-code|npm |git /,
    )
  })

  it('never leaves a state without words of its own', () => {
    for (const shape of SHAPES) {
      const popover = chainChipPopover(stateFor(shape))
      expect(popover.status.trim()).not.toBe('')
    }
  })
})
