import type { LearnProgress, LearnModuleRow } from './learn-progress-model'
import {
  distinctFiles,
  driftBatchView,
  driftFolders,
  driftReason,
  driftSummary,
  estimateMinutes,
  folderOf,
  groupOpenByDefault,
  moduleGroups,
  passDurations,
  projectLearnRows,
  pruneSelection,
  remainingModules,
  selectionLine,
  selectionState,
  sortDriftRows,
  toggleSelection,
  workspaceLearnLine,
  type ProjectLearnInput,
} from './learn-projects-model'

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

describe('the Drifted group', () => {
  const drifted = progress([
    ['src/components/chat', 'stale', '2026-10-29T10:00:00Z'],
    ['src/components/chat/MessageList', 'stale', '2026-10-29T11:00:00Z'],
    ['src/components/settings', 'stale', '2026-10-24T10:00:00Z'],
    ['src/lib/http', 'stale'],
    ['src/app', 'learned', '2026-10-06T10:00:00Z'],
  ]).rows.filter((row) => row.status === 'stale')
  const files = {
    'src/components/chat': ['a.ts', 'b.ts', 'c.ts', 'm.ts'],
    'src/components/chat/MessageList': ['m.ts'],
    'src/lib/http': ['h1.ts', 'h2.ts'],
  }

  it('says why a row drifted only when the count is known', () => {
    expect(driftReason(24)).toBe('24 files changed')
    expect(driftReason(1)).toBe('1 file changed')
    expect(driftReason(null)).toBeNull()
    expect(driftReason(0)).toBeNull()
  })

  it('counts distinct files, so a parent and its child are not counted twice', () => {
    expect(distinctFiles(files, ['src/components/chat', 'src/components/chat/MessageList'])).toBe(4)
    expect(distinctFiles(files, ['src/components/settings'])).toBeNull()
    expect(distinctFiles(null, ['src/lib/http'])).toBeNull()
  })

  it('summarises the group, leaving the file count out when unknown', () => {
    expect(driftSummary(drifted, files).text).toBe('4 modules changed since Flow last read them · 6 files changed')
    expect(driftSummary(drifted, null).text).toBe('4 modules changed since Flow last read them')
    expect(driftSummary(drifted.slice(0, 1), null).text).toBe('1 module changed since Flow last read it')
  })

  it('groups by folder, largest first, with each folder’s facts', () => {
    const folders = driftFolders(drifted, files)
    expect(folders.map((folder) => folder.folder)).toEqual(['src/components', 'src/lib'])
    expect(folders[0]).toMatchObject({ modules: ['src/components/chat', 'src/components/chat/MessageList', 'src/components/settings'], files: 4, facts: '3 modules · 4 files' })
    expect(folders[1]?.facts).toBe('1 module · 2 files')
    expect(driftFolders(drifted, null)[0]?.facts).toBe('3 modules')
  })

  it('sorts by most changed, unknown counts last', () => {
    expect(sortDriftRows(drifted, files, 'changed').map((row) => row.module)).toEqual([
      'src/components/chat',
      'src/lib/http',
      'src/components/chat/MessageList',
      'src/components/settings',
    ])
  })

  it('sorts by oldest first, rows without a time last', () => {
    expect(sortDriftRows(drifted, files, 'oldest').map((row) => row.module)).toEqual([
      'src/components/settings',
      'src/components/chat',
      'src/components/chat/MessageList',
      'src/lib/http',
    ])
    expect(sortDriftRows(drifted, files, 'folder').map((row) => row.module)[0]).toBe('src/components/chat')
  })

  it('tracks a tri-state selection and toggles it as a whole', () => {
    const all = ['a', 'b', 'c']
    expect(selectionState(all, new Set())).toBe('none')
    expect(selectionState(all, new Set(['a']))).toBe('some')
    expect(selectionState(all, new Set(['a', 'b', 'c', 'z']))).toBe('all')
    expect([...toggleSelection(all, new Set(['a']))].sort()).toEqual(['a', 'b', 'c'])
    expect([...toggleSelection(all, new Set(['a', 'b', 'c', 'z']))]).toEqual(['z'])
    expect([...pruneSelection(new Set(['a', 'gone']), all)]).toEqual(['a'])
  })

  it('estimates time only from passes that really finished', () => {
    const log = [
      { at: 0, kind: 'start' as const, module: 'a' },
      { at: 60_000, kind: 'learned' as const, module: 'a' },
      { at: 60_000, kind: 'start' as const, module: 'b' },
      { at: 70_000, kind: 'failed' as const, module: 'b' },
      { at: 70_000, kind: 'start' as const, module: 'c' },
      { at: 250_000, kind: 'learned' as const, module: 'c' },
    ]
    expect(passDurations(log)).toEqual([60_000, 180_000])
    expect(estimateMinutes([60_000, 180_000], 10)).toBe(20)
    expect(selectionLine(11, [90_000])).toBe('11 selected · about 17 min')
    // No finished pass, no estimate — never an invented one.
    expect(passDurations([{ at: 0, kind: 'start', module: 'a' }])).toEqual([])
    expect(estimateMinutes([], 10)).toBeNull()
    expect(selectionLine(11, [])).toBe('11 selected')
  })

  it('puts a batch in its own Updating group, out of every other group', () => {
    const p = progress([
      ['src/a', 'learning'],
      ['src/b', 'queued'],
      ['src/c', 'stale'],
      ['src/d', 'stale'],
      ['src/e', 'queued'],
    ])
    const groups = moduleGroups(p, '', () => false, ['src/a', 'src/b', 'src/c'])
    expect(groups.map((group) => group.key)).toEqual(['updating', 'now', 'drift'])
    expect(groups[0]?.title).toBe('Updating')
    expect(groups[0]?.rows.map((row) => row.module)).toEqual(['src/a', 'src/b', 'src/c'])
    expect(groups[1]?.rows.map((row) => row.module)).toEqual(['src/e'])
    expect(groups[2]?.rows.map((row) => row.module)).toEqual(['src/d'])
  })

  it('reads a batch’s progress: reading, next, waiting in queue order, updated', () => {
    const rows = progress([
      ['src/a', 'learned', '2026-11-16T10:02:00Z'],
      ['src/b', 'learning'],
      ['src/c', 'queued'],
      ['src/d', 'queued'],
      ['src/e', 'learned', '2026-11-16T10:04:00Z'],
    ]).rows
    const batch = { root: '/r', modules: ['src/a', 'src/b', 'src/c', 'src/d', 'src/e'], startedAt: 0 }
    const view = driftBatchView(batch, rows, true, [120_000])
    expect(view.line).toBe('2 of 5 updated · about 6 min left')
    expect(view.finished).toBe(false)
    expect(view.items.map((item) => `${item.module}:${item.label}`)).toEqual([
      'src/b:reading now',
      'src/c:next',
      'src/d:waiting · 3rd',
      'src/e:updated',
      'src/a:updated',
    ])
    expect(driftBatchView(batch, rows, true).line).toBe('2 of 5 updated')
  })

  it('a still-drifted module waits while the learner is busy, and was not updated once it is idle', () => {
    const rows = progress([
      ['src/a', 'learned', '2026-11-16T10:02:00Z'],
      ['src/b', 'stale'],
    ]).rows
    const batch = { root: '/r', modules: ['src/a', 'src/b'], startedAt: 0 }
    const busy = driftBatchView(batch, rows, true)
    expect(busy.items.map((item) => item.state)).toEqual(['next', 'updated'])
    expect(busy.finished).toBe(false)
    const idle = driftBatchView(batch, rows, false)
    expect(idle.items.map((item) => item.state)).toEqual(['updated', 'not-updated'])
    expect(idle.finished).toBe(true)
    expect(idle.line).toBe('1 of 2 updated')
  })
})
