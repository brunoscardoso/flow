// Per-(project, thread) shells — what main saves for a restart, and where.
// Real better-sqlite3 (Electron ABI): run with `node scripts/run-jest.mjs <this file>`.

import Database from 'better-sqlite3'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { SavedTerminalRef, TerminalInfo, TerminalOwner } from '../../shared/ipc-contract'
import { migrate, openDatabase, type FlowDatabase } from '../store/db'
import { MIGRATIONS } from '../store/migrations'
import { TabSetStore } from '../store/tab-set-store'
import { ThreadStore } from '../store/thread-store'
import { ProjectContextManager } from '../project/project-context'
import {
  TERMINAL_CLOSED_BY_USER_EVENT,
  TERMINAL_CREATED_EVENT,
  TERMINAL_EXIT_EVENT,
  TERMINAL_OWNER_SET_EVENT,
  TERMINAL_RENAMED_EVENT,
  TerminalManager,
} from './index'
import { ownedShellRefs, wireShellPersistence } from './shell-persistence'

const ROOT = '/tmp/project-a'
const OTHER = '/tmp/project-b'
const CHECKOUT = '/tmp/.project-a-threads/a'

function shell(id: string, owner: TerminalOwner | undefined, extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    terminalId: id,
    kind: 'user',
    title: id,
    cwd: owner?.threadId === 'thread-a' ? CHECKOUT : ROOT,
    projectRoot: ROOT,
    ...(owner === undefined ? {} : { owner }),
    ...extra,
  }
}

const THREAD_A: TerminalOwner = { rootPath: ROOT, threadId: 'thread-a' }
const THREAD_B: TerminalOwner = { rootPath: ROOT, threadId: 'thread-b' }
const PROJECT: TerminalOwner = { rootPath: ROOT, threadId: null }

describe('ownedShellRefs', () => {
  it('keeps only the live user shells of exactly that scope, in order', () => {
    const terminals: TerminalInfo[] = [
      shell('a1', THREAD_A),
      shell('b1', THREAD_B),
      shell('a2', THREAD_A),
      shell('a-dead', THREAD_A, { exited: true }),
      shell('p1', PROJECT),
      shell('boot', undefined),
      { terminalId: 'agent', kind: 'agent', title: 'Agent', cwd: ROOT, threadId: 'thread-a', projectRoot: ROOT },
    ]
    expect(ownedShellRefs(terminals, THREAD_A)).toEqual([
      { title: 'a1', cwd: CHECKOUT },
      { title: 'a2', cwd: CHECKOUT },
    ])
    expect(ownedShellRefs(terminals, PROJECT)).toEqual([{ title: 'p1', cwd: ROOT }])
    // Same thread id in another project is another scope.
    expect(ownedShellRefs(terminals, { rootPath: OTHER, threadId: 'thread-a' })).toEqual([])
  })

  it('saves a person’s name for the tab over the folder name', () => {
    const terminals = [shell('a1', THREAD_A, { customTitle: 'server' }), shell('a2', THREAD_A)]
    expect(ownedShellRefs(terminals, THREAD_A)).toEqual([
      { title: 'server', cwd: CHECKOUT },
      { title: 'a2', cwd: CHECKOUT },
    ])
  })
})

/** A TerminalManager stand-in: the events and reads persistence uses, no PTYs. */
class FakeTerminals extends EventEmitter {
  terminals: TerminalInfo[] = []
  listTerminals(): TerminalInfo[] {
    return this.terminals.map((info) => ({ ...info }))
  }
  getTerminal(terminalId: string): TerminalInfo | null {
    return this.terminals.find((info) => info.terminalId === terminalId) ?? null
  }
}

