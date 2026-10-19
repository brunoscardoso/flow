import { resolveRailItem, resolveSideTab } from './sidetab-state'

describe('resolveRailItem (activity-bar, #198, #335)', () => {
  it('passes through all 3 sidebar-switching rail items', () => {
    expect(resolveRailItem('threads')).toBe('threads')
    expect(resolveRailItem('files')).toBe('files')
    expect(resolveRailItem('source-control')).toBe('source-control')
  })

  it('migrates legacy git/review tabs to source-control (#335)', () => {
    expect(resolveRailItem('git')).toBe('source-control')
    expect(resolveRailItem('review')).toBe('source-control')
  })

  it('falls back to threads for undefined or unknown values', () => {
    expect(resolveRailItem(undefined)).toBe('threads')
    expect(resolveRailItem('')).toBe('threads')
    expect(resolveRailItem('unknown-stale-value')).toBe('threads')
  })

  it('falls back to threads for legacy sidebar items that are now editor tabs', () => {
    expect(resolveRailItem('terminal')).toBe('threads')
    expect(resolveRailItem('tasks')).toBe('threads')
    expect(resolveRailItem('blueprint')).toBe('threads')
  })
})

describe('resolveSideTab (deprecated alias)', () => {
  it('delegates to resolveRailItem', () => {
    expect(resolveSideTab('threads')).toBe('threads')
    expect(resolveSideTab('files')).toBe('files')
    expect(resolveSideTab('git')).toBe('source-control')
    expect(resolveSideTab(undefined)).toBe('threads')
  })
})
