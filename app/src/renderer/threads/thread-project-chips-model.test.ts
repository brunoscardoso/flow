import type { WorkspaceListing } from '../../shared/workspaces-contract'
import {
  ADD_PROJECT_LABEL,
  NOTHING_TO_ADD,
  addableProjects,
  chipsVisible,
  offerChip,
  rootsAfterAdd,
  rootsAfterRemove,
  skipGateOnSend,
  threadProjectChips,
} from './thread-project-chips-model'

const name = (root: string): string => root.split('/').pop() ?? root

const WORKSPACE: WorkspaceListing = {
  name: 'Acme',
  slug: 'acme',
  path: '/flow/workspaces/acme',
  remote: null,
  isDefault: false,
  projects: [
    { id: 'a', name: 'Backend', slug: 'backend', remotes: [], description: null, localPath: '/code/backend', flowPath: '/f/a' },
    { id: 'b', name: 'Frontend', slug: 'frontend', remotes: [], description: null, localPath: '/private/var/frontend', flowPath: '/f/b' },
    { id: 'c', name: 'Docs', slug: 'docs', remotes: [], description: null, localPath: null, flowPath: '/f/c' },
    { id: 'd', name: 'Mobile', slug: 'mobile', remotes: [], description: null, localPath: '/code/mobile', flowPath: '/f/d' },
  ],
}

describe('threadProjectChips', () => {
  it('puts the thread’s own project first and never lets it be removed', () => {
    const chips = threadProjectChips({
      thread: { projectRoot: '/code/backend', additionalRoots: ['/var/frontend', '/code/mobile', '/code/backend'] },
      gateAdded: new Set(['/private/var/frontend']),
      name,
    })
    expect(chips.map((chip) => [chip.name, chip.source, chip.removable])).toEqual([
      ['backend', 'primary', false],
      ['frontend', 'gate', true],
      ['mobile', 'manual', true],
    ])
    expect(chips[1].title).toContain('added from your first message')
  })

  it('marks a project still being learned "Learning…", one that could not be learned "Couldn\'t learn", and only those', () => {
    const status = (root: string) =>
      ({ '/code/backend': 'done', '/var/frontend': 'running', '/code/mobile': 'failed', '/code/docs': 'not-required' } as const)[root] ?? null
    const chips = threadProjectChips({
      thread: { projectRoot: '/code/backend', additionalRoots: ['/var/frontend', '/code/mobile', '/code/docs'] },
      gateAdded: new Set(),
      name,
      status,
    })
    expect(chips.map((chip) => [chip.name, chip.learning])).toEqual([
      ['backend', null],
      ['frontend', 'Learning…'],
      // A failed sweep is not still learning: the chip says so (live: "Learning…" for good).
      ['mobile', "Couldn't learn"],
      ['docs', null],
    ])
    expect(chips[1].title).toBe('frontend — Flow is learning this project first. It joins the conversation with your next message after that.')
    expect(chips[2].title).toContain("couldn't learn this project yet")
    expect(chips[3].title).toContain('remove it')
  })
})

describe('the + menu', () => {
  it('offers the Workspace projects open in Flow that are not in yet — under the app’s own root', () => {
    const addable = addableProjects({
      workspace: WORKSPACE,
      thread: { projectRoot: '/code/backend', additionalRoots: ['/var/frontend'] },
      registeredRoot: (project) => (project.id === 'd' ? '/Users/me/mobile' : project.id === 'b' ? '/var/frontend' : null),
    })
    expect(addable).toEqual([{ root: '/Users/me/mobile', name: 'Mobile' }])
  })

  it('never offers a checkout Flow does not have open — attaching it would be refused', () => {
    const addable = addableProjects({
      workspace: WORKSPACE,
      thread: { projectRoot: '/code/backend', additionalRoots: [] },
      registeredRoot: (project) => (project.id === 'd' ? '/code/mobile' : null),
    })
    // Positive first: the open one IS offered…
    expect(addable.map((entry) => entry.name)).toEqual(['Mobile'])
    // …and Frontend, checked out here but not open in Flow, is not.
    expect(addable.map((entry) => entry.name)).not.toContain('Frontend')
  })

  it('offers nothing outside a Workspace', () => {
    expect(addableProjects({ workspace: null, thread: { projectRoot: '/x', additionalRoots: [] }, registeredRoot: () => null })).toEqual([])
  })
})

describe('changing the set', () => {
  const thread = { projectRoot: '/code/backend', additionalRoots: ['/code/mobile'] }
  it('adds once and never adds the primary', () => {
    expect(rootsAfterAdd(thread, '/var/frontend')).toEqual(['/code/mobile', '/var/frontend'])
    expect(rootsAfterAdd(thread, '/code/mobile')).toEqual(['/code/mobile'])
    expect(rootsAfterAdd(thread, '/code/backend')).toEqual(['/code/mobile'])
  })
  it('removes under either spelling of the path', () => {
    expect(rootsAfterRemove({ projectRoot: '/a', additionalRoots: ['/var/f', '/b'] }, '/private/var/f')).toEqual(['/b'])
  })
  it('never mutates the thread', () => {
    rootsAfterAdd(thread, '/z')
    expect(thread.additionalRoots).toEqual(['/code/mobile'])
  })
})

describe('offerChip', () => {
  const offer = { threadId: 't1', project: { root: '/code/mobile', name: 'Mobile' }, reason: 'The message asks about the app screens.' }
  it('asks in plain words, with the reason', () => {
    expect(offerChip(offer, 't1', { projectRoot: '/code/backend', additionalRoots: [] })).toEqual({
      root: '/code/mobile',
      label: 'Add Mobile?',
      reason: 'The message asks about the app screens.',
      acceptLabel: 'Add Mobile to this conversation',
      dismissLabel: 'Not now',
    })
  })
  it('shows nothing for another thread, no offer, or a project already in', () => {
    expect(offerChip(offer, 't2', { projectRoot: '/code/backend', additionalRoots: [] })).toBeNull()
    expect(offerChip(null, 't1', { projectRoot: '/code/backend', additionalRoots: [] })).toBeNull()
    expect(offerChip(offer, 't1', { projectRoot: '/code/backend', additionalRoots: ['/code/mobile'] })).toBeNull()
  })
})

describe('visibility and the hand-pick', () => {
  it('shows only for a thread in a Workspace', () => {
    expect(chipsVisible({ inWorkspace: true, hasThread: true })).toBe(true)
    expect(chipsVisible({ inWorkspace: false, hasThread: true })).toBe(false)
    expect(chipsVisible({ inWorkspace: true, hasThread: false })).toBe(false)
  })
  it('skips the gate only for a hand-pick before the first turn', () => {
    // The positive first: a hand-pick on a fresh thread does skip.
    expect(skipGateOnSend({ handPicked: true, hasStarted: false })).toBe(true)
    expect(skipGateOnSend({ handPicked: true, hasStarted: true })).toBe(false)
    expect(skipGateOnSend({ handPicked: false, hasStarted: false })).toBe(false)
  })
  it('says what it does without internals', () => {
    for (const text of [ADD_PROJECT_LABEL, NOTHING_TO_ADD]) {
      expect(text).not.toMatch(/planflow-ai|\/|worktree|\p{Extended_Pictographic}/u)
    }
  })
})
