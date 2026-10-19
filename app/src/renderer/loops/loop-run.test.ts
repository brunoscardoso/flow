// The press that starts a loop. What it refuses, what it writes first, and what
// it actually sends.

import {
  huntMatching,
  mintRunKey,
  planLoopRun,
  runBlockedReason,
  runConsequence,
  runControlFor,
  runStartError,
  runWriteError,
  standingHuntFor,
  threadTitleFor,
  RUN_LABEL,
} from './loop-run'
import { MAX_HUNT_TEXT_LENGTH } from './hunt-limits'
import type { LoopInstruction, LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

function row(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'find',
    engine: 'producer',
    directivePaused: false,
    pause: null,
    locks: [],
    queue: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<LoopsSnapshot> = {}): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: [],
    globalPause: null,
    digest: null,
    generatedAt: null,
    ...overrides,
  }
}

function instruction(overrides: Partial<LoopInstruction> = {}): LoopInstruction {
  return {
    text: 'gaps in the feature blueprint',
    filed: 0,
    cap: 20,
    quietRuns: 0,
    status: 'active',
    since: '2026-08-11T08:00:00.000Z',
    ...overrides,
  }
}

const RUNNABLE = snapshot()

describe('what the gate would refuse, answered before the round trip', () => {
  it('lets a loop nothing is stopping run', () => {
    expect(runBlockedReason(row(), RUNNABLE, { aim: 'anything', cap: 20 })).toBeNull()
  })

  it('refuses a loop whose own settings could not be read', () => {
    // `directivePaused` ABSENT is the CLI's own signal that the directive did not
    // parse — the gate throws long before it reaches the pause check, so this is
    // not "off", it is "cannot run at all".
    const blocked = runBlockedReason(row({ directivePaused: undefined }), RUNNABLE, { aim: '', cap: 20 })
    expect(blocked).toContain('could not be read')
  })

  it('refuses a switched-off loop and names the switch, never a file', () => {
    const blocked = runBlockedReason(row({ directivePaused: true }), RUNNABLE, { aim: '', cap: 20 })
    // THE JUSTIFICATION, MADE A TEST. Turning it on is a committed setting that
    // travels with the repo; a press labelled "Run now" must not change it. So
    // the refusal points at the control one step away instead.
    expect(blocked).toContain('switched off')
    expect(blocked).toContain('switch beside it')
  })

  it('refuses when everything is stopped', () => {
    const stopped = snapshot({
      globalPause: { scope: 'global', reason: 'deploying', since: '2026-08-14T07:00:00.000Z' },
    })
    expect(runBlockedReason(row(), stopped, { aim: '', cap: 20 })).toContain('Everything is stopped')
  })

  it('refuses a loop stopped for now, carrying the reason somebody gave', () => {
    const blocked = runBlockedReason(
      row({ pause: { scope: 'loop', reason: 'the list is long', since: '2026-08-14T07:00:00.000Z' } }),
      RUNNABLE,
      { aim: '', cap: 20 },
    )
    expect(blocked).toContain('the list is long')
  })

  it('refuses an aim the CLI would refuse, in characters rather than flags', () => {
    const blocked = runBlockedReason(row(), RUNNABLE, {
      aim: 'x'.repeat(MAX_HUNT_TEXT_LENGTH + 1),
      cap: 20,
    })
    expect(blocked).toContain(String(MAX_HUNT_TEXT_LENGTH))
    expect(blocked).not.toContain('--')
  })

  it('refuses a guard rail that is not a number of finds', () => {
    expect(runBlockedReason(row(), RUNNABLE, { aim: 'anything', cap: 0 })).not.toBeNull()
    expect(runBlockedReason(row(), RUNNABLE, { aim: 'anything', cap: 1.5 })).not.toBeNull()
    // …and a loop that HAS no guard rail is not asked to have one.
    expect(runBlockedReason(row({ engine: 'consumer' }), RUNNABLE, { aim: '', cap: null })).toBeNull()
  })
})

