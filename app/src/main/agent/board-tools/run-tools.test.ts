// run_output / run_reload — the pure handlers against fakes (no processes).

import type { RunStepState } from '../../../shared/run-setup'
import { boundRunOutput, RUN_OUTPUT_MAX_BYTES, RUN_OUTPUT_MAX_LINES, runToolHandlers, type RunToolDeps } from './flow-tools'

function step(over: Partial<RunStepState>): RunStepState {
  return { key: '/p::web', name: 'web', projectRoot: '/p', status: 'running', terminalId: 't1', exitCode: null, detail: null, ...over }
}

function fakes(steps: RunStepState[], outputs: Record<string, string | null> = {}) {
  const reloads: string[] = []
  const deps: RunToolDeps = {
    steps: () => steps,
    output: (id) => outputs[id] ?? null,
    reload: async (key) => {
      reloads.push(key)
    },
  }
  return { deps, reloads }
}

const textOf = (r: { content: Array<{ text: string }> }): string => r.content[0]?.text ?? ''

describe('run tools', () => {
  it('says so in a sentence when no Run is going, and reloads nothing', async () => {
    const { deps, reloads } = fakes([])
    const h = runToolHandlers(deps)
    expect(textOf(await h.runOutput({}))).toContain('No Run is going')
    expect(textOf(await h.runReload({ step: 'web' }))).toContain('No Run is going')
    expect(reloads).toEqual([])
  })

  it('lists the steps and their states when no name is given', async () => {
    const { deps } = fakes([step({}), step({ key: '/p::api', name: 'api', status: 'waiting', detail: 'waiting for port 5432', terminalId: null })])
    const out = textOf(await runToolHandlers(deps).runOutput({}))
    expect(out).toContain('web: running')
    expect(out).toContain('api: waiting (waiting for port 5432)')
  })

  it('returns a named step output, ANSI stripped', async () => {
    const { deps } = fakes([step({})], { t1: '\u001b[31mError:\u001b[0m boom\r\nline2\n' })
    const res = await runToolHandlers(deps).runOutput({ step: 'WEB' })
    expect(textOf(res)).toContain('Error: boom\nline2')
    expect(textOf(res)).not.toContain('\u001b')
    expect(res.isError).toBeUndefined()
  })

  it('names the steps for an unknown step and does not reload', async () => {
    const { deps, reloads } = fakes([step({})])
    const res = await runToolHandlers(deps).runReload({ step: 'nope' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('The steps are: web')
    expect(reloads).toEqual([])
  })

  it('reloads one step by name through the dependency', async () => {
    const { deps, reloads } = fakes([step({}), step({ key: '/p::api', name: 'api' })])
    const res = await runToolHandlers(deps).runReload({ step: 'api' })
    expect(reloads).toEqual(['/p::api'])
    expect(textOf(res)).toContain('Reloading "api"')
  })

  it('refuses an ambiguous name', async () => {
    const { deps, reloads } = fakes([step({}), step({ key: '/q::web', projectRoot: '/q' })])
    const res = await runToolHandlers(deps).runReload({ step: 'web' })
    expect(res.isError).toBe(true)
    expect(reloads).toEqual([])
  })

  it('fails soft when the reload throws', async () => {
    const deps: RunToolDeps = { steps: () => [step({})], output: () => null, reload: async () => { throw new Error('gone') } }
    const res = await runToolHandlers(deps).runReload({ step: 'web' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('gone')
  })

  it('bounds output to the last lines and bytes', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const lines = boundRunOutput(many).split('\n')
    expect(lines).toHaveLength(RUN_OUTPUT_MAX_LINES)
    expect(lines[lines.length - 1]).toBe('line 999')
    const wide = boundRunOutput(Array.from({ length: 100 }, () => 'x'.repeat(1000)).join('\n'))
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES)
  })
})
