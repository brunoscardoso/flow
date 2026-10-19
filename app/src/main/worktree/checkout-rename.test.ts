import {
  applyCheckoutRenames,
  describeCheckoutRenames,
  planCheckoutRenames,
  type CheckoutRenameDeps,
  type RecordedCheckout,
} from './checkout-rename'

const UUID = 'e2265b48-03e9-43e3-8f76-ff887a48615e'
const OTHER = 'a1b2c3d4-0000-4000-8000-00000000abcd'
const THREADS = '/repos/.orbit-app-threads'

function checkout(over: Partial<RecordedCheckout> = {}): RecordedCheckout {
  return {
    threadId: 't1',
    title: 'Data Contract Guard',
    rootPath: '/repos/orbit-app',
    worktreePath: `${THREADS}/${UUID}`,
    kind: 'primary',
    ...over,
  }
}

describe('planCheckoutRenames — decided without touching a disk', () => {
  it('renames a checkout named after a thread id', () => {
    expect(planCheckoutRenames([checkout()])).toEqual([
      {
        threadId: 't1',
        rootPath: '/repos/orbit-app',
        from: `${THREADS}/${UUID}`,
        to: `${THREADS}/worktree/data-contract-guard`,
        name: 'worktree/data-contract-guard',
      },
    ])
  })

  it('leaves a checkout somebody named alone, however odd the name', () => {
    expect(
      planCheckoutRenames([
        checkout({ worktreePath: `${THREADS}/worktree/parser` }),
        checkout({ worktreePath: `${THREADS}/x` }),
      ]),
    ).toEqual([])
  })

  // THE AFTERNOON'S SHAPE. `worktree-<name>` was the first cut of the folder
  // prefix and became `worktree/<name>` the same day. Checkouts renamed in
  // between are not uuids, so nothing would ever have touched them again — they
  // sat beside the new ones looking almost right (user, 2026-09-18).
  it('nests the flat form, keeping the name somebody already reads', () => {
    const plan = planCheckoutRenames([
      checkout({ title: 'A different title entirely', worktreePath: `${THREADS}/worktree-parser` }),
    ])
    expect(plan).toEqual([
      {
        threadId: 't1',
        rootPath: '/repos/orbit-app',
        from: `${THREADS}/worktree-parser`,
        to: `${THREADS}/worktree/parser`,
        name: 'worktree/parser',
      },
    ])
  })

  it('keeps the flat name EXACTLY — it does not re-derive it from the title', () => {
    // Somebody may have typed it. Re-deriving would rename folders whose names
    // people already know, which is the opposite of what this migration is for.
    const plan = planCheckoutRenames([
      checkout({
        title: 'Something else',
        worktreePath: `${THREADS}/worktree-multi-turn-persistence-tests-failing-sys`,
      }),
    ])
    expect(plan[0]?.name).toBe('worktree/multi-turn-persistence-tests-failing-sys')
  })

  it('does not touch a name that merely begins with the word', () => {
    expect(
      planCheckoutRenames([
        checkout({ worktreePath: `${THREADS}/worktrees-of-mine` }),
        checkout({ threadId: 't2', worktreePath: `${THREADS}/worktree` }),
      ]),
    ).toEqual([])
  })

  it('breaks a collision between the flat form and the nested one already there', () => {
    const plan = planCheckoutRenames([
      checkout({ worktreePath: `${THREADS}/worktree/parser` }),
      checkout({ threadId: 't2', worktreePath: `${THREADS}/worktree-parser` }),
    ])
    expect(plan).toHaveLength(1)
    expect(plan[0]?.name).toBe('worktree/parser-2')
  })

  it('breaks a collision rather than planning two moves to one place', () => {
    // Two conversations with one title is the common case, not an edge.
    const plan = planCheckoutRenames([
      checkout({ threadId: 't1', worktreePath: `${THREADS}/${UUID}` }),
      checkout({ threadId: 't2', worktreePath: `${THREADS}/${OTHER}` }),
    ])
    expect(plan.map((entry) => entry.name)).toEqual([
      'worktree/data-contract-guard',
      'worktree/data-contract-guard-2',
    ])
  })

  it('does not collide with a name that is already taken in that folder', () => {
    const plan = planCheckoutRenames([
      checkout({ worktreePath: `${THREADS}/worktree/data-contract-guard` }),
      checkout({ threadId: 't2', worktreePath: `${THREADS}/${OTHER}` }),
    ])
    expect(plan).toHaveLength(1)
    expect(plan[0]?.name).toBe('worktree/data-contract-guard-2')
  })

  it('counts names per PROJECT, not globally — two repos may use one name', () => {
    const plan = planCheckoutRenames([
      checkout({ worktreePath: `${THREADS}/${UUID}` }),
      checkout({
        threadId: 't2',
        rootPath: '/repos/orbit-core',
        worktreePath: `/repos/.orbit-core-threads/${OTHER}`,
      }),
    ])
    expect(plan.map((entry) => entry.name)).toEqual([
      'worktree/data-contract-guard',
      'worktree/data-contract-guard',
    ])
  })

  it('still names a checkout whose conversation has no usable title', () => {
    const plan = planCheckoutRenames([checkout({ title: '🎉' })])
    expect(plan[0]?.name).toBe('worktree/work')
  })
})