describe('one run, and the standing instruction it may have to write first', () => {
  it('writes the guard rail when the store has never heard this sentence', () => {
    // The whole reason the write exists: `/agent-loop` carries no cap, so a hunt
    // the store meets for the first time inside the run would get the CLI's
    // default and silently ignore the number on screen.
    const plan = planLoopRun(row(), { aim: 'gaps in the feature blueprint', cap: 5 })
    expect(plan.write).toEqual({ loop: 'find', focus: 'gaps in the feature blueprint', cap: 5 })
  })

  it('writes nothing when the boxes already describe the hunt the store holds', () => {
    // THE CASE THAT PROTECTS A COUNT. Pressing Run to watch a hunt at 7 of 20
    // must not stop and restart it, which is what `resume --focus` does.
    const held = row({ instructions: [instruction({ filed: 7, cap: 20 })] })
    const plan = planLoopRun(held, { aim: 'gaps in the feature blueprint', cap: 20 })
    expect(plan.write).toBeNull()
  })

  it('writes when only the guard rail moved', () => {
    const held = row({ instructions: [instruction({ filed: 7, cap: 20 })] })
    expect(planLoopRun(held, { aim: 'gaps in the feature blueprint', cap: 4 }).write?.cap).toBe(4)
  })

  it('matches the store the way the CLI keys it — whitespace and case', () => {
    const held = row({ instructions: [instruction({ text: 'gaps in the feature blueprint' })] })
    expect(huntMatching(held, '  Gaps   in the FEATURE blueprint ')?.cap).toBe(20)
    expect(huntMatching(held, 'something else')).toBeNull()
    expect(huntMatching(held, '   ')).toBeNull()
  })

  it('never writes for a loop that has no hunt to cap', () => {
    const fix = row({ loop: 'fix', engine: 'consumer' })
    expect(planLoopRun(fix, { aim: 'backlog', cap: null }).write).toBeNull()
  })

  it('never writes an empty aim, which would be a hunt with no sentence', () => {
    expect(planLoopRun(row(), { aim: '   ', cap: 20 }).write).toBeNull()
  })

  it('sends the loop’s own command, with the aim as its one argument', () => {
    expect(planLoopRun(row(), { aim: '  gaps  in the  blueprint ', cap: 20 }).message).toBe(
      '/agent-loop find gaps in the blueprint',
    )
    expect(planLoopRun(row({ loop: 'fix', engine: 'consumer' }), { aim: '', cap: null }).message).toBe(
      '/agent-loop fix',
    )
  })
})