describe('wireShellPersistence', () => {
  function setup(): {
    fake: FakeTerminals
    saves: Array<{ rootPath: string; threadId: string | null; refs: SavedTerminalRef[] }>
    dispose: () => void
  } {
    const fake = new FakeTerminals()
    const saves: Array<{ rootPath: string; threadId: string | null; refs: SavedTerminalRef[] }> = []
    const dispose = wireShellPersistence(fake as unknown as TerminalManager, {
      saveScopeTerminals: (rootPath, threadId, refs) => saves.push({ rootPath, threadId, refs }),
    })
    return { fake, saves, dispose }
  }

  it('saves the owner scope’s whole live set when a shell opens', () => {
    const { fake, saves } = setup()
    fake.terminals = [shell('a1', THREAD_A), shell('b1', THREAD_B), shell('a2', THREAD_A)]
    fake.emit(TERMINAL_CREATED_EVENT, fake.terminals[2])
    expect(saves).toEqual([
      { rootPath: ROOT, threadId: 'thread-a', refs: [{ title: 'a1', cwd: CHECKOUT }, { title: 'a2', cwd: CHECKOUT }] },
    ])
  })

  it('re-saves when a person closes one, and when one exits while still registered', () => {
    const { fake, saves } = setup()
    const closed = shell('a1', THREAD_A)
    fake.terminals = [shell('a2', THREAD_A)] // a1 already gone from the manager
    fake.emit(TERMINAL_CLOSED_BY_USER_EVENT, closed)
    expect(saves.at(-1)).toEqual({ rootPath: ROOT, threadId: 'thread-a', refs: [{ title: 'a2', cwd: CHECKOUT }] })

    fake.terminals = [shell('a2', THREAD_A, { exited: true })]
    fake.emit(TERMINAL_EXIT_EVENT, { terminalId: 'a2', exitCode: 0 })
    expect(saves.at(-1)).toEqual({ rootPath: ROOT, threadId: 'thread-a', refs: [] })
  })

  it('writes NOTHING for housekeeping — an exit of a shell already disposed (quit)', () => {
    const { fake, saves } = setup()
    fake.terminals = [shell('a1', THREAD_A)]
    fake.emit(TERMINAL_CREATED_EVENT, fake.terminals[0])
    // Positive first (allowed-pattern #28): the wiring does save.
    expect(saves).toHaveLength(1)
    // Quit: disposeAll drops the entry, then the PTY's exit lands.
    fake.terminals = []
    fake.emit(TERMINAL_EXIT_EVENT, { terminalId: 'a1', exitCode: 129 })
    expect(saves).toHaveLength(1)
  })

  it('saves the adopting scope when an unowned shell is claimed', () => {
    const { fake, saves } = setup()
    fake.terminals = [shell('boot', PROJECT)]
    fake.emit(TERMINAL_OWNER_SET_EVENT, fake.terminals[0])
    expect(saves).toEqual([{ rootPath: ROOT, threadId: null, refs: [{ title: 'boot', cwd: ROOT }] }])
  })

  it('re-saves the scope when one of its shells is renamed', () => {
    const { fake, saves } = setup()
    fake.terminals = [shell('a1', THREAD_A, { customTitle: 'server' })]
    fake.emit(TERMINAL_RENAMED_EVENT, fake.terminals[0])
    expect(saves).toEqual([
      { rootPath: ROOT, threadId: 'thread-a', refs: [{ title: 'server', cwd: CHECKOUT }] },
    ])
  })

  it('ignores shells with no owner and agent terminals', () => {
    const { fake, saves } = setup()
    fake.emit(TERMINAL_CREATED_EVENT, shell('boot', undefined))
    fake.emit(TERMINAL_CREATED_EVENT, {
      terminalId: 'agent',
      kind: 'agent',
      title: 'Agent',
      cwd: ROOT,
      threadId: 'thread-a',
    } satisfies TerminalInfo)
    expect(saves).toEqual([])
  })

  it('unsubscribes', () => {
    const { fake, saves, dispose } = setup()
    dispose()
    fake.terminals = [shell('a1', THREAD_A)]
    fake.emit(TERMINAL_CREATED_EVENT, fake.terminals[0])
    expect(saves).toEqual([])
  })
})

