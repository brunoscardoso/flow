// launchpad_set_script — the pure handler against a fake delivery (no renderer).

import { LAUNCHPAD_SCRIPT_MAX_BYTES, launchpadToolHandlers, type LaunchpadToolDeps } from './flow-tools'

function fakes(threadId: string | null = 't1') {
  const delivered: Array<{ threadId: string; action: string; script: string }> = []
  const deps: LaunchpadToolDeps = { threadId, deliver: (proposal) => delivered.push(proposal) }
  return { deps, delivered }
}

const textOf = (r: { content: Array<{ text: string }> }): string => r.content[0]?.text ?? ''

describe('launchpad_set_script', () => {
  it('delivers the script for its own conversation and answers in one sentence', async () => {
    const { deps, delivered } = fakes('t1')
    const res = await launchpadToolHandlers(deps).setScript({ action: ' reset-database ', script: 'set -e\nmake reset\n' })
    expect(res.isError).toBeUndefined()
    expect(delivered).toEqual([{ threadId: 't1', action: 'reset-database', script: 'set -e\nmake reset\n' }])
    expect(textOf(res)).toBe('The script is in the Launchpad editor for reset-database. The person reviews and saves it.')
  })

  it('refuses an empty action name and delivers nothing', async () => {
    const { deps, delivered } = fakes()
    const res = await launchpadToolHandlers(deps).setScript({ action: '  ', script: 'echo hi' })
    expect(res.isError).toBe(true)
    expect(delivered).toEqual([])
  })

  it('refuses an empty script and delivers nothing', async () => {
    const { deps, delivered } = fakes()
    const res = await launchpadToolHandlers(deps).setScript({ action: 'seed', script: ' \n ' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('empty')
    expect(delivered).toEqual([])
  })

  it('refuses a script over the size cap and delivers nothing', async () => {
    const { deps, delivered } = fakes()
    const res = await launchpadToolHandlers(deps).setScript({ action: 'seed', script: 'x'.repeat(LAUNCHPAD_SCRIPT_MAX_BYTES + 1) })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('too long')
    expect(delivered).toEqual([])
  })

  it('accepts a script exactly at the cap', async () => {
    const { deps, delivered } = fakes()
    await launchpadToolHandlers(deps).setScript({ action: 'seed', script: 'x'.repeat(LAUNCHPAD_SCRIPT_MAX_BYTES) })
    expect(delivered).toHaveLength(1)
  })

  it('answers with a sentence and delivers nothing when the conversation is unknown', async () => {
    const { deps, delivered } = fakes(null)
    const res = await launchpadToolHandlers(deps).setScript({ action: 'seed', script: 'echo hi' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('no conversation')
    expect(delivered).toEqual([])
  })

  it('turns a failing delivery into a sentence, never a throw', async () => {
    const deps: LaunchpadToolDeps = {
      threadId: 't1',
      deliver: () => {
        throw new Error('window gone')
      },
    }
    const res = await launchpadToolHandlers(deps).setScript({ action: 'seed', script: 'echo hi' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('window gone')
  })
})
