// The chain's policy, exhaustively — every rung, the question that holds it, and
// the two ways it ends.
//
// EVERY INPUT HERE IS OBSERVABLE STATE. There is no "the model said it was
// finished" among them and there must never be: the whole feature exists because
// a chain driven by self-report is a chain driven by whatever the model chose to
// write.

import {
  CHAIN_FINISHED,
  STEP_DID_NOT_FINISH,
  WAITING_ON_YOU,
  WORKFLOW_STAGES,
  type ChainState,
  type WorkflowStage,
  nextChainStep,
  nextStage,
  stageLabel,
  stagePrompt,
} from './chain-model'

function state(over: Partial<ChainState> = {}): ChainState {
  return {
    stage: null,
    startAt: 'discovery',
    threadStatus: 'idle',
    lastTurnSucceeded: null,
    tailDone: false,
    tailPublished: null,
    ...over,
  }
}

describe('the ladder', () => {
  it('runs discovery → plan → build → review, in that order', () => {
    expect(WORKFLOW_STAGES).toEqual(['discovery', 'create-plan', 'execute-plan', 'review-code'])
  })

  it('starts at the bottom and ends after the last rung', () => {
    expect(nextStage(null)).toBe('discovery')
    expect(nextStage('discovery')).toBe('create-plan')
    expect(nextStage('create-plan')).toBe('execute-plan')
    expect(nextStage('execute-plan')).toBe('review-code')
    expect(nextStage('review-code')).toBeNull()
  })

  it('an unrecognised stage starts over rather than skipping the ladder', () => {
    expect(nextStage('nonsense' as WorkflowStage)).toBe('discovery')
  })
})

describe('nextChainStep: advancing', () => {
  it('issues the first rung before anything has run', () => {
    expect(nextChainStep(state())).toEqual({ kind: 'issue', stage: 'discovery' })
  })

  it('honours a caller that starts further up the ladder', () => {
    expect(nextChainStep(state({ startAt: 'execute-plan' }))).toEqual({
      kind: 'issue',
      stage: 'execute-plan',
    })
  })

  it('advances one rung per clean turn, and never two', () => {
    const issued: WorkflowStage[] = []
    let current: WorkflowStage | null = null
    for (let round = 0; round < WORKFLOW_STAGES.length; round += 1) {
      const step = nextChainStep(
        state({ stage: current, lastTurnSucceeded: current === null ? null : true }),
      )
      expect(step.kind).toBe('issue')
      if (step.kind !== 'issue') return
      issued.push(step.stage)
      current = step.stage
    }
    expect(issued).toEqual([...WORKFLOW_STAGES])
  })

  it('publishes after the review, and finishes once it has', () => {
    const afterReview = state({ stage: 'review-code', lastTurnSucceeded: true })
    expect(nextChainStep(afterReview)).toEqual({ kind: 'tail' })
    expect(nextChainStep({ ...afterReview, tailDone: true })).toEqual({
      kind: 'stop',
      reason: CHAIN_FINISHED,
    })
  })
})

describe('nextChainStep: stopping', () => {
  it('HOLDS — never re-issues — while the person is being asked something', () => {
    for (const status of ['needs-decision', 'blocked'] as const) {
      expect(
        nextChainStep(state({ stage: 'create-plan', lastTurnSucceeded: true, threadStatus: status })),
      ).toEqual({ kind: 'wait', reason: WAITING_ON_YOU })
    }
  })

  it('the question outranks the turn’s outcome — a failed turn on a waiting thread still holds', () => {
    expect(
      nextChainStep(
        state({ stage: 'discovery', lastTurnSucceeded: false, threadStatus: 'needs-decision' }),
      ),
    ).toEqual({ kind: 'wait', reason: WAITING_ON_YOU })
  })

  it('stops rather than building on a step that did not finish', () => {
    expect(nextChainStep(state({ stage: 'create-plan', lastTurnSucceeded: false }))).toEqual({
      kind: 'stop',
      reason: STEP_DID_NOT_FINISH,
    })
  })
})