describe('the thread the run lives in', () => {
  it('is named for the run so it is findable later', () => {
    expect(threadTitleFor('find', 'gaps in the feature blueprint')).toBe(
      'find · gaps in the feature blueprint',
    )
    expect(threadTitleFor('fix', '')).toBe('fix run')
  })

  it('shortens an aim that would stop being a name', () => {
    const title = threadTitleFor('find', 'x'.repeat(MAX_HUNT_TEXT_LENGTH))
    expect(title.length).toBeLessThan(70)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('what the press says it will do', () => {
  it('names the chat, always', () => {
    const plan = planLoopRun(row({ instructions: [instruction({ cap: 20 })] }), {
      aim: 'gaps in the feature blueprint',
      cap: 20,
    })
    expect(runConsequence(row(), plan, { aim: 'gaps in the feature blueprint', cap: 20 })).toContain(
      'new chat you can watch',
    )
  })

  it('names the guard rail when one is about to be written', () => {
    const fields = { aim: 'gaps in the feature blueprint', cap: 5 }
    const plan = planLoopRun(row(), fields)
    expect(runConsequence(row(), plan, fields)).toContain('stop after 5 finds')
  })

  it('warns that a count is about to start again, because nobody would guess it', () => {
    // `loop resume --focus` STOPS the instruction and STARTS it again — the CLI's
    // documented "I looked, carry on". A hunt at 7 of 20 rewritten with a new cap
    // comes back at 0, and meeting that unannounced is alarming.
    const held = row({ instructions: [instruction({ filed: 7, cap: 20 })] })
    const fields = { aim: 'gaps in the feature blueprint', cap: 4 }
    expect(runConsequence(held, planLoopRun(held, fields), fields)).toContain('starts again at 0')
  })

  it('says nothing about a count when there was none to lose', () => {
    const fields = { aim: 'a brand new sentence', cap: 4 }
    expect(runConsequence(row(), planLoopRun(row(), fields), fields)).not.toContain('starts again')
  })
})

describe('the control itself', () => {
  it('is present but dead when the gate would refuse, carrying the reason', () => {
    const control = runControlFor(row({ directivePaused: true }), RUNNABLE, { aim: '', cap: 20 })
    expect(control.label).toBe(RUN_LABEL)
    expect(control.actionable).toBe(false)
    expect(control.plan).toBeNull()
    // The hover and the reason are one sentence: a dead button whose tooltip
    // repeated its label would say nothing at all.
    expect(control.title).toBe(control.blockedReason)
  })

  it('carries the whole plan when it can be pressed', () => {
    const control = runControlFor(row(), RUNNABLE, { aim: 'gaps', cap: 20 })
    expect(control.actionable).toBe(true)
    expect(control.plan?.message).toBe('/agent-loop find gaps')
    expect(control.plan?.write).not.toBeNull()
  })
})

describe('the standing hunt a card shows', () => {
  it('is the newest one typed', () => {
    const many = row({
      instructions: [
        instruction({ text: 'older', since: '2026-08-01T00:00:00.000Z' }),
        instruction({ text: 'newest', since: '2026-08-12T00:00:00.000Z' }),
        instruction({ text: 'middle', since: '2026-08-05T00:00:00.000Z' }),
      ],
    })
    expect(standingHuntFor(many)?.text).toBe('newest')
  })

  it('is null when the store said nothing, and when it said nothing yet', () => {
    expect(standingHuntFor(row({ instructions: undefined }))).toBeNull()
    expect(standingHuntFor(row({ instructions: [] }))).toBeNull()
  })
})

describe('what a failed press says', () => {
  it('relays a reason a person can act on', () => {
    expect(runStartError('find', 'the thread could not be created')).toBe(
      'Couldn’t start find — the thread could not be created',
    )
    expect(runWriteError('find', null)).toContain('nothing was started')
  })

  it('drops a reason that is really an invocation', () => {
    // `relayed` refuses a cleaned line still carrying a flag — the shape the CLI
    // produces for a missing argument, which no cleaner can anchor on.
    expect(runStartError('find', 'resume requires --loop <name>')).toBe('Couldn’t start find.')
    expect(runWriteError('find', 'resume requires --loop <name>')).toBe(
      'Couldn’t set what find should look for, so nothing was started.',
    )
  })
})

describe('minting the next run key', () => {
  const keyed = (...keys: Array<string | null>) => keys.map((originKey) => ({ originKey }))

  it('counts archived runs, so archiving the highest never re-mints its number (#1708)', async () => {
    // The visible list stops at TOL-003 because TOL-004's thread was archived.
    // nextRunKey's own contract: a removed thread must not hand its number to
    // the next run — so the mint reads the archived-inclusive list.
    const visible = keyed('TOL-001', 'TOL-002', 'TOL-003')
    const all = [...visible, ...keyed('TOL-004', null)]
    await expect(mintRunKey('orbit-app', async () => all, visible)).resolves.toBe('TOL-005')
  })

  it('falls back to the visible list when the full read fails', async () => {
    // A mint that may reuse an archived number beats a press that starts no
    // run at all.
    const visible = keyed('TOL-001', 'TOL-002')
    const failing = () => Promise.reject(new Error('ipc down'))
    await expect(mintRunKey('orbit-app', failing, visible)).resolves.toBe('TOL-003')
  })
})
