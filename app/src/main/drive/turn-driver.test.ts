// TurnDriver — the shared advance shape, and the registry that stops two
// drivers running one conversation.
//
// The policy each driver uses lives in its own pure module and is tested there.
// What is proven here is the machinery both share, and above all the STOP:
// a run that is switched off issues nothing more, and does not touch the turn
// already in flight.

import { ThreadClaims, TurnDriver, ALREADY_DRIVEN, MADE_NO_PROGRESS } from './turn-driver'

interface Sent {
  key: string
  work: string
}

function harness(
  script: Array<{ kind: 'work'; work: string } | { kind: 'wait'; reason: string } | { kind: 'stop'; reason: string }>,
  options: { claims?: ThreadClaims; name?: string; threadFor?: (work: string) => string | null } = {},
) {
  const sent: Sent[] = []
  const announced: Array<{ key: string; running: boolean; detail: string | null }> = []
  let step = 0
  const driver = new TurnDriver<string>({
    name: options.name ?? 'test-driver',
    claims: options.claims,
    decide: () => script[Math.min(step++, script.length - 1)] ?? { kind: 'wait', reason: 'end' },
    dispatch: async (key, work) => {
      sent.push({ key, work })
      const threadId = (options.threadFor ?? ((w: string) => `th-${w}`))(work)
      return threadId === null ? null : { threadId, detail: work }
    },
    onChange: (key, status) =>
      announced.push({ key, running: status.running, detail: status.detail }),
  })
  return { driver, sent, announced }
}

describe('TurnDriver: advancing', () => {
  it('issues the first step on start and the next one when that turn ends', async () => {
    const { driver, sent } = harness([
      { kind: 'work', work: 'a' },
      { kind: 'work', work: 'b' },
      { kind: 'stop', reason: 'done' },
    ])
    await driver.start('run')
    expect(sent).toEqual([{ key: 'run', work: 'a' }])
    driver.onTurnComplete('th-a', true)
    await Promise.resolve()
    expect(sent.map((entry) => entry.work)).toEqual(['a', 'b'])
  })

  it('a `wait` holds without stopping — the run is still alive', async () => {
    const { driver, sent } = harness([{ kind: 'wait', reason: 'somebody is being asked' }])
    await driver.start('run')
    expect(sent).toEqual([])
    expect(driver.status('run').running).toBe(true)
    expect(driver.status('run').stoppedReason).toBeNull()
  })

  it('a dispatch that throws stops the run and says why — it never advances past it', async () => {
    const sent: string[] = []
    const driver = new TurnDriver<string>({
      name: 'throws',
      decide: () => ({ kind: 'work', work: 'a' }),
      dispatch: async () => {
        sent.push('tried')
        throw new Error('Could not open a chat.')
      },
      onChange: () => {},
    })
    await driver.start('run')
    expect(sent).toEqual(['tried'])
    expect(driver.status('run')).toMatchObject({
      running: false,
      stoppedReason: 'Could not open a chat.',
    })
  })

  it('a dispatch that started no turn pumps straight on', async () => {
    const { driver, sent } = harness(
      [
        { kind: 'work', work: 'tail' },
        { kind: 'stop', reason: 'finished' },
      ],
      { threadFor: () => null },
    )
    await driver.start('run')
    expect(sent.map((entry) => entry.work)).toEqual(['tail'])
    expect(driver.status('run')).toMatchObject({ running: false, stoppedReason: 'finished' })
  })

  it('caps a model that never starts a turn rather than spinning', async () => {
    const { driver, sent } = harness([{ kind: 'work', work: 'nothing' }], { threadFor: () => null })
    await driver.start('run')
    expect(sent.length).toBeLessThan(20)
    expect(driver.status('run').stoppedReason).toBe(MADE_NO_PROGRESS)
  })
})

describe('TurnDriver: stopping', () => {
  it('stopping issues nothing more and leaves the turn in flight alone', async () => {
    const { driver, sent } = harness([
      { kind: 'work', work: 'a' },
      { kind: 'work', work: 'b' },
    ])
    await driver.start('run')
    driver.stop('run', 'Stopped.')
    // The turn that was already running still ends — and nothing follows it.
    driver.onTurnComplete('th-a', true)
    await Promise.resolve()
    expect(sent.map((entry) => entry.work)).toEqual(['a'])
    expect(driver.status('run')).toMatchObject({ running: false, stoppedReason: 'Stopped.' })
  })

  it('stopping with no reason reports none — a person’s own gesture explains itself', async () => {
    const { driver } = harness([{ kind: 'work', work: 'a' }])
    await driver.start('run')
    driver.stop('run')
    expect(driver.status('run')).toMatchObject({ running: false, stoppedReason: null })
  })

  it('stopping a run that is not running changes nothing', () => {
    const { driver, announced } = harness([{ kind: 'work', work: 'a' }])
    expect(driver.stop('run', 'x')).toMatchObject({ running: false })
    expect(announced).toEqual([])
  })

  it('releases the conversation, so something else may take it afterwards', async () => {
    const claims = new ThreadClaims()
    const { driver } = harness([{ kind: 'work', work: 'a' }], { claims })
    await driver.start('run')
    expect(claims.ownerOf('th-a')).toMatchObject({ driver: 'test-driver', key: 'run' })
    driver.stop('run')
    expect(claims.ownerOf('th-a')).toBeNull()
  })
})

describe('ThreadClaims: one conversation, one driver', () => {
  it('refuses a second driver and stops it rather than talking over the first', async () => {
    const claims = new ThreadClaims()
    const first = harness([{ kind: 'work', work: 'a' }], { claims, name: 'board-loop' })
    await first.driver.start('run')

    const second = harness([{ kind: 'work', work: 'a' }], { claims, name: 'autopilot-chain' })
    await second.driver.start('chain')
    expect(second.driver.status('chain')).toMatchObject({
      running: false,
      stoppedReason: ALREADY_DRIVEN,
    })
  })

  it('a finished turn advances only the driver that claimed it', async () => {
    const claims = new ThreadClaims()
    const owner = harness(
      [
        { kind: 'work', work: 'a' },
        { kind: 'work', work: 'b' },
      ],
      { claims, name: 'owner' },
    )
    await owner.driver.start('run')
    const bystander = harness([{ kind: 'work', work: 'x' }], { claims, name: 'bystander' })
    // The bystander has a live run on a DIFFERENT conversation.
    await bystander.driver.start('other')
    bystander.sent.length = 0

    owner.driver.onTurnComplete('th-a', true)
    await Promise.resolve()
    expect(owner.sent.map((entry) => entry.work)).toEqual(['a', 'b'])
    expect(bystander.sent).toEqual([])
  })

  it('the same run may re-claim the conversation it already holds', () => {
    const claims = new ThreadClaims()
    expect(claims.claim('th', { driver: 'd', key: 'k' })).toBe(true)
    expect(claims.claim('th', { driver: 'd', key: 'k' })).toBe(true)
    expect(claims.claim('th', { driver: 'd', key: 'other' })).toBe(false)
  })

  it('a release by anyone but the owner does nothing', () => {
    const claims = new ThreadClaims()
    claims.claim('th', { driver: 'd', key: 'k' })
    claims.release('th', { driver: 'other', key: 'k' })
    expect(claims.ownerOf('th')).toMatchObject({ driver: 'd' })
  })
})
