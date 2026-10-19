import type { TabSet } from '../shared/ipc-contract'
import { planTabSwitch, sameScope, scopeForProject, scopeForThreadSignal } from './tab-scope-model'

const P1 = '/repo/one'
const P2 = '/repo/two'

const outgoing: TabSet = {
  openFiles: [{ rootPath: P1, relPath: 'a.ts', active: true }],
  activeFile: 'a.ts',
  dirtyBuffers: { [`${P1}/a.ts`]: 'typed, not saved' },
  openViews: [{ kind: 'feature-view', state: { slug: 'pay' } }],
}

describe('sameScope', () => {
  it('compares project and conversation', () => {
    expect(sameScope({ rootPath: P1, threadId: 't1' }, { rootPath: P1, threadId: 't1' })).toBe(true)
    expect(sameScope({ rootPath: P1, threadId: 't1' }, { rootPath: P1, threadId: 't2' })).toBe(false)
    expect(sameScope({ rootPath: P1, threadId: null }, { rootPath: P2, threadId: null })).toBe(false)
    expect(sameScope({ rootPath: P1, threadId: null }, { rootPath: P1, threadId: 't1' })).toBe(false)
    expect(sameScope(null, null)).toBe(true)
    expect(sameScope(null, { rootPath: P1, threadId: null })).toBe(false)
  })
})

describe('scopeForProject', () => {
  it('names the project on its last-active conversation', () => {
    expect(scopeForProject({ rootPath: P1, activeThreadId: 't1' })).toEqual({ rootPath: P1, threadId: 't1' })
    expect(scopeForProject({ rootPath: P1, activeThreadId: null })).toEqual({ rootPath: P1, threadId: null })
    expect(scopeForProject(null)).toBeNull()
  })
})

describe('scopeForThreadSignal', () => {
  it('a conversation in the current project is that conversation’s set', () => {
    expect(scopeForThreadSignal({ threadId: 't2', projectRoot: P1 }, P1)).toEqual({ rootPath: P1, threadId: 't2' })
  })

  it('a cleared selection is the current project’s own set', () => {
    expect(scopeForThreadSignal({ threadId: null, projectRoot: null }, P1)).toEqual({ rootPath: P1, threadId: null })
    expect(scopeForThreadSignal({ threadId: null }, P1)).toEqual({ rootPath: P1, threadId: null })
  })

  it('leaves a conversation in another project to that project’s activation', () => {
    // Positive first (allowed-pattern #28): the same signal acts in its own project.
    expect(scopeForThreadSignal({ threadId: 't9', projectRoot: P2 }, P2)).not.toBeNull()
    expect(scopeForThreadSignal({ threadId: 't9', projectRoot: P2 }, P1)).toBeNull()
  })

  it('does nothing before any project is active', () => {
    expect(scopeForThreadSignal({ threadId: 't1', projectRoot: P1 }, null)).toBeNull()
  })
})

describe('planTabSwitch', () => {
  it('does nothing when the set asked for is the one on screen', () => {
    expect(planTabSwitch({ rootPath: P1, threadId: 't1' }, { rootPath: P1, threadId: 't1' }, outgoing)).toEqual({
      kind: 'none',
    })
  })

  it('saves the outgoing conversation’s set — unsaved buffers and views included — before loading the next', () => {
    const plan = planTabSwitch({ rootPath: P1, threadId: 't1' }, { rootPath: P1, threadId: 't2' }, outgoing)
    expect(plan).toEqual({
      kind: 'switch',
      save: { scope: { rootPath: P1, threadId: 't1' }, set: outgoing },
      load: { rootPath: P1, threadId: 't2' },
      projectChanges: false,
    })
  })

  it('switching to no conversation loads the project-level set of the same project', () => {
    const plan = planTabSwitch({ rootPath: P1, threadId: 't1' }, { rootPath: P1, threadId: null }, outgoing)
    expect(plan.kind === 'switch' && plan.load).toEqual({ rootPath: P1, threadId: null })
    expect(plan.kind === 'switch' && plan.projectChanges).toBe(false)
  })

  it('a project switch says so, so the tree and terminals rebind too', () => {
    const plan = planTabSwitch({ rootPath: P1, threadId: 't1' }, { rootPath: P2, threadId: 't9' }, outgoing)
    expect(plan.kind === 'switch' && plan.projectChanges).toBe(true)
  })

  it('saves nothing when nothing was on screen (boot)', () => {
    const plan = planTabSwitch(null, { rootPath: P1, threadId: 't1' }, outgoing)
    expect(plan).toEqual({ kind: 'switch', save: null, load: { rootPath: P1, threadId: 't1' }, projectChanges: true })
  })

  it('no project at all still saves what was showing', () => {
    const plan = planTabSwitch({ rootPath: P1, threadId: null }, null, outgoing)
    expect(plan).toEqual({
      kind: 'switch',
      save: { scope: { rootPath: P1, threadId: null }, set: outgoing },
      load: null,
      projectChanges: true,
    })
  })
})
