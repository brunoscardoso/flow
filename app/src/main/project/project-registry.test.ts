// ProjectRegistry.listDirectory tests — real temp-dir projects over the
// REAL better-sqlite3 store (Electron ABI, via scripts/run-jest.mjs).
//
// Regression coverage:
//   - LOG-10: a symlink INSIDE the root pointing outside it must not be
//     listable (lexical checks alone are blind to symlinks)
//   - LOG-16: the ignored-directory names (out, dist, …) only filter
//     DIRECTORIES — a file named `out` must still appear; .DS_Store stays
//     filtered as a file

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import {
  ProjectRegistryDao,
  ProjectRegistry,
  PROJECT_LIST_CHANGED_EVENT,
} from './project-registry'

describe('ProjectRegistry.listDirectory', () => {
  let tempDir: string
  let rootDir: string
  let outsideDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-project-'))
    rootDir = join(tempDir, 'project')
    outsideDir = join(tempDir, 'outside')
    mkdirSync(rootDir)
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside the project')

    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
    manager.addRoot(rootDir)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── Baseline behavior ────────────────────────────────────────────────

  it('lists directories first, then files, both alphabetical', async () => {
    mkdirSync(join(rootDir, 'src'))
    writeFileSync(join(rootDir, 'b.txt'), 'b')
    writeFileSync(join(rootDir, 'a.txt'), 'a')

    const entries = await manager.listDirectory(rootDir)

    expect(entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual([
      'directory:src',
      'file:a.txt',
      'file:b.txt',
    ])
  })

  it('rejects lexical escapes (`..`)', async () => {
    await expect(manager.listDirectory(rootDir, '../outside')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  it('lists symlinks classified by their target type, skipping broken links (#158)', async () => {
    mkdirSync(join(rootDir, 'real'))
    writeFileSync(join(rootDir, 'real.txt'), 'x')
    // A dir symlink named `flow` (mirrors the vault link), a file symlink, and a
    // dangling link — all inside the root so the containment guard passes.
    symlinkSync(join(rootDir, 'real'), join(rootDir, 'flow'), 'dir')
    symlinkSync(join(rootDir, 'real.txt'), join(rootDir, 'alias.txt'), 'file')
    symlinkSync(join(rootDir, 'does-not-exist'), join(rootDir, 'broken'), 'file')

    const names = (await manager.listDirectory(rootDir)).map((e) => `${e.type}:${e.name}`)

    expect(names).toContain('directory:flow') // symlinked dir now appears (was hidden)
    expect(names).toContain('file:alias.txt') // symlinked file appears
    expect(names).not.toContain('file:broken') // dangling link skipped
    expect(names).not.toContain('directory:broken')
  })

  // ── LOG-16: dir-name ignores must not hide same-named FILES ─────────

  it('shows a FILE named `out` while still hiding a DIRECTORY named `out`', async () => {
    // Directory `out` at the root — filtered.
    mkdirSync(join(rootDir, 'out'))
    writeFileSync(join(rootDir, 'out', 'bundle.js'), '// built')
    // File named `out` in a subdirectory — must appear.
    mkdirSync(join(rootDir, 'sub'))
    writeFileSync(join(rootDir, 'sub', 'out'), 'just a file named out')

    const rootEntries = await manager.listDirectory(rootDir)
    expect(rootEntries.map((entry) => entry.name)).not.toContain('out')

    const subEntries = await manager.listDirectory(rootDir, 'sub')
    expect(subEntries).toEqual([
      expect.objectContaining({ name: 'out', type: 'file' }),
    ])
  })

  // ── #696: Next.js route-group folders like `(protected)` ─────────────

  it('lists and expands a parenthesized route-group folder like `(protected)` (#696)', async () => {
    mkdirSync(join(rootDir, 'app'))
    mkdirSync(join(rootDir, 'app', '(protected)'))
    writeFileSync(join(rootDir, 'app', '(protected)', 'page.tsx'), '// route group')

    const appEntries = await manager.listDirectory(rootDir, 'app')
    expect(appEntries).toEqual([
      expect.objectContaining({ name: '(protected)', type: 'directory' }),
    ])

    // …and its contents must be listable (the relPath carries the parentheses).
    const inner = await manager.listDirectory(rootDir, 'app/(protected)')
    expect(inner).toEqual([expect.objectContaining({ name: 'page.tsx', type: 'file' })])
  })

  it('always filters .DS_Store (it is a file)', async () => {
    writeFileSync(join(rootDir, '.DS_Store'), '')
    writeFileSync(join(rootDir, 'kept.txt'), 'kept')

    const entries = await manager.listDirectory(rootDir)

    expect(entries.map((entry) => entry.name)).toEqual(['kept.txt'])
  })

  // ── LOG-10: symlink-aware containment ────────────────────────────────

  it('rejects listing through a symlink that points outside the root', async () => {
    symlinkSync(outsideDir, join(rootDir, 'link'), 'dir')

    await expect(manager.listDirectory(rootDir, 'link')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  it('still lists through a symlink that stays inside the root', async () => {
    mkdirSync(join(rootDir, 'real'))
    writeFileSync(join(rootDir, 'real', 'inner.txt'), 'inside')
    symlinkSync(join(rootDir, 'real'), join(rootDir, 'alias'), 'dir')

    const entries = await manager.listDirectory(rootDir, 'alias')

    expect(entries).toEqual([
      expect.objectContaining({ name: 'inner.txt', type: 'file' }),
    ])
  })
})

describe('ProjectRegistry.listCommands', () => {
  let tempDir: string
  let rootDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-commands-'))
    rootDir = join(tempDir, 'project')
    mkdirSync(rootDir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
    manager.addRoot(rootDir)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeCommand(name: string, body: string): void {
    const dir = join(rootDir, '.claude', 'commands')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
  }

  it('returns an empty list when there is no .claude/commands directory', async () => {
    await expect(manager.listCommands(rootDir)).resolves.toEqual([])
  })

  it('lists commands sorted by name with frontmatter descriptions', async () => {
    writeCommand('discovery-plan.md', '---\ndescription: Gather requirements\n---\n\n# Discovery')
    writeCommand('brainstorm.md', '---\ndescription: Explore an idea\n---\n\n# Brainstorm')

    const commands = await manager.listCommands(rootDir)

    expect(commands).toEqual([
      { name: 'brainstorm', description: 'Explore an idea' },
      { name: 'discovery-plan', description: 'Gather requirements' },
    ])
  })

  it('ignores non-markdown files and tolerates missing/empty frontmatter', async () => {
    writeCommand('flow.md', '# Flow\n\nNo frontmatter here.')
    writeCommand('notes.txt', 'not a command')

    const commands = await manager.listCommands(rootDir)

    expect(commands).toEqual([{ name: 'flow', description: '' }])
  })

  it('strips surrounding quotes from a quoted description', async () => {
    writeCommand('note.md', '---\ndescription: "Capture a note"\n---\n')

    const commands = await manager.listCommands(rootDir)

    expect(commands).toEqual([{ name: 'note', description: 'Capture a note' }])
  })

  it('a skill added inside the cache window is listed on the next read', async () => {
    writeCommand('brainstorm.md', '# Brainstorm')
    expect((await manager.listCommands(rootDir)).map((c) => c.name)).toEqual(['brainstorm'])

    // Well inside COMMANDS_CACHE_TTL_MS: a time-only cache served the old set.
    writeCommand('qaprobe.md', '# qaprobe')

    expect((await manager.listCommands(rootDir)).map((c) => c.name)).toEqual([
      'brainstorm',
      'qaprobe',
    ])
  })

  it('throws for an unknown root', async () => {
    await expect(manager.listCommands(join(tempDir, 'nope'))).rejects.toThrow(/Unknown root/)
  })
})

describe('ProjectRegistry.reorderRoots', () => {
  let tempDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry
  let a: string
  let b: string
  let c: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-reorder-'))
    a = join(tempDir, 'alpha')
    b = join(tempDir, 'beta')
    c = join(tempDir, 'gamma')
    for (const dir of [a, b, c]) mkdirSync(dir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
    manager.addRoot(a)
    manager.addRoot(b)
    manager.addRoot(c)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reorders roots and rewrites positions', () => {
    const result = manager.reorderRoots([c, a, b])
    expect(result.map((root) => root.rootPath)).toEqual([c, a, b])
    expect(result.map((root) => root.position)).toEqual([0, 1, 2])
  })

  it('persists the new order across a fresh manager (restore)', () => {
    manager.reorderRoots([b, c, a])
    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.map((root) => root.rootPath)).toEqual([b, c, a])
  })

  it('keeps a currently-unavailable root, flagged, instead of deleting or hiding it (#258/#263)', async () => {
    // Simulate an unmounted external/network drive: the dir isn't reachable at boot.
    rmSync(a, { recursive: true, force: true })

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    // Not watched/operated on this session, but no longer HIDDEN — it's returned as
    // a greyed-out "unavailable" root (after the available ones) so the sidebar can
    // show it instead of the project silently vanishing (#263).
    expect(restored.map((root) => root.rootPath)).toEqual([b, c, a])
    expect(restored.find((root) => root.rootPath === a)?.available).toBe(false)
    expect(restored.find((root) => root.rootPath === b)?.available).toBe(true)
    await reopened.dispose()

    // …and NOT pruned from persistence — once the location is reachable again,
    // a fresh restore brings the project back as available (drive remounted).
    mkdirSync(a)
    const remounted = new ProjectRegistry(db)
    const restored2 = remounted.restore()
    expect(restored2.map((root) => root.rootPath)).toEqual([a, b, c])
    expect(restored2.every((root) => root.available === true)).toBe(true)
    await remounted.dispose()
  })

  it('appends known roots omitted from the list, never dropping a project', () => {
    // Only mention `c` — a and b keep their relative order after it.
    const result = manager.reorderRoots([c])
    expect(result.map((root) => root.rootPath)).toEqual([c, a, b])
  })

  it('ignores unknown paths in the requested order', () => {
    const result = manager.reorderRoots([join(tempDir, 'ghost'), b, a, c])
    expect(result.map((root) => root.rootPath)).toEqual([b, a, c])
  })
})

// #1118 — availability used to be computed ONCE, at restore(), and getRoots()
// then stamped every live root `available: true` unconditionally. A folder that
// disappeared WHILE Flow ran (Finder rename/move, removed worktree, unmounted
// drive) was therefore never noticed by anything: the sidebar kept rendering it
// healthy, and every consumer of the flag read a value stale by construction.
describe('ProjectRegistry.refreshAvailability (#1118)', () => {
  let tempDir: string
  let db: FlowDatabase
  let a: string
  let b: string
  /** Injected reachability — flip entries to simulate a folder coming and going
   *  without racing the real filesystem. */
  let reachable: Set<string>
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-avail-'))
    a = join(tempDir, 'a')
    b = join(tempDir, 'b')
    mkdirSync(a)
    mkdirSync(b)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    reachable = new Set([a, b])
    manager = new ProjectRegistry(db, 'main', (rootPath) => reachable.has(rootPath))
    manager.addRoot(a)
    manager.addRoot(b)
    manager.restore()
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('re-stamps a root whose folder vanished mid-session as unavailable', () => {
    expect(manager.getRoots().find((root) => root.rootPath === a)?.available).toBe(true)

    reachable.delete(a) // the folder is moved/deleted/unmounted, app still running
    expect(manager.refreshAvailability()).toBe(true)

    const roots = manager.getRoots()
    expect(roots.find((root) => root.rootPath === a)?.available).toBe(false)
    expect(roots.find((root) => root.rootPath === b)?.available).toBe(true)
  })

  it('emits rootsChanged on a transition so every surface re-renders', () => {
    const events: string[][] = []
    manager.on(PROJECT_LIST_CHANGED_EVENT, (roots: Array<{ rootPath: string }>) => {
      events.push(roots.map((root) => root.rootPath))
    })
    reachable.delete(a)
    manager.refreshAvailability()
    expect(events).toHaveLength(1)
  })

  it('is silent when nothing changed — no event, no churn', () => {
    let emitted = 0
    manager.on(PROJECT_LIST_CHANGED_EVENT, () => {
      emitted += 1
    })
    expect(manager.refreshAvailability()).toBe(false)
    expect(emitted).toBe(0)
  })

  it('recovers a root that came BACK (re-mounted drive) without a relaunch', () => {
    reachable.delete(a)
    manager.refreshAvailability()
    expect(manager.getRoots().find((root) => root.rootPath === a)?.available).toBe(false)

    reachable.add(a) // drive re-mounted / folder moved back
    expect(manager.refreshAvailability()).toBe(true)
    expect(manager.getRoots().find((root) => root.rootPath === a)?.available).toBe(true)
    // …and it regains its persisted slot rather than being appended at the end.
    expect(manager.getRoots().map((root) => root.rootPath)).toEqual([a, b])
  })

  it('drops a now-unavailable root from the operated-on set (listDirectory refuses it)', async () => {
    reachable.delete(a)
    manager.refreshAvailability()
    await expect(manager.listDirectory(a)).rejects.toThrow(/Unknown root/)
  })

  it('never lists a root twice when a re-added folder was in the unavailable set', () => {
    reachable.delete(a)
    manager.refreshAvailability()
    reachable.add(a)
    manager.addRoot(a) // the user re-opens the folder before the poll notices
    const paths = manager.getRoots().map((root) => root.rootPath)
    expect(paths.filter((rootPath) => rootPath === a)).toHaveLength(1)
    expect(manager.getRoots().find((root) => root.rootPath === a)?.available).toBe(true)
  })

  it('removes an UNAVAILABLE root — "remove the project I can\'t reach" is not a no-op', () => {
    reachable.delete(a)
    manager.refreshAvailability()
    manager.removeRoot(a)
    expect(manager.getRoots().map((root) => root.rootPath)).toEqual([b])
    // …and it's gone from persistence, not just from this session.
    expect(new ProjectRegistryDao(db).listRoots('main').map((root) => root.rootPath)).toEqual([b])
  })
})

describe('ProjectRegistry.stampProvisioned (ide-auto-provisioning)', () => {
  let tempDir: string
  let rootDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-provision-'))
    rootDir = join(tempDir, 'project')
    mkdirSync(rootDir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('setProvisioningState emits roots-changed only when the state actually changes (2026-10-09 flood)', async () => {
    const root = manager.addRoot(rootDir)
    let emitted = 0
    manager.on('roots-changed', () => (emitted += 1))
    manager.setProvisioningState(root.id, 'provisioning')
    manager.setProvisioningState(root.id, 'provisioning')
    manager.setProvisioningState(root.id, 'ready')
    manager.setProvisioningState(root.id, 'ready')
    expect(emitted).toBe(2)
    expect(manager.getRoots()[0]?.provisioningState).toBe('ready')
  })

  it('reads as absent (undefined), not null, for a legacy/never-provisioned row', async () => {
    const root = manager.addRoot(rootDir)
    expect(root.provisionedAt).toBeUndefined()
    expect(root.provisionedVersion).toBeUndefined()

    // …and stays absent after a fresh restore (the v16 migration applied
    // cleanly to a pre-existing row with NULL columns).
    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored[0]?.provisionedAt).toBeUndefined()
    expect(restored[0]?.provisionedVersion).toBeUndefined()
    await reopened.dispose()
  })

  it('round-trips the stamp through the manager, in-memory cache, and persistence', async () => {
    const root = manager.addRoot(rootDir)
    const at = '2026-07-15T12:00:00.000Z'

    const updated = manager.stampProvisioned(root.id, '1.2.3', at)
    expect(updated).toMatchObject({ provisionedAt: at, provisionedVersion: '1.2.3' })

    // In-memory getRoots() reflects the stamp immediately, no restore needed.
    expect(manager.getRoots().find((r) => r.id === root.id)).toMatchObject({
      provisionedAt: at,
      provisionedVersion: '1.2.3',
    })

    // Persists across a fresh manager (restore reads the stamped columns back).
    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.id === root.id)).toMatchObject({
      provisionedAt: at,
      provisionedVersion: '1.2.3',
    })
    await reopened.dispose()
  })

  it('returns null and persists nothing for an unknown rootId', () => {
    const result = manager.stampProvisioned('does-not-exist', '1.0.0', '2026-01-01T00:00:00.000Z')
    expect(result).toBeNull()
  })

  it('ProjectRegistryDao.stampProvisioned is the single write path the manager delegates to', async () => {
    const root = manager.addRoot(rootDir)
    const dao = new ProjectRegistryDao(db)
    dao.stampProvisioned(root.id, '9.9.9', '2026-02-02T00:00:00.000Z')

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.id === root.id)).toMatchObject({
      provisionedAt: '2026-02-02T00:00:00.000Z',
      provisionedVersion: '9.9.9',
    })
    await reopened.dispose()
  })
})

describe('ProjectRegistry.recordBasicDiscoveryAnswer (progressive-learning #513 phase 2)', () => {
  let tempDir: string
  let rootDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-learn-'))
    rootDir = join(tempDir, 'project')
    mkdirSync(rootDir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reads as absent (undefined) for a never-answered row (v17 applied cleanly)', async () => {
    const root = manager.addRoot(rootDir)
    expect(root.basicDiscoveryAnswer).toBeUndefined()

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored[0]?.basicDiscoveryAnswer).toBeUndefined()
    await reopened.dispose()
  })

  it("round-trips the 'yes' answer through the manager, in-memory cache, and persistence", async () => {
    const root = manager.addRoot(rootDir)

    const updated = manager.recordBasicDiscoveryAnswer(root.id, 'yes')
    expect(updated).toMatchObject({ basicDiscoveryAnswer: 'yes' })
    expect(manager.getRoots().find((r) => r.id === root.id)?.basicDiscoveryAnswer).toBe('yes')

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.id === root.id)?.basicDiscoveryAnswer).toBe('yes')
    await reopened.dispose()
  })

  it("persists a 'no' answer (so the ask never re-fires)", async () => {
    const root = manager.addRoot(rootDir)
    manager.recordBasicDiscoveryAnswer(root.id, 'no')

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.id === root.id)?.basicDiscoveryAnswer).toBe('no')
    await reopened.dispose()
  })

  it('returns null and persists nothing for an unknown rootId', () => {
    expect(manager.recordBasicDiscoveryAnswer('does-not-exist', 'yes')).toBeNull()
  })

  it('ProjectRegistryDao.setBasicDiscoveryAnswer is the single write path the manager delegates to', async () => {
    const root = manager.addRoot(rootDir)
    const dao = new ProjectRegistryDao(db)
    dao.setBasicDiscoveryAnswer(root.id, 'no')

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.id === root.id)?.basicDiscoveryAnswer).toBe('no')
    await reopened.dispose()
  })
})