describe('TerminalManager.claimOwner', () => {
  it('never owns an agent tab or an unknown id', () => {
    const manager = new TerminalManager()
    const claimed: TerminalInfo[] = []
    manager.on(TERMINAL_OWNER_SET_EVENT, (info: TerminalInfo) => claimed.push(info))
    const agent = manager.ensureAgentTerminal({ threadId: 't1' })
    expect(manager.claimOwner(agent.terminalId, THREAD_A)).toBe(false)
    expect(manager.claimOwner('nope', THREAD_A)).toBe(false)
    expect(manager.getTerminal(agent.terminalId)?.owner).toBeUndefined()
    expect(claimed).toEqual([])
    manager.disposeAll()
  })
})

describe('TerminalManager.closeByUser', () => {
  it('disposes and announces the close with the closed terminal’s info', () => {
    const manager = new TerminalManager()
    const closed: TerminalInfo[] = []
    manager.on(TERMINAL_CLOSED_BY_USER_EVENT, (info: TerminalInfo) => closed.push(info))
    const info = manager.ensureAgentTerminal({ threadId: 't1', title: 'Agent' })
    manager.closeByUser(info.terminalId)
    expect(closed.map((entry) => entry.terminalId)).toEqual([info.terminalId])
    expect(manager.getTerminal(info.terminalId)).toBeNull()
    // Housekeeping disposal never says "a person closed this".
    const other = manager.ensureAgentTerminal({ threadId: 't2' })
    manager.dispose(other.terminalId)
    expect(closed).toHaveLength(1)
    manager.disposeAll()
  })
})

describe('scope shells in thread_tab_state (v35)', () => {
  let tempDir: string
  let db: FlowDatabase

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-scope-shells-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('round-trips per (project, thread) without touching that scope’s tabs', () => {
    const store = new TabSetStore(db)
    store.save(ROOT, 'thread-a', {
      openFiles: [{ rootPath: ROOT, relPath: 'a.ts', active: true }],
      activeFile: 'a.ts',
      dirtyBuffers: {},
      openViews: [],
    })
    store.saveTerminals(ROOT, 'thread-a', [{ title: 'zsh', cwd: CHECKOUT }])
    store.saveTerminals(ROOT, null, [{ title: 'zsh', cwd: ROOT }])

    expect(store.loadTerminals(ROOT, 'thread-a')).toEqual([{ title: 'zsh', cwd: CHECKOUT }])
    expect(store.loadTerminals(ROOT, null)).toEqual([{ title: 'zsh', cwd: ROOT }])
    expect(store.loadTerminals(ROOT, 'thread-b')).toEqual([])
    expect(store.loadTerminals(OTHER, 'thread-a')).toEqual([])
    // The tabs survived the shells' write, and the shells survive a tab save.
    expect(store.load(ROOT, 'thread-a')?.openFiles.map((ref) => ref.relPath)).toEqual(['a.ts'])
    store.save(ROOT, 'thread-a', { openFiles: [], activeFile: null, dirtyBuffers: {}, openViews: [] })
    expect(store.loadTerminals(ROOT, 'thread-a')).toEqual([{ title: 'zsh', cwd: CHECKOUT }])
  })

  it('moves a shell saved in a renamed checkout to its new home', () => {
    const store = new TabSetStore(db)
    store.saveTerminals(ROOT, 'thread-a', [
      { title: 'zsh', cwd: CHECKOUT },
      { title: 'other', cwd: ROOT },
    ])
    store.repoint(CHECKOUT, '/tmp/.project-a-threads/renamed')
    expect(store.loadTerminals(ROOT, 'thread-a')).toEqual([
      { title: 'zsh', cwd: '/tmp/.project-a-threads/renamed' },
      { title: 'other', cwd: ROOT },
    ])
  })

  it('drops a thread’s shells when the thread is deleted', () => {
    const threads = new ThreadStore(db)
    const store = new TabSetStore(db)
    const doomed = threads.createThread({ projectRoot: ROOT })
    const kept = threads.createThread({ projectRoot: ROOT })
    store.saveTerminals(ROOT, doomed.id, [{ title: 'zsh', cwd: ROOT }])
    store.saveTerminals(ROOT, kept.id, [{ title: 'zsh', cwd: ROOT }])
    expect(store.loadTerminals(ROOT, doomed.id)).toHaveLength(1)

    threads.deleteThread(doomed.id)

    expect(store.loadTerminals(ROOT, doomed.id)).toEqual([])
    expect(store.loadTerminals(ROOT, kept.id)).toHaveLength(1)
  })

  it('the project context refuses to write for a deleted thread or a removed project', () => {
    const ctx = new ProjectContextManager(db)
    const known = new Set([ROOT])
    ctx.setKnownRootCheck((root) => known.has(root))
    ctx.setKnownThreadCheck((threadId) => threadId === 'thread-a')

    ctx.saveScopeTerminals(ROOT, 'thread-a', [{ title: 'zsh', cwd: ROOT }])
    expect(ctx.loadScopeTerminals(ROOT, 'thread-a')).toHaveLength(1)

    ctx.saveScopeTerminals(ROOT, 'thread-gone', [{ title: 'zsh', cwd: ROOT }])
    ctx.saveScopeTerminals(OTHER, null, [{ title: 'zsh', cwd: OTHER }])
    expect(ctx.loadScopeTerminals(ROOT, 'thread-gone')).toEqual([])
    expect(ctx.loadScopeTerminals(OTHER, null)).toEqual([])
  })

  it('drops malformed refs on the way out', () => {
    db.prepare(
      `INSERT INTO thread_tab_state (root_path, thread_id, open_terminals, updated_at) VALUES (?, '', ?, ?)`,
    ).run(ROOT, JSON.stringify([{ title: 'ok', cwd: ROOT }, { title: 3 }, null, { title: 'x', cwd: '' }]), 'now')
    expect(new TabSetStore(db).loadTerminals(ROOT, null)).toEqual([{ title: 'ok', cwd: ROOT }])
  })
})

