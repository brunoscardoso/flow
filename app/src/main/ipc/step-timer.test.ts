import { StepTimer } from './step-timer'

describe('StepTimer', () => {
  it('names each step with its own duration, in the order they started', async () => {
    let now = 0
    const timer = new StepTimer('worktree cut', () => now)
    await timer.step('refresh', async () => {
      now += 1200
    })
    await timer.step('cli-create', async () => {
      now += 900
    })
    expect(timer.line()).toBe('[worktree cut] 2100ms — refresh 1200ms, cli-create 900ms')
  })

  it('writes only when the whole is slow, and passes a step\u2019s throw through', async () => {
    let now = 0
    const lines: string[] = []
    const timer = new StepTimer('send turn', () => now)
    await expect(
      timer.step('session', async () => {
        now += 100
        throw new Error('spawn failed')
      }),
    ).rejects.toThrow('spawn failed')
    // The positive half first: a slow total IS written (allowed-pattern #28).
    now = 300
    expect(timer.recordIfSlow((line) => lines.push(line), 250)).toBe(true)
    expect(lines).toEqual(['[send turn] 300ms — session 100ms'])
    const fast = new StepTimer('fast', () => 0)
    expect(fast.recordIfSlow((line) => lines.push(line), 250)).toBe(false)
    expect(lines).toHaveLength(1)
  })

  it('says which step had not finished when the line was written', () => {
    const timer = new StepTimer('cut', () => 0)
    void timer.step('fetch', () => new Promise(() => undefined))
    expect(timer.line()).toBe('[cut] 0ms — fetch (unfinished)')
  })
})
