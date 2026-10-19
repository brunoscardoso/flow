// Command-palette source providers (⌘P): the DOM-free layer that turns injected
// IPC + the command registry into typed PaletteCandidates. Each provider is
// fail-soft (a rejected IPC → []) and honors a post-await stale guard so a
// superseded keystroke's results are dropped. This suite pins those contracts —
// the module ships untested despite being the file/thread/command search core.

import type { SlashCommand, ThreadSummary } from '../../shared/ipc-contract'
import type { PaletteCommand } from './palette-commands'
import {
  commandCandidates,
  fileCandidates,
  loadCommandList,
  staticCommandList,
  threadCandidates,
  type PaletteSourceDeps,
} from './palette-sources'

/** A deps double with jest spies; per-test overrides via the argument. */
function makeDeps(over: Partial<PaletteSourceDeps> = {}): {
  deps: PaletteSourceDeps
  emit: jest.Mock
} {
  const emit = jest.fn()
  const deps: PaletteSourceDeps = {
    listAllFiles: jest.fn().mockResolvedValue({ relPaths: [], truncated: false }),
    searchThreads: jest.fn().mockResolvedValue([]),
    listCommands: jest.fn().mockResolvedValue([]),
    emit,
    ...over,
  }
  return { deps, emit }
}

const thread = (id: string, title: string, updatedAt = '2026-07-19T00:00:00Z'): ThreadSummary =>
  ({ id, title, updatedAt }) as unknown as ThreadSummary

describe('fileCandidates', () => {
  it('returns [] for an empty term without hitting IPC (empty state shows recents)', async () => {
    const { deps } = makeDeps()
    expect(await fileCandidates('/root', '', deps)).toEqual([])
    expect(deps.listAllFiles).not.toHaveBeenCalled()
  })

  it('fuzzy-filters the flat list; label is the basename, sublabel the dir', async () => {
    const { deps } = makeDeps({
      listAllFiles: jest
        .fn()
        .mockResolvedValue({ relPaths: ['app/src/palette.ts', 'README.md', 'app/src/other.css'], truncated: false }),
    })
    const out = await fileCandidates('/root', 'palette', deps)
    expect(out.map((c) => c.id)).toEqual(['app/src/palette.ts']) // only the match survives
    expect(out[0]).toMatchObject({ kind: 'file', label: 'palette.ts', sublabel: 'app/src' })
    expect(out[0].score).toBeGreaterThan(0)
  })

  it('omits sublabel for a root-level file', async () => {
    const { deps } = makeDeps({
      listAllFiles: jest.fn().mockResolvedValue({ relPaths: ['README.md'], truncated: false }),
    })
    const [c] = await fileCandidates('/root', 'readme', deps)
    expect(c.label).toBe('README.md')
    expect(c.sublabel).toBeUndefined()
  })

  it('run() opens the file through flow:open-file', async () => {
    const { deps, emit } = makeDeps({
      listAllFiles: jest.fn().mockResolvedValue({ relPaths: ['a/b.ts'], truncated: false }),
    })
    const [c] = await fileCandidates('/root', 'b', deps)
    c.run()
    expect(emit).toHaveBeenCalledWith('flow:open-file', { rootPath: '/root', relPath: 'a/b.ts' })
  })

  it('is fail-soft: a rejected listAllFiles yields []', async () => {
    const { deps } = makeDeps({ listAllFiles: jest.fn().mockRejectedValue(new Error('boom')) })
    expect(await fileCandidates('/root', 'x', deps)).toEqual([])
  })

  it('drops results from a superseded keystroke via the stale guard (after the await)', async () => {
    const { deps } = makeDeps({
      listAllFiles: jest.fn().mockResolvedValue({ relPaths: ['match.ts'], truncated: false }),
    })
    expect(await fileCandidates('/root', 'match', deps, () => true)).toEqual([])
  })
})

