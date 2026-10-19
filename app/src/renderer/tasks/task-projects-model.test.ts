import type { WorkspaceListing } from '../../shared/workspaces-contract'
import {
  NEED_A_PROJECT,
  NOT_ON_THIS_COMPUTER,
  NOT_OPEN_IN_FLOW,
  STARTS_HERE,
  canSubmitProjects,
  cardProjectsView,
  pickableOnly,
  pickerCount,
  pickerProjects,
  pickerRows,
  projectsEditable,
  splitPicked,
  submitNeed,
  togglePicked,
} from './task-projects-model'

const APP = '/code/orbit-app'
const CORE = '/code/orbit-core'

function project(id: string, name: string, localPath: string | null) {
  return { id, name, slug: id, remotes: [], description: null, localPath, flowPath: `/flow/${id}` }
}

const WORKSPACE = {
  name: 'Orbit',
  slug: 'orbit',
  projects: [
    project('app', 'orbit-app', APP),
    project('core', 'orbit-core', CORE),
    project('argo', 'orbit-argo-applications', null),
    project('mobile', 'storefront-mobile', '/elsewhere/storefront-mobile'),
  ],
} as unknown as WorkspaceListing

const OPEN: Record<string, string> = { app: APP, core: CORE }

function projects() {
  return pickerProjects({
    workspace: WORKSPACE,
    registeredRoot: (_slug, id) => OPEN[id] ?? null,
    boardRoots: [APP, CORE],
    nameOf: (root) => root.split('/').pop() ?? root,
  })
}

describe('task projects picker model', () => {
  it("lists the Workspace's projects in its order, each open one tickable and the others with a reason", () => {
    const list = projects()
    expect(list.map((p) => p.name)).toEqual(['orbit-app', 'orbit-core', 'orbit-argo-applications', 'storefront-mobile'])
    expect(list.map((p) => p.unavailableReason)).toEqual([null, null, NOT_ON_THIS_COMPUTER, NOT_OPEN_IN_FLOW])
    expect(list[0]?.root).toBe(APP)
  })

  it('outside a Workspace, lists the board’s own projects', () => {
    const list = pickerProjects({ workspace: null, registeredRoot: () => null, boardRoots: [APP], nameOf: () => 'orbit-app' })
    expect(list).toEqual([{ root: APP, name: 'orbit-app', unavailableReason: null }])
  })

  it('starts with nothing ticked: no row checked, no "starts here", the add buttons off', () => {
    const rows = pickerRows(projects(), [])
    // Positive first: there ARE tickable rows.
    expect(rows.filter((row) => !row.disabled)).toHaveLength(2)
    expect(rows.some((row) => row.checked)).toBe(false)
    expect(rows.some((row) => row.note === STARTS_HERE)).toBe(false)
    expect(canSubmitProjects([])).toBe(false)
    expect(submitNeed([])).toBe(NEED_A_PROJECT)
    expect(pickerCount(projects(), [], true)).toBe('0 of 4 in this Workspace')
  })

  it('the FIRST ticked project starts the chat; unticking it hands that to the next', () => {
    let picked: string[] = []
    picked = togglePicked(picked, CORE)
    picked = togglePicked(picked, APP)
    let rows = pickerRows(projects(), picked)
    expect(rows.find((row) => row.root === CORE)?.note).toBe(STARTS_HERE)
    expect(rows.find((row) => row.root === APP)?.note).toBe('')
    expect(rows.filter((row) => row.checked).map((row) => row.root)).toEqual([APP, CORE])
    expect(splitPicked(picked)).toEqual({ projectRoot: CORE, additionalRoots: [APP] })
    expect(pickerCount(projects(), picked, true)).toBe('2 of 4 in this Workspace')
    expect(submitNeed(picked)).toBe('')

    picked = togglePicked(picked, CORE)
    rows = pickerRows(projects(), picked)
    expect(rows.find((row) => row.root === APP)?.note).toBe(STARTS_HERE)
    expect(splitPicked(picked)).toEqual({ projectRoot: APP, additionalRoots: [] })
    expect(splitPicked([])).toBeNull()
  })

  it('an unavailable project can never be ticked, even when asked', () => {
    expect(pickableOnly(projects(), [APP, '/elsewhere/storefront-mobile', APP])).toEqual([APP])
    const rows = pickerRows(projects(), [])
    expect(rows.find((row) => row.name === 'orbit-argo-applications')).toMatchObject({ disabled: true, checked: false })
  })

  it('a card may change projects only while its chat has not started', () => {
    expect(projectsEditable({ sdkSessionId: null, status: 'idle' })).toBe(true)
    expect(projectsEditable({ sdkSessionId: 'sess-1', status: 'idle' })).toBe(false)
    expect(projectsEditable({ sdkSessionId: null, status: 'running' })).toBe(false)
    expect(projectsEditable(null)).toBe(false)
  })

  it('a card draws chips for chosen projects, "Add projects" for an unchosen ticket, nothing otherwise', () => {
    const nameOf = (root: string) => root.split('/').pop() ?? root
    expect(
      cardProjectsView({ projectRoot: APP, extraRoots: [CORE], chosen: true, fromTracker: true, editable: true, nameOf }),
    ).toEqual({
      kind: 'chips',
      chips: [
        { root: APP, name: 'orbit-app' },
        { root: CORE, name: 'orbit-core' },
      ],
      change: true,
    })
    // Started: chips stay, read-only.
    expect(
      cardProjectsView({ projectRoot: APP, extraRoots: [], chosen: true, fromTracker: true, editable: false, nameOf }),
    ).toMatchObject({ kind: 'chips', change: false })
    expect(
      cardProjectsView({ projectRoot: APP, extraRoots: [], chosen: false, fromTracker: true, editable: true, nameOf }),
    ).toEqual({ kind: 'add' })
    expect(
      cardProjectsView({ projectRoot: APP, extraRoots: [], chosen: false, fromTracker: false, editable: true, nameOf }),
    ).toEqual({ kind: 'none' })
    expect(
      cardProjectsView({ projectRoot: APP, extraRoots: [], chosen: false, fromTracker: true, editable: false, nameOf }),
    ).toEqual({ kind: 'none' })
  })
})