describe('ProjectRegistry.setRootAccent (user project colors)', () => {
  let tempDir: string
  let rootDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-accent-'))
    rootDir = join(tempDir, 'project')
    mkdirSync(rootDir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reads as absent (undefined) for a never-overridden row (v19 applied cleanly)', async () => {
    const root = manager.addRoot(rootDir)
    expect(root.accentColor).toBeUndefined()

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored[0]?.accentColor).toBeUndefined()
    await reopened.dispose()
  })

  it('round-trips an override through the manager, in-memory cache, and persistence', async () => {
    manager.addRoot(rootDir)

    const updated = manager.setRootAccent(rootDir, '#9d70db')
    expect(updated).toMatchObject({ accentColor: '#9d70db' })
    expect(manager.getRoots().find((r) => r.rootPath === rootDir)?.accentColor).toBe('#9d70db')

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.rootPath === rootDir)?.accentColor).toBe('#9d70db')
    await reopened.dispose()
  })

  it('clears back to Auto with null — the key reads as absent again', async () => {
    manager.addRoot(rootDir)
    manager.setRootAccent(rootDir, '#30a69a')

    const cleared = manager.setRootAccent(rootDir, null)
    expect(cleared?.accentColor).toBeUndefined()

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.rootPath === rootDir)?.accentColor).toBeUndefined()
    await reopened.dispose()
  })

  it('emits rootsChanged so the scope layer and renderer surfaces update live', () => {
    manager.addRoot(rootDir)
    const events: unknown[] = []
    manager.on('roots-changed', (roots) => events.push(roots))

    manager.setRootAccent(rootDir, '#df8c3a')
    expect(events).toHaveLength(1)
  })

  it('rejects a malformed color instead of persisting garbage', () => {
    manager.addRoot(rootDir)
    expect(() => manager.setRootAccent(rootDir, 'not-a-color')).toThrow(/Invalid accent color/)
    expect(() => manager.setRootAccent(rootDir, 'red')).toThrow(/Invalid accent color/)
    expect(manager.getRoots()[0]?.accentColor).toBeUndefined()
  })

  it('returns null and persists nothing for an unknown root', () => {
    expect(manager.setRootAccent(join(tempDir, 'ghost'), '#5778db')).toBeNull()
  })

  it('ProjectRegistryDao.setAccentColor is the single write path the manager delegates to', async () => {
    const root = manager.addRoot(rootDir)
    const dao = new ProjectRegistryDao(db)
    dao.setAccentColor(root.id, '#d666ba')

    const reopened = new ProjectRegistry(db)
    const restored = reopened.restore()
    expect(restored.find((r) => r.id === root.id)?.accentColor).toBe('#d666ba')
    await reopened.dispose()
  })
})