describe('migration v35 — saved shells become the project-level set', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-scope-shells-mig-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('copies each project’s open_terminals into its project-level row; threads start empty', () => {
    const dbPath = join(tempDir, 'flow.sqlite')
    const before = new Database(dbPath)
    migrate(before, MIGRATIONS.filter((migration) => migration.version <= 34))
    // A v34 database: ROOT has a project-level tab row already; OTHER's
    // workspace_state row arrived after v34 ran, so it has none.
    before
      .prepare(
        `INSERT INTO workspace_state (project_root, open_terminals, active_thread_id, last_active_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ROOT, JSON.stringify([{ title: 'zsh', cwd: ROOT }]), 'thread-a', '2026-09-30T00:00:00.000Z')
    before
      .prepare(
        `INSERT INTO thread_tab_state (root_path, thread_id, open_files, updated_at) VALUES (?, '', ?, ?)`,
      )
      .run(ROOT, JSON.stringify([{ rootPath: ROOT, relPath: 'keep.ts', active: true }]), 'then')
    before
      .prepare('INSERT INTO workspace_state (project_root, open_terminals, last_active_at) VALUES (?, ?, ?)')
      .run(OTHER, JSON.stringify([{ title: 'fish', cwd: OTHER }]), '2026-09-29T00:00:00.000Z')
    before.close()

    const db = openDatabase(dbPath)
    try {
      const store = new TabSetStore(db)
      expect(store.loadTerminals(ROOT, null)).toEqual([{ title: 'zsh', cwd: ROOT }])
      expect(store.loadTerminals(OTHER, null)).toEqual([{ title: 'fish', cwd: OTHER }])
      expect(store.loadTerminals(ROOT, 'thread-a')).toEqual([])
      // The project's tabs were left alone.
      expect(store.load(ROOT, null)?.openFiles.map((ref) => ref.relPath)).toEqual(['keep.ts'])
      // An empty OTHER row was created for the shells, with empty tabs.
      expect(store.load(OTHER, null)?.openFiles).toEqual([])
    } finally {
      db.close()
    }
  })
})
