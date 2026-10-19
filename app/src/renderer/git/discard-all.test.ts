import {
  discardAllConfirmMessage,
  discardAllSequential,
  discardConfirmMessage,
  discardFailureMessage,
} from './discard-all'

describe('discardAllSequential (#506)', () => {
  it('reverts strictly one at a time (never concurrent — the .git/index.lock race)', async () => {
    let active = 0
    let maxConcurrent = 0
    const revert = async (): Promise<void> => {
      active += 1
      maxConcurrent = Math.max(maxConcurrent, active)
      await new Promise((r) => setTimeout(r, 1))
      active -= 1
    }
    await discardAllSequential(['a', 'b', 'c', 'd'], revert)
    expect(maxConcurrent).toBe(1)
  })

  it('reverts in order', async () => {
    const order: string[] = []
    await discardAllSequential(['x', 'y', 'z'], async (p) => {
      order.push(p)
    })
    expect(order).toEqual(['x', 'y', 'z'])
  })

  it('collects the paths that throw and keeps going', async () => {
    const { failed } = await discardAllSequential(['ok1', 'bad', 'ok2'], async (p) => {
      if (p === 'bad') throw new Error('index.lock')
    })
    expect(failed).toEqual(['bad'])
  })

  it('is a no-op for an empty set', async () => {
    expect(await discardAllSequential([], async () => undefined)).toEqual({ failed: [] })
  })
})

describe('discardConfirmMessage (#1054)', () => {
  it('says DELETE (and that ignored files are kept) for an untracked directory rollup', () => {
    const message = discardConfirmMessage({
      filePath: 'newapp/',
      state: 'untracked',
      worktreeState: 'untracked',
    })
    expect(message).toContain('Delete')
    expect(message).toContain('newapp/')
    expect(message).toContain('.gitignore')
    expect(message).toContain("can't be undone")
  })

  it('says DELETE for a plain untracked file', () => {
    const message = discardConfirmMessage({
      filePath: 'loose.txt',
      state: 'untracked',
      worktreeState: 'untracked',
    })
    expect(message).toBe("Delete untracked file loose.txt? This can't be undone.")
  })

  it('keeps the revert copy for a tracked change', () => {
    const message = discardConfirmMessage({
      filePath: 'a.txt',
      state: 'modified',
      worktreeState: 'modified',
    })
    expect(message).toBe("Discard changes in a.txt? This can't be undone.")
  })
})

describe('discardAllConfirmMessage (#1054)', () => {
  it('keeps the plain copy when nothing untracked is in the set', () => {
    const message = discardAllConfirmMessage([
      { filePath: 'a.txt', state: 'modified', worktreeState: 'modified' },
    ])
    expect(message).toBe("Discard ALL 1 working-tree change(s)? This can't be undone.")
  })

  it('names the deletion blast radius when untracked paths are included', () => {
    const message = discardAllConfirmMessage([
      { filePath: 'a.txt', state: 'modified', worktreeState: 'modified' },
      { filePath: 'newapp/', state: 'untracked', worktreeState: 'untracked' },
      { filePath: 'loose.txt', state: 'untracked', worktreeState: 'untracked' },
    ])
    expect(message).toContain('Discard ALL 3 working-tree change(s)?')
    expect(message).toContain('2 untracked path(s) will be DELETED')
    expect(message).toContain('.gitignore')
  })
})

describe('discardFailureMessage (#506)', () => {
  it('names the failed files (basename), capped at 3 with a +N more', () => {
    expect(discardFailureMessage(['src/a.ts', 'src/b.ts'], 5)).toBe(
      '2 of 5 file(s) failed to revert: a.ts, b.ts. Try again to finish.',
    )
    expect(discardFailureMessage(['a', 'b', 'c', 'd', 'e'], 10)).toBe(
      '5 of 10 file(s) failed to revert: a, b, c +2 more. Try again to finish.',
    )
  })
})

describe('repo-named destructive copy (#1144)', () => {
  const tracked = { filePath: 'README.md', state: 'modified' as const }
  const untracked = { filePath: 'notes.txt', state: 'untracked' as const }

  it('names the repo so two repos never ask the same question', () => {
    // The shape that made this dangerous: the same relative path changed in
    // both repos of an app+core pair.
    const inApp = discardConfirmMessage(tracked, 'app')
    const inCore = discardConfirmMessage(tracked, 'core')
    expect(inApp).toBe("Discard changes in README.md in app? This can't be undone.")
    expect(inApp).not.toBe(inCore)
  })

  it('names the repo on the bulk confirm too', () => {
    expect(discardAllConfirmMessage([tracked, tracked], 'core')).toBe(
      "Discard ALL 2 working-tree change(s) in core? This can't be undone.",
    )
  })

  it('keeps the deletion blast radius when it names the repo', () => {
    const message = discardAllConfirmMessage([tracked, untracked], 'core')
    expect(message).toContain('in core?')
    expect(message).toContain('1 untracked path(s) will be DELETED')
  })

  it('names the repo for untracked files and directories', () => {
    expect(discardConfirmMessage(untracked, 'core')).toContain('notes.txt in core?')
    expect(discardConfirmMessage({ filePath: 'build/', state: 'untracked' }, 'core')).toContain(
      'build/ in core?',
    )
  })

  it('leaves the single-repo copy byte-identical', () => {
    // No name (single-root panel) → exactly the pre-#1144 strings.
    expect(discardConfirmMessage(tracked)).toBe("Discard changes in README.md? This can't be undone.")
    expect(discardConfirmMessage(tracked, null)).toBe(
      "Discard changes in README.md? This can't be undone.",
    )
    expect(discardConfirmMessage(tracked, '  ')).toBe(
      "Discard changes in README.md? This can't be undone.",
    )
    expect(discardAllConfirmMessage([tracked])).toBe(
      "Discard ALL 1 working-tree change(s)? This can't be undone.",
    )
  })
})