// ── Watcher ignore list + flow/ batch filter (perf batch) ────────────────

import {
  WATCH_IGNORED,
  PROJECT_FILES_CHANGED_EVENT,
  isUnderFlowDir,
  type ProjectFilesChangedEvent,
  type FileChange,
} from './project-registry'

describe('WATCH_IGNORED (perf batch)', () => {
  const ignoredPaths = [
    '/r/node_modules/x.js',
    '/r/.git/index',
    // The knowledge repo's own git folder: a pull or commit there is not a file change.
    '/r/flow/.git/index',
    '/r/flow/.git/refs/remotes/origin/main',
    '/r/dist/a.js',
    '/r/out/main/index.js',
    '/r/.blueprint/graph.json',
    '/r/graphify-out/graph.json',
    '/r/build/output.o',
    '/r/target/debug/bin',
    '/r/.venv/lib/site.py',
    '/r/venv/lib/site.py',
    '/r/.next/cache/x',
    '/r/coverage/lcov.info',
    '/r/vendor/lib.go',
    '/r/__pycache__/m.pyc',
    '/r/.turbo/cache',
    '/r/.gradle/cache',
    '/r/nested/node_modules/y.js',
    '/r/.brain.sqlite',
    '/r/.brain.sqlite-wal',
    '/r/.brain.sqlite-shm',
    '/r/sub/.brain.sqlite-journal',
    '/r/.DS_Store',
  ]
  const watchedPaths = [
    '/r/src/index.ts',
    '/r/flow/plans/plan_x.md',
    '/r/builder/x.ts', // `build` must match whole segments only
    '/r/rebuild/x.ts',
    '/r/outline.md', // a FILE named like an ignored dir prefix stays watched
    '/r/brain.sqlite.md',
  ]

  it.each(ignoredPaths)('ignores %s', (path) => {
    expect(WATCH_IGNORED.test(path)).toBe(true)
  })

  it.each(watchedPaths)('keeps watching %s', (path) => {
    expect(WATCH_IGNORED.test(path)).toBe(false)
  })
})