describe('applyCheckoutRenames — a partial migration is a success', () => {
  function deps(over: Partial<CheckoutRenameDeps> = {}) {
    const calls: string[][] = []
    const repointed: Array<[string, string]> = []
    const base: CheckoutRenameDeps = {
      runGit: async (_cwd, args) => {
        calls.push([...args])
        return { ok: true }
      },
      exists: (path) => !path.includes('worktree/'),
      repoint: (from, to) => {
        repointed.push([from, to])
      },
      ensureParent: () => undefined,
      ...over,
    }
    return { deps: base, calls, repointed }
  }

  it('moves through git’s own verb, never mv', async () => {
    const h = deps()
    const plan = planCheckoutRenames([checkout()])
    const results = await applyCheckoutRenames(h.deps, plan, { dryRun: false })
    expect(results.map((result) => result.status)).toEqual(['renamed'])
    // `mv` would leave `.git/worktrees/<id>/gitdir` pointing at the old path,
    // and the repository would simply forget one of its worktrees.
    expect(h.calls).toEqual([
      ['worktree', 'move', `${THREADS}/${UUID}`, `${THREADS}/worktree/data-contract-guard`],
    ])
    expect(h.repointed).toEqual([
      [`${THREADS}/${UUID}`, `${THREADS}/worktree/data-contract-guard`],
    ])
  })

  it('moves NOTHING on a dry run, and says so', async () => {
    const h = deps()
    const results = await applyCheckoutRenames(h.deps, planCheckoutRenames([checkout()]), {
      dryRun: true,
    })
    expect(results.map((result) => result.status)).toEqual(['skipped'])
    // The positive first: this harness DOES move when asked…
    expect(h.calls).toEqual([])
    expect(h.repointed).toEqual([])
  })

  it('leaves a checkout git refuses to move exactly as it was', async () => {
    const h = deps({
      runGit: async () => ({ ok: false, stderr: "fatal: cannot move a locked working tree\n" }),
    })
    const results = await applyCheckoutRenames(h.deps, planCheckoutRenames([checkout()]), {
      dryRun: false,
    })
    expect(results[0]?.status).toBe('refused')
    expect(results[0]?.detail).toContain('locked')
    // AND THE RECORD IS NOT MOVED WITH IT. A repointed record over a directory
    // that did not move is the one outcome worse than not migrating at all.
    expect(h.repointed).toEqual([])
  })

  it('skips a checkout that is not there any more', async () => {
    const h = deps({ exists: () => false })
    const results = await applyCheckoutRenames(h.deps, planCheckoutRenames([checkout()]), {
      dryRun: false,
    })
    expect(results[0]?.status).toBe('skipped')
    expect(h.calls).toEqual([])
  })

  it('refuses to move onto something that is already there', async () => {
    const h = deps({ exists: () => true })
    const results = await applyCheckoutRenames(h.deps, planCheckoutRenames([checkout()]), {
      dryRun: false,
    })
    expect(results[0]?.status).toBe('skipped')
    expect(results[0]?.detail).toContain('already called that')
    expect(h.calls).toEqual([])
  })

  it('records each move as it happens, so a crash leaves them in step', async () => {
    // The window where a directory and its record can disagree is ONE checkout
    // wide, not the whole migration.
    const order: string[] = []
    const h = deps({
      runGit: async (_cwd, args) => {
        order.push(`move ${args[2] ?? ''}`)
        return { ok: true }
      },
      repoint: (from) => {
        order.push(`repoint ${from}`)
      },
    })
    const plan = planCheckoutRenames([
      checkout({ threadId: 't1', worktreePath: `${THREADS}/${UUID}` }),
      checkout({ threadId: 't2', worktreePath: `${THREADS}/${OTHER}` }),
    ])
    await applyCheckoutRenames(h.deps, plan, { dryRun: false })
    expect(order).toEqual([
      `move ${THREADS}/${UUID}`,
      `repoint ${THREADS}/${UUID}`,
      `move ${THREADS}/${OTHER}`,
      `repoint ${THREADS}/${OTHER}`,
    ])
  })
})

describe('describeCheckoutRenames — the half that needs a reader', () => {
  it('names what did NOT move, and why', async () => {
    const results = await applyCheckoutRenames(
      {
        runGit: async () => ({ ok: false, stderr: 'fatal: cannot move a locked working tree' }),
        exists: () => true,
        repoint: () => undefined,
        ensureParent: () => undefined,
      },
      [
        {
          threadId: 't1',
          rootPath: '/repos/orbit-app',
          from: `${THREADS}/${UUID}`,
          to: `${THREADS}/worktree/x`,
          name: 'worktree/x',
        },
      ],
      { dryRun: false },
    )
    const said = describeCheckoutRenames(results)
    expect(said).toContain('0 of 1')
    expect(said).toContain(UUID)
  })

  it('says nothing dramatic when there was nothing to do', () => {
    expect(describeCheckoutRenames([])).toContain('No checkouts needed renaming')
  })
})
