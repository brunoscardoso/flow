import {
  THREAD_WORKTREES_KEY,
  readThreadWorktreesEnabled,
  threadWorktreesEnabledIn,
} from './thread-worktree-config'

describe('threadWorktreesEnabledIn', () => {
  it('is on for a project that has never heard of the key', () => {
    expect(threadWorktreesEnabledIn({})).toBe(true)
  })

  it('is off only for the literal false', () => {
    expect(threadWorktreesEnabledIn({ [THREAD_WORKTREES_KEY]: 'false' })).toBe(false)
    expect(threadWorktreesEnabledIn({ [THREAD_WORKTREES_KEY]: 'true' })).toBe(true)
    // A value nobody meant as "off" must not read as off — the failure mode of
    // guessing is a feature that silently stops for a project that never asked.
    expect(threadWorktreesEnabledIn({ [THREAD_WORKTREES_KEY]: 'no' })).toBe(true)
    expect(threadWorktreesEnabledIn({ [THREAD_WORKTREES_KEY]: '' })).toBe(true)
    expect(threadWorktreesEnabledIn({ [THREAD_WORKTREES_KEY]: 'FALSE' })).toBe(true)
  })

  it('ignores every other key', () => {
    expect(threadWorktreesEnabledIn({ learn_auto: 'false', autopilot: 'true' })).toBe(true)
  })
})

describe('readThreadWorktreesEnabled', () => {
  it('reads flow/.flowconfig under the project root', async () => {
    const seen: string[] = []
    const enabled = await readThreadWorktreesEnabled('/repo', {
      readFile: async (path) => {
        seen.push(path)
        return 'autopilot: true\nthread_worktrees: false\n'
      },
    })
    expect(enabled).toBe(false)
    expect(seen).toEqual(['/repo/flow/.flowconfig'])
  })

  it('is on when the key is absent', async () => {
    await expect(
      readThreadWorktreesEnabled('/repo', { readFile: async () => 'autopilot: true\n' }),
    ).resolves.toBe(true)
  })

  it('is on when the config cannot be read at all', async () => {
    await expect(
      readThreadWorktreesEnabled('/repo', {
        readFile: async () => {
          throw new Error('ENOENT')
        },
      }),
    ).resolves.toBe(true)
  })
})
