import type { LearnProgress, LearnModuleRow } from './learn-progress-model'
import { folderOf, groupOpenByDefault, moduleGroups, projectLearnRows, remainingModules, workspaceLearnLine, type ProjectLearnInput } from './learn-projects-model'

function progress(rows: Array<[string, LearnModuleRow['status'], string?]>): LearnProgress {
  const list = rows.map(([module, status, notedAt]) => ({ module, status, ...(notedAt === undefined ? {} : { notedAt }) }))
  const counted = list.filter((row) => row.status !== 'ignored')
  const learned = counted.filter((row) => row.status === 'learned').length
  return {
    total: counted.length,
    learned,
    learning: counted.filter((row) => row.status === 'learning').length,
    queued: counted.filter((row) => row.status === 'queued').length,
    stale: counted.filter((row) => row.status === 'stale').length,
    percent: counted.length === 0 ? 0 : (learned / counted.length) * 100,
    percentLabel: '',
    rows: list,
  } as LearnProgress
}

const app: ProjectLearnInput = {
  slug: 'orbit-app',
  name: 'orbit-app',
  root: '/code/app',
  slot: 1,
  here: true,
  features: { done: 3, total: 24 },
  progress: progress([
    ['src/app', 'learned', '2026-10-06T10:00:00Z'],
    ['src/app/addins/auth', 'none'],
    ['src/app/addins/start', 'none'],
    ['src/components/chat', 'none'],
    ['office-addin', 'none'],
    ['src/datasources', 'stale'],
    ['src/lib/x', 'learning'],
    ['src/lib/y', 'queued'],
    ['src/vendor', 'ignored'],
  ]),
}
const core: ProjectLearnInput = { slug: 'orbit-core', name: 'orbit-core', root: '/code/core', slot: 2, here: false, features: null, progress: progress([['core', 'learned'], ['web', 'learned']]) }
const remote: ProjectLearnInput = { slug: 'mobile', name: 'storefront-mobile', root: null, slot: 4, here: false, features: null, progress: null }

describe('learning per project — the rows', () => {
  it('says what each project is doing, from the one live answer', () => {
    const rows = projectLearnRows([app, core, remote], {
      running: true,
      paused: false,
      activeRoot: '/code/app',
      activeModule: 'src/lib/x',
      queuedByRoot: { '/code/app': 12 },
    })
    expect(rows[0]).toMatchObject({ state: 'learning', stateText: 'Learning src/lib/x · 12 queued', pauseAction: 'pause', learnLabel: null })
    expect(rows[0]?.countsText).toBe('1 / 8 modules · 3 of 24 features')
    expect(rows[1]).toMatchObject({ state: 'done', stateText: 'Learned', learnLabel: null, pauseAction: null })
    expect(rows[2]).toMatchObject({ state: 'remote', stateText: 'Not on this computer', learnLabel: null })
  })

  it('a project paused on its own says so and offers Resume; one not running offers Learn N', () => {
    const paused = projectLearnRows([app], { running: false, paused: false, activeModule: null, queuedByRoot: { '/code/app': 3 }, pausedRoots: ['/code/app'] })
    expect(paused[0]).toMatchObject({ state: 'paused', stateText: 'Paused · 3 queued', pauseAction: 'resume' })
    const idle = projectLearnRows([app], { running: false, paused: false, activeModule: null })
    expect(idle[0]).toMatchObject({ state: 'idle', learnLabel: 'Learn 5', pauseAction: null })
    // Only drifted modules left → the action says Update.
    const drifted = projectLearnRows([{ ...core, progress: progress([['core', 'learned'], ['web', 'stale']]) }], { running: false, paused: false, activeModule: null })
    expect(drifted[0]?.learnLabel).toBe('Update 1')
  })

  it('remaining work is shallow first — the trunk before the leaves', () => {
    expect(remainingModules(app.progress as LearnProgress)).toEqual(['office-addin', 'src/datasources', 'src/components/chat', 'src/app/addins/auth', 'src/app/addins/start'])
  })

  it('the top line names the project being learned and the Workspace total', () => {
    const rows = projectLearnRows([app, core], { running: true, paused: false, activeRoot: '/code/app', activeModule: 'x' })
    expect(workspaceLearnLine(rows, { running: true, paused: false, activeModule: 'x' })).toMatchObject({ headline: 'Learning orbit-app', facts: '3 of 10 modules · 30%' })
    expect(workspaceLearnLine(rows, { running: false, paused: true, activeModule: null }).headline).toBe('Learning is paused')
  })
})

describe('learning per project — inside a project', () => {
  it('groups modules: learning now, drifted, not learned by folder, learned — ignored left out', () => {
    const groups = moduleGroups(app.progress as LearnProgress)
    expect(groups.map((group) => [group.key, group.count])).toEqual([['now', 2], ['drift', 1], ['todo', 4], ['done', 1]])
    expect(groups[0]?.rows.map((row) => row.module)).toEqual(['src/lib/x', 'src/lib/y'])
    expect(groups[2]?.folders).toEqual([
      { folder: 'src/app', modules: ['src/app/addins/auth', 'src/app/addins/start'] },
      { folder: 'office-addin', modules: ['office-addin'] },
      { folder: 'src/components', modules: ['src/components/chat'] },
    ])
    expect(groupOpenByDefault('done')).toBe(false)
    expect(groupOpenByDefault('todo')).toBe(true)
  })

  it('lists a module the person ignored in its own folded Ignored group, last — a built-in ignore stays out (#1450)', () => {
    const progress = {
      ...(app.progress as LearnProgress),
      rows: [
        { module: 'src', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
        { module: 'vendor', status: 'ignored' },
        { module: '__mocks__', status: 'ignored' },
      ],
    } as LearnProgress
    // Without knowing whose ignore it is, nothing ignored is listed.
    expect(moduleGroups(progress).map((group) => group.key)).toEqual(['done'])
    const groups = moduleGroups(progress, '', (module) => module === 'vendor')
    expect(groups.map((group) => [group.key, group.count])).toEqual([['done', 1], ['ignored', 1]])
    expect(groups[1]?.rows.map((row) => row.module)).toEqual(['vendor'])
    expect(groups[1]?.title).toBe('Ignored')
    expect(groupOpenByDefault('ignored')).toBe(false)
  })

  it('filters by path, and a group with nothing left is not drawn', () => {
    const groups = moduleGroups(app.progress as LearnProgress, 'ADDINS')
    expect(groups.map((group) => group.key)).toEqual(['todo'])
  })

  it('a folder is the first two segments of a deep module, or the module itself', () => {
    expect(folderOf('src/app/addins/auth-start')).toBe('src/app')
    expect(folderOf('src/app')).toBe('src/app')
    expect(folderOf('office-addin')).toBe('office-addin')
  })
})