describe('threadCandidates', () => {
  it('returns [] for an empty term', async () => {
    const { deps } = makeDeps()
    expect(await threadCandidates('/root', '', deps)).toEqual([])
    expect(deps.searchThreads).not.toHaveBeenCalled()
  })

  it('scores a title match above zero and carries updatedAt as the recency signal', async () => {
    const { deps } = makeDeps({
      searchThreads: jest.fn().mockResolvedValue([thread('t1', 'Palette redesign', '2026-07-18T12:00:00Z')]),
    })
    const [c] = await threadCandidates('/root', 'palette', deps)
    expect(c).toMatchObject({ kind: 'thread', id: 't1', label: 'Palette redesign', recencyAt: '2026-07-18T12:00:00Z' })
    expect(c.score).toBeGreaterThan(0)
  })

  it('keeps a body-only hit (title does not match) at score 0 — the FTS already filtered it in', async () => {
    // searchThreads is the FTS over titles AND bodies; a thread whose title does
    // not fuzzy-match the term still belongs in the list (body hit tier, score 0).
    const { deps } = makeDeps({
      searchThreads: jest.fn().mockResolvedValue([thread('t2', 'Unrelated title')]),
    })
    const [c] = await threadCandidates('/root', 'zzzznomatch', deps)
    expect(c.id).toBe('t2')
    expect(c.score).toBe(0)
  })

  it('run() opens the thread through flow:open-thread', async () => {
    const { deps, emit } = makeDeps({
      searchThreads: jest.fn().mockResolvedValue([thread('t3', 'anything')]),
    })
    const [c] = await threadCandidates('/root', 'any', deps)
    c.run()
    expect(emit).toHaveBeenCalledWith('flow:open-thread', { threadId: 't3' })
  })

  it('is fail-soft and stale-aware', async () => {
    const rejecting = makeDeps({ searchThreads: jest.fn().mockRejectedValue(new Error('x')) })
    expect(await threadCandidates('/root', 'q', rejecting.deps)).toEqual([])

    const stale = makeDeps({ searchThreads: jest.fn().mockResolvedValue([thread('t', 'q match')]) })
    expect(await threadCandidates('/root', 'q', stale.deps, () => true)).toEqual([])
  })
})

describe('commandCandidates', () => {
  const run = jest.fn()
  const commands: PaletteCommand[] = [
    { id: 'c1', label: 'New thread', icon: 'message', run },
    { id: 'c2', label: 'Open Settings', hint: 'preferences', icon: 'settings', run },
  ]

  it('returns ALL commands (score 0) for an empty term, in registry order', () => {
    const out = commandCandidates('', commands)
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(out.every((c) => c.score === 0)).toBe(true)
  })

  it('fuzzy-filters on the label for a non-empty term, dropping non-matches', () => {
    const out = commandCandidates('settings', commands)
    expect(out.map((c) => c.id)).toEqual(['c2'])
    expect(out[0]).toMatchObject({ kind: 'command', label: 'Open Settings', sublabel: 'preferences', icon: 'settings' })
    expect(out[0].score).toBeGreaterThan(0)
    expect(out[0].run).toBe(run)
  })
})

describe('staticCommandList', () => {
  it('binds the static registry to the emitter (non-empty, run fires an app event)', () => {
    const { deps, emit } = makeDeps()
    const list = staticCommandList(deps)
    expect(list.length).toBeGreaterThan(0)
    const newThread = list.find((c) => c.id === 'cmd:new-thread')
    expect(newThread).toBeDefined()
    newThread?.run()
    expect(emit).toHaveBeenCalledWith('flow:new-thread', undefined)
  })
})

describe('loadCommandList', () => {
  const slash = (name: string, description = ''): SlashCommand =>
    ({ name, description }) as unknown as SlashCommand

  it('folds discovered slash commands onto the static registry', async () => {
    const { deps } = makeDeps({ listCommands: jest.fn().mockResolvedValue([slash('review', 'Review code')]) })
    const list = await loadCommandList('/root', deps)
    const slashCmd = list.find((c) => c.id === 'slash:review')
    expect(slashCmd).toMatchObject({ label: '/review', hint: 'Review code' })
    expect(list.some((c) => c.id === 'cmd:new-thread')).toBe(true) // static still present
  })

  it('is fail-soft: a rejected listCommands yields the static commands only', async () => {
    const { deps } = makeDeps({ listCommands: jest.fn().mockRejectedValue(new Error('x')) })
    const list = await loadCommandList('/root', deps)
    expect(list.some((c) => c.id === 'cmd:new-thread')).toBe(true)
    expect(list.some((c) => c.id.startsWith('slash:'))).toBe(false)
  })

  it('when superseded, falls back to the static commands (never the discovered fold)', async () => {
    const { deps } = makeDeps({ listCommands: jest.fn().mockResolvedValue([slash('review')]) })
    const list = await loadCommandList('/root', deps, () => true)
    expect(list.some((c) => c.id === 'cmd:new-thread')).toBe(true)
    expect(list.some((c) => c.id === 'slash:review')).toBe(false) // stale fold discarded
  })
})
