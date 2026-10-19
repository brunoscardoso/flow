import { PICKER_EMPTY, PICKER_TITLE, filesPanelMode } from './file-tree-picker-model'

const projects = [
  { root: '/a', name: 'Backend', available: true },
  { root: '/b', name: 'Frontend', available: false },
]

describe('filesPanelMode', () => {
  it('asks which project when no thread is selected in a Workspace', () => {
    expect(filesPanelMode({ inWorkspace: true, scopeThreadId: null, scopeRoots: ['/a'], picked: null, projects })).toEqual({
      kind: 'picker',
      projects,
    })
  })
  it('shows the picked project once the scope carries it', () => {
    expect(filesPanelMode({ inWorkspace: true, scopeThreadId: null, scopeRoots: ['/a'], picked: '/a', projects })).toEqual({ kind: 'tree' })
    // Picked, but the switch has not landed yet: keep asking rather than show the wrong tree.
    expect(filesPanelMode({ inWorkspace: true, scopeThreadId: null, scopeRoots: ['/c'], picked: '/a', projects }).kind).toBe('picker')
  })
  it('a selected thread shows its projects', () => {
    expect(filesPanelMode({ inWorkspace: true, scopeThreadId: 't', scopeRoots: ['/a', '/b'], picked: null, projects })).toEqual({ kind: 'tree' })
  })
  it('outside a Workspace the panel is the tree it always was', () => {
    expect(filesPanelMode({ inWorkspace: false, scopeThreadId: null, scopeRoots: ['/c'], picked: null, projects })).toEqual({ kind: 'tree' })
  })
  it('speaks plainly', () => {
    for (const text of [PICKER_TITLE, PICKER_EMPTY]) expect(text).not.toMatch(/\/|planflow-ai|worktree/)
  })
})
