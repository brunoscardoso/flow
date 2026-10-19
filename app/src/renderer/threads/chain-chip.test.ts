import {
  CHAIN_CHIP_LABELS,
  ENDED_LABEL,
  HELD_LABEL,
  PUBLISHED_LABEL,
  STARTING_LABEL,
  WAITING_LABEL,
  chainChipState,
} from './chain-chip'
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

/** Every shape the wire can hand the chip. */
const SHAPES: Array<Partial<ChainState>> = [
  {},
  { running: true },
  { running: true, step: 'Planning the work' },
  { running: true, step: '   ' },
  { running: true, step: 'Building it', waitingOnYou: true },
  { running: true, waitingOnYou: true },
  { stoppedReason: 'Everything on the list is done.' },
  { stoppedReason: 'The last step did not finish, so nothing more was started.' },
  { stoppedReason: 'Autopilot is off for this project, so nothing was started.' },
  { stoppedReason: '   ' },
  {
    stoppedReason: 'The work is built and reviewed, and it was not published.',
    notPublished: 'Nobody has said where this branch should go.',
  },
  { stoppedReason: 'Everything on the list is done.', prUrl: 'https://example.invalid/pr/7' },
  { prUrl: '   ' },
]

describe('a conversation with no autopilot shows nothing at all', () => {
  it('has no chip before anything has been read', () => {
    expect(chainChipState(null)).toBeNull()
  })

  it('has no chip for the state main reports for a thread that never had one', () => {
    // running:false and every field null is what `flow:chain` answers for the
    // overwhelming majority of conversations. A chip here would be a permanent
    // blank on all of them.
    expect(chainChipState(chain())).toBeNull()
  })

  it('goes away when a PERSON ended it, which main records as no reason at all', () => {
    // Main leaves `stoppedReason` null on a person's own stop deliberately:
    // their gesture needs no explanation. The chip must read that as absence,
    // never as a chip with an empty reason in it.
    expect(chainChipState(chain({ running: false, stoppedReason: null }))).toBeNull()
  })

  it('treats a blank reason as no reason, rather than drawing an empty chip', () => {
    expect(chainChipState(chain({ stoppedReason: '   ' }))).toBeNull()
    expect(chainChipState(chain({ prUrl: '  ' }))).toBeNull()
  })
})

describe('the five states read differently from each other', () => {
  it('names the step it is on while it runs', () => {
    expect(chainChipState(chain({ running: true, step: 'Planning the work' }))).toMatchObject({
      label: 'Planning the work',
      tone: 'running',
      canStop: true,
    })
  })

  it('says it is getting started rather than printing a blank step', () => {
    for (const step of [null, '   ']) {
      expect(chainChipState(chain({ running: true, step }))?.label).toBe(STARTING_LABEL)
    }
  })

  it('reports a question as its own state — not as an error, not as progress', () => {
    const state = chainChipState(chain({ running: true, step: 'Building it', waitingOnYou: true }))
    expect(state).toMatchObject({ label: WAITING_LABEL, tone: 'waiting', canStop: true })
    // The hold outranks the step: being asked something is the one fact the
    // person can act on, and it is what main itself checks first.
    expect(state?.label).not.toBe('Building it')
  })

  it('leads the unpublished ending with the work that exists, not the absence', () => {
    const state = chainChipState(
      chain({
        stoppedReason: 'The work is built and reviewed, and it was not published.',
        notPublished: 'The changes were rated high risk, so publishing waits for you.',
      }),
    )
    expect(state).toMatchObject({ label: HELD_LABEL, tone: 'held', canStop: false })
    expect(state?.title).toContain('built, reviewed and saved')
    // Main's own sentence is carried, not re-worded.
    expect(state?.detail).toBe('The changes were rated high risk, so publishing waits for you.')
  })

  it('never renders the unpublished ending in the failure tone', () => {
    const tones = [
      'Nobody has said where this branch should go.',
      'The changes were rated high risk, so publishing waits for you.',
    ].map((notPublished) => chainChipState(chain({ notPublished }))?.tone)
    expect(tones).toEqual(['held', 'held'])
  })

  it('shows a finished run’s pull request as its own state', () => {
    const state = chainChipState(
      chain({ stoppedReason: 'Everything on the list is done.', prUrl: 'https://example.invalid/pr/7' }),
    )
    expect(state).toMatchObject({
      label: PUBLISHED_LABEL,
      tone: 'published',
      prUrl: 'https://example.invalid/pr/7',
      canStop: false,
    })
  })

  it('carries a self-stop reason verbatim under one honest label', () => {
    const state = chainChipState(chain({ stoppedReason: 'Everything on the list is done.' }))
    expect(state).toMatchObject({ label: ENDED_LABEL, tone: 'ended', canStop: false })
    expect(state?.detail).toBe('Everything on the list is done.')
    expect(state?.title).toContain('Everything on the list is done.')
  })

  it('gives every state a tone of its own', () => {
    const tones = SHAPES.map((shape) => chainChipState(chain(shape))?.tone).filter(
      (tone) => tone !== undefined,
    )
    expect(new Set(tones)).toEqual(
      new Set(['running', 'waiting', 'held', 'published', 'ended']),
    )
  })
})

describe('stopping is offered exactly while there is a run to stop', () => {
  it('offers it while a step runs and while it holds for an answer', () => {
    expect(chainChipState(chain({ running: true }))?.canStop).toBe(true)
    expect(chainChipState(chain({ running: true, waitingOnYou: true }))?.canStop).toBe(true)
  })

  it('never offers it once the run is over', () => {
    for (const shape of SHAPES.filter((shape) => shape.running !== true)) {
      expect(chainChipState(chain(shape))?.canStop ?? false).toBe(false)
    }
  })

  it('reports a live run rather than an ending held over from the last one', () => {
    // Main keeps the previous run's outcome so a person can still read it. A
    // new run outranks it: stale news beside a working agent is worse than no
    // news at all.
    expect(
      chainChipState(
        chain({
          running: true,
          step: 'Building it',
          prUrl: 'https://example.invalid/pr/1',
          notPublished: 'Nobody has said where this branch should go.',
        }),
      ),
    ).toMatchObject({ tone: 'running', label: 'Building it' })
  })
})

describe('the words', () => {
  it('never renders a blank label', () => {
    for (const shape of SHAPES) {
      const state = chainChipState(chain(shape))
      if (state === null) continue
      expect(state.label.trim()).not.toBe('')
      expect(state.title.trim()).not.toBe('')
    }
  })

  it('names no path, command or config key (forbidden-pattern #12)', () => {
    const everything = SHAPES.map((shape) => {
      const state = chainChipState(chain(shape))
      return state === null ? '' : `${state.label} ${state.title}`
    }).join(' ')
    expect(everything).not.toMatch(/planflow-ai|\.flowconfig|npm |git |\/execute-plan|\/create-plan/)
    // The chip's own fixed vocabulary, checked as a set so a new label cannot
    // be added without passing through this rule.
    expect(CHAIN_CHIP_LABELS.join(' ')).not.toMatch(/planflow-ai|\.flowconfig|\/|--/)
  })
})
