import { EventEmitter } from 'events'
import type { ChildProcess, spawn } from 'child_process'
import { runReconcile } from './reconcile-runner'
import type { BundledCli } from './derive-runner'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const cli: BundledCli = { execPath: '/electron', cliPath: '/cli.mjs' }

/** Spawn stub that feeds `stdout` then closes, capturing the args it was given. */
function fakeSpawn(stdout: string, captured?: { args?: string[] }): typeof spawn {
  return ((_cmd: string, args: string[]) => {
    const child = new FakeChild()
    if (captured) captured.args = args
    setImmediate(() => {
      if (stdout.length > 0) child.stdout.emit('data', stdout)
      child.emit('close', 0)
    })
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn
}

describe('runReconcile', () => {
  it('parses reconciliation JSON from stdout', async () => {
    const json = JSON.stringify({
      reconciliation: [
        { nodeId: 'module:a', phase: 1, state: 'confirmed' },
        { nodeId: 'module:b', phase: 2, state: 'surprise' },
      ],
      surprises: ['module:b'],
    })
    const result = await runReconcile(cli, '/root', 'my-plan', { spawnFn: fakeSpawn(json) })
    expect(result.available).toBe(true)
    expect(result.nodes).toHaveLength(2)
    expect(result.surprises).toEqual(['module:b'])
  })

  it('passes the plan through as a CLI arg', async () => {
    const captured: { args?: string[] } = {}
    await runReconcile(cli, '/root', 'my-plan', {
      spawnFn: fakeSpawn('{"reconciliation":[],"surprises":[]}', captured),
    })
    expect(captured.args).toEqual(['/cli.mjs', 'blueprint', 'reconcile', '--plan', 'my-plan', '--json'])
  })

  it('is unavailable when the CLI refuses (non-JSON line)', async () => {
    const result = await runReconcile(cli, '/root', 'p', {
      spawnFn: fakeSpawn('reconcile refused: no simulation baseline\n'),
    })
    expect(result.available).toBe(false)
    expect(result.reason).toContain('no simulation baseline')
  })

  it('is unavailable on empty or unparseable output', async () => {
    expect((await runReconcile(cli, '/root', 'p', { spawnFn: fakeSpawn('') })).available).toBe(false)
    expect(
      (await runReconcile(cli, '/root', 'p', { spawnFn: fakeSpawn('{not json') })).available,
    ).toBe(false)
  })

  it('is unavailable when no bundled CLI is present', async () => {
    const result = await runReconcile(null, '/root', 'p')
    expect(result).toEqual({ available: false, reason: 'bundled CLI unavailable', nodes: [], surprises: [] })
  })

  it('drops malformed reconciliation nodes defensively', async () => {
    const json = JSON.stringify({
      reconciliation: [
        { nodeId: 'module:a', phase: 1, state: 'confirmed' },
        { nodeId: 'module:x', phase: 'nope', state: 'confirmed' },
        { nodeId: 'module:y', phase: 2, state: 'bogus' },
      ],
      surprises: [],
    })
    const result = await runReconcile(cli, '/root', 'p', { spawnFn: fakeSpawn(json) })
    expect(result.nodes).toEqual([{ nodeId: 'module:a', phase: 1, state: 'confirmed' }])
  })
})