describe('what a person reads, and what the agent is sent', () => {
  it('labels every rung in words, never as a command', () => {
    for (const stage of WORKFLOW_STAGES) {
      const label = stageLabel(stage)
      expect(label).not.toMatch(/[/`]/)
      expect(label).not.toContain('plan-flow')
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('sends the rung’s command with the aim, and carries the chain’s id', () => {
    const prompt = stagePrompt({
      stage: 'discovery',
      aim: 'add a dark mode',
      chainId: 'chain-7',
      feature: 'add-a-dark-mode-7',
    })
    expect(prompt.split('\n')[0]).toBe('/discovery-plan add a dark mode')
    expect(prompt).toContain('chain-7')
    expect(prompt).toContain('stage=discovery')
  })

  it('tells each rung what to name what it leaves behind — the gate asks about that name', () => {
    // The driver mints the subject (`feature-slug.ts`) and the gate judges the
    // document named for it, so the name has to reach the agent that writes it.
    // Without this line the gate would be asking about a name nobody chose,
    // which is why the seam went unbuilt for the whole of #1915's first cut.
    const named = (stage: WorkflowStage): string =>
      stagePrompt({ stage, aim: 'add a dark mode', chainId: 'chain-7', feature: 'dark-mode-7' })
    expect(named('discovery')).toContain('flow/discovery/discovery_dark-mode-7_v1.md')
    expect(named('create-plan')).toContain('flow/plans/plan_dark-mode-7_v1.md')
    expect(named('execute-plan')).toContain('flow/plans/plan_dark-mode-7_v1.md')
    expect(named('review-code')).toContain('flow/reviewed-code/review_dark-mode-7.md')
    // …and it rides on the same marker the chain id does, so an agent reading
    // one has read the other.
    expect(named('discovery')).toContain('<!-- flow-chain: chain-7 stage=discovery feature=dark-mode-7 -->')
  })

  it('a chain with no aim sends a bare command, not a trailing space', () => {
    expect(
      stagePrompt({ stage: 'create-plan', aim: '', chainId: 'c', feature: 'unnamed-c' }).split(
        '\n',
      )[0],
    ).toBe('/create-plan')
  })

  it('asks for THIS rung and never for the next one — the order is not in the prompt', () => {
    // Task 6.1's other half: the four stages are issued in order BY THE
    // RUNTIME. If a prompt also told the agent what comes next, the order would
    // have two authors again — which is the whole complaint this feature came
    // from — and the run would work identically whether or not the driver did
    // anything, hiding a broken driver behind an obedient model.
    // Each rung's command, read back out of the prompt itself rather than from
    // a second copy of the table.
    const commandOf = (stage: WorkflowStage): string =>
      stagePrompt({ stage, aim: '', chainId: 'c', feature: 'dark-mode-c' }).split('\n')[0]!
    for (const stage of WORKFLOW_STAGES) {
      const prompt = stagePrompt({ stage, aim: 'add a dark mode', chainId: 'chain-7', feature: 'add-a-dark-mode-7' })
      // No sibling rung is named anywhere in the message the agent receives…
      for (const other of WORKFLOW_STAGES.filter((candidate) => candidate !== stage)) {
        expect(prompt).not.toContain(commandOf(other))
      }
      // …and nothing asks it to carry on by itself.
      expect(prompt).not.toMatch(/continue|chain (?:the|through)|next (?:command|stage|step)|then run/i)
    }
  })

  it('tells the build rung the chain owns the publish step — and only that rung', () => {
    const build = stagePrompt({ stage: 'execute-plan', aim: '', chainId: 'c', feature: 'dark-mode-c' })
    expect(build).toContain('Do not commit, push or open a pull request')
    for (const stage of ['discovery', 'create-plan', 'review-code'] as const) {
      expect(stagePrompt({ stage, aim: '', chainId: 'c', feature: 'dark-mode-c' })).not.toContain('Do not commit')
    }
  })
})