describe('isUnderFlowDir', () => {
  it('matches the flow dir itself and anything beneath it', () => {
    expect(isUnderFlowDir('/r', '/r/flow')).toBe(true)
    expect(isUnderFlowDir('/r', '/r/flow/plans/plan_x.md')).toBe(true)
    expect(isUnderFlowDir('/r', '/r/flow/.rounds.jsonl')).toBe(true)
  })

  it('does not match siblings, prefixes, or paths outside the root', () => {
    expect(isUnderFlowDir('/r', '/r/src/flow.ts')).toBe(false)
    expect(isUnderFlowDir('/r', '/r/flowchart/x.md')).toBe(false)
    expect(isUnderFlowDir('/r', '/r')).toBe(false)
    expect(isUnderFlowDir('/r', '/elsewhere/flow/x.md')).toBe(false)
  })
})

describe('ProjectRegistry flow/ batch filter (perf batch)', () => {
  let tempDir: string
  let rootDir: string
  let db: FlowDatabase
  let manager: ProjectRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-project-filter-'))
    rootDir = join(tempDir, 'project')
    mkdirSync(rootDir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    manager = new ProjectRegistry(db)
    manager.addRoot(rootDir)
  })

  afterEach(async () => {
    await manager.dispose()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** Drive the private queue/flush seam directly — chokidar delivery on
   *  macOS temp dirs is not deterministic enough to test through. */
  function flush(changes: FileChange[]): ProjectFilesChangedEvent[] {
    const events: ProjectFilesChangedEvent[] = []
    manager.on(PROJECT_FILES_CHANGED_EVENT, (event: ProjectFilesChangedEvent) =>
      events.push(event),
    )
    const seam = manager as unknown as {
      queueChange(rootPath: string, change: FileChange): void
      flushChanges(rootPath: string): void
    }
    for (const change of changes) seam.queueChange(rootDir, change)
    seam.flushChanges(rootDir)
    return events
  }

  it('drops flow/** entries from the batch and keeps everything else', () => {
    const events = flush([
      { type: 'changed', path: join(rootDir, 'src', 'a.ts') },
      { type: 'changed', path: join(rootDir, 'flow', '.rounds.jsonl') },
      { type: 'created', path: join(rootDir, 'flow', 'plans', 'plan_x.md') },
    ])
    expect(events).toHaveLength(1)
    expect(events[0].changes.map((change) => change.path)).toEqual([
      join(rootDir, 'src', 'a.ts'),
    ])
  })

  it('emits nothing when the whole batch was flow/ churn', () => {
    const events = flush([
      { type: 'changed', path: join(rootDir, 'flow', '.rounds.jsonl') },
      { type: 'changed', path: join(rootDir, 'flow', 'brain', '.structure', 'graph.json') },
    ])
    expect(events).toHaveLength(0)
  })

  it('keeps a flow doc that the open-document filter exempts', () => {
    const openDoc = join(rootDir, 'flow', 'plans', 'plan_x.md')
    manager.setOpenDocumentFilter((path) => path === openDoc)
    const events = flush([
      { type: 'changed', path: openDoc },
      { type: 'changed', path: join(rootDir, 'flow', '.rounds.jsonl') },
    ])
    expect(events).toHaveLength(1)
    expect(events[0].changes.map((change) => change.path)).toEqual([openDoc])
  })
})
