// ArtifactObserver tests — pure kind-derivation/filter logic, plus a
// real-chokidar integration pass over a temp `flow/` tree (the behavior under
// test IS the file watch, so — like blueprint-observer's graphify-landing
// test — it isn't mocked away).

import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { CliRunResult } from '../agent/learn-session'
import { announceFlowLinksChanged } from '../project/flow-link-events'
import type { FlowArtifactChangedEvent } from '../../shared/ipc-contract'
import {
  ArtifactObserver,
  artifactDocFor,
  deriveArtifactKind,
  isArtifactFile,
  isOutsideArtifactSubdirs,
  isWalkthroughFile,
  makeMarkerPersister,
  parseNarrateResult,
  scanArtifacts,
  walkthroughStateFor,
  type ArtifactMarkerSink,
} from './artifact-observer'

describe('scanArtifacts', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-scan-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns one event per existing .md across the three subdirs', () => {
    mkdirSync(join(root, 'flow', 'discovery'), { recursive: true })
    mkdirSync(join(root, 'flow', 'plans'), { recursive: true })
    mkdirSync(join(root, 'flow', 'brainstorms'), { recursive: true })
    writeFileSync(join(root, 'flow', 'discovery', 'discovery_x_v1.md'), '# d')
    writeFileSync(join(root, 'flow', 'plans', 'plan_x_v1.md'), '# p')
    writeFileSync(join(root, 'flow', 'brainstorms', 'brainstorm_x_v1.md'), '# b')

    const events = scanArtifacts(root)
    expect(events.map((e) => e.kind).sort()).toEqual(['brainstorm', 'discovery', 'plan'])
    const plan = events.find((e) => e.kind === 'plan')!
    expect(plan.path).toBe('flow/plans/plan_x_v1.md')
    expect(plan.name).toBe('plan_x_v1.md')
    expect(plan.mtime).toBeGreaterThan(0)
    expect(plan.rootId).toBe(root)
  })

  it('skips dotfiles, non-md, and absent subdirs — never throws', () => {
    mkdirSync(join(root, 'flow', 'plans'), { recursive: true })
    writeFileSync(join(root, 'flow', 'plans', 'plan_ok_v1.md'), '# ok')
    writeFileSync(join(root, 'flow', 'plans', '.plan_swap.md'), 'swap')
    writeFileSync(join(root, 'flow', 'plans', 'notes.txt'), 'txt')
    // discovery/ and brainstorms/ absent entirely
    const events = scanArtifacts(root)
    expect(events.map((e) => e.name)).toEqual(['plan_ok_v1.md'])
  })

  it('flags a doc whose walkthrough page sits beside it, and never lists the page as a card', () => {
    mkdirSync(join(root, 'flow', 'discovery'), { recursive: true })
    writeFileSync(join(root, 'flow', 'discovery', 'discovery_pay_v1.md'), '# Pay')
    writeFileSync(join(root, 'flow', 'discovery', 'discovery_pay_v1.walkthrough.html'), '<p>Pay</p>')
    writeFileSync(join(root, 'flow', 'discovery', 'discovery_other_v1.md'), '# Other')

    const events = scanArtifacts(root)
    expect(events.map((e) => e.name).sort()).toEqual(['discovery_other_v1.md', 'discovery_pay_v1.md'])
    const pay = events.find((e) => e.name === 'discovery_pay_v1.md')!
    expect(pay.walkthrough).toBe(true)
    expect(pay.walkthroughMtime).toBeGreaterThan(0)
    const other = events.find((e) => e.name === 'discovery_other_v1.md')!
    expect(other.walkthrough).toBe(false)
    expect(other.walkthroughMtime).toBeUndefined()
  })

  it('returns [] for a root with no flow/ dir', () => {
    expect(scanArtifacts(root)).toEqual([])
  })
})

describe('deriveArtifactKind', () => {
  it('maps each watched subdir to its artifact kind', () => {
    expect(deriveArtifactKind('discovery')).toBe('discovery')
    expect(deriveArtifactKind('plans')).toBe('plan')
    expect(deriveArtifactKind('brainstorms')).toBe('brainstorm')
  })

  it('returns null for unwatched subdirs (e.g. archive)', () => {
    expect(deriveArtifactKind('archive')).toBeNull()
    expect(deriveArtifactKind('contracts')).toBeNull()
    expect(deriveArtifactKind('')).toBeNull()
  })
})

describe('isArtifactFile', () => {
  it('accepts a plain markdown filename', () => {
    expect(isArtifactFile('/root/flow/plans/plan_foo_v1.md')).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isArtifactFile('/root/flow/plans/plan_foo_v1.MD')).toBe(true)
  })

  it('rejects dotfiles (editor swap/lock files)', () => {
    expect(isArtifactFile('/root/flow/plans/.plan_foo_v1.md.swp')).toBe(false)
    expect(isArtifactFile('/root/flow/plans/.DS_Store')).toBe(false)
  })

  it('rejects non-markdown files', () => {
    expect(isArtifactFile('/root/flow/plans/notes.txt')).toBe(false)
    expect(isArtifactFile('/root/flow/plans/plan_foo_v1')).toBe(false)
  })
})

describe('walkthrough page detection', () => {
  it('recognises a walkthrough page and keeps it out of the card list', () => {
    expect(isWalkthroughFile('/r/flow/discovery/discovery_x_v1.walkthrough.html')).toBe(true)
    expect(isArtifactFile('/r/flow/discovery/discovery_x_v1.walkthrough.html')).toBe(false)
  })

  it('rejects a bare suffix, a dotfile and plain html', () => {
    expect(isWalkthroughFile('/r/flow/discovery/.walkthrough.html')).toBe(false)
    expect(isWalkthroughFile('/r/flow/discovery/.x.walkthrough.html')).toBe(false)
    expect(isWalkthroughFile('/r/flow/discovery/x.html')).toBe(false)
  })

  it('maps a page event to its doc, a doc to itself, anything else to nothing', () => {
    expect(artifactDocFor('/r/flow/discovery/discovery_x_v1.walkthrough.html')).toBe(
      '/r/flow/discovery/discovery_x_v1.md',
    )
    expect(artifactDocFor('/r/flow/plans/plan_x_v1.md')).toBe('/r/flow/plans/plan_x_v1.md')
    expect(artifactDocFor('/r/flow/plans/notes.txt')).toBeNull()
  })

  it('reads the page state through the injected stat', () => {
    const seen: string[] = []
    const state = walkthroughStateFor('/r/flow/discovery/d_v1.md', (path) => {
      seen.push(path)
      return { mtimeMs: 42 }
    })
    expect(seen).toEqual(['/r/flow/discovery/d_v1.walkthrough.html'])
    expect(state).toEqual({ walkthrough: true, walkthroughMtime: 42 })
  })

  it('reads a recent page that still has placeholders as being written', () => {
    const NOW = 1_000_000_000
    const stat = (): { mtimeMs: number } => ({ mtimeMs: NOW - 5_000 })
    expect(walkthroughStateFor('/r/flow/discovery/d_v1.md', stat, () => '<h1><!-- SLOT: name --></h1>', NOW)).toEqual({
      walkthrough: true,
      walkthroughMtime: NOW - 5_000,
      walkthroughWriting: true,
    })
    // Filled: the same page with no marker left is a page.
    expect(walkthroughStateFor('/r/flow/discovery/d_v1.md', stat, () => '<h1>Pay</h1>', NOW)).toEqual({
      walkthrough: true,
      walkthroughMtime: NOW - 5_000,
    })
  })

  it('never reads a page older than the writing window', () => {
    const NOW = 1_000_000_000
    const read = jest.fn(() => '<!-- SLOT: x -->')
    const state = walkthroughStateFor('/r/flow/discovery/d_v1.md', () => ({ mtimeMs: 1 }), read, NOW)
    expect(read).not.toHaveBeenCalled()
    expect(state).toEqual({ walkthrough: true, walkthroughMtime: 1 })
  })

  it('reads a missing page as no page', () => {
    expect(
      walkthroughStateFor('/r/flow/discovery/d_v1.md', () => {
        throw new Error('ENOENT')
      }),
    ).toEqual({ walkthrough: false })
  })
})

describe('isOutsideArtifactSubdirs', () => {
  const ROOT = '/root'

  it('never ignores the root itself', () => {
    expect(isOutsideArtifactSubdirs(ROOT, ROOT)).toBe(false)
  })

  it('ignores everything outside flow/ (e.g. node_modules, src)', () => {
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'node_modules'))).toBe(true)
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'src', 'index.ts'))).toBe(true)
  })

  it('traverses into flow/ itself', () => {
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow'))).toBe(false)
  })

  it('allows the three watched subdirs and their files', () => {
    for (const dir of ['discovery', 'plans', 'brainstorms']) {
      expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', dir))).toBe(false)
      expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', dir, 'x.md'))).toBe(false)
    }
  })

  it('ignores flow/archive and other non-watched flow subdirs', () => {
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', 'archive'))).toBe(true)
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', 'archive', 'plan_old.md'))).toBe(true)
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', 'contracts'))).toBe(true)
  })

  it("prunes the knowledge repo's own git folder — a pull or a commit there is never an artifact event", () => {
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', '.git'))).toBe(true)
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', '.git', 'refs', 'heads', 'main'))).toBe(true)
    expect(isOutsideArtifactSubdirs(ROOT, join(ROOT, 'flow', '.git', 'MERGE_HEAD'))).toBe(true)
  })
})

describe('makeMarkerPersister (#1056)', () => {
  const EVENT: FlowArtifactChangedEvent = {
    rootId: '/root',
    kind: 'plan',
    path: 'flow/plans/plan_foo_v1.md',
    name: 'plan_foo_v1.md',
    mtime: 1000,
  }

  function makeSink(overrides: Partial<ArtifactMarkerSink> = {}): {
    sink: ArtifactMarkerSink
    appended: Array<{ threadId: string; content: string }>
  } {
    const appended: Array<{ threadId: string; content: string }> = []
    const sink: ArtifactMarkerSink = {
      activeThreadFor: () => 'thread-1',
      hasMarker: () => false,
      append: (threadId, content) => {
        appended.push({ threadId, content })
      },
      ...overrides,
    }
    return { sink, appended }
  }

  it('appends one marker row to the active thread on first observation', () => {
    const { sink, appended } = makeSink()
    makeMarkerPersister(sink)(EVENT)
    expect(appended).toEqual([
      { threadId: 'thread-1', content: '[artifact] plan flow/plans/plan_foo_v1.md' },
    ])
  })

  it('a RE-LISTED doc (the watch re-announcing a folder after a re-link) is never pinned to a thread that did not write it (live 2026-10-06)', () => {
    // The live report: after orbit-app's flow/ was re-pointed into its
    // Workspace, every discovery, plan and brainstorm in it appeared as a card
    // in the open thread, whose agent wrote none of them.
    const { sink, appended } = makeSink()
    const persist = makeMarkerPersister(sink)
    persist({ ...EVENT, replayed: true })
    expect(appended).toEqual([])
    // …but the thread that DID write it still gets its card.
    const writer = makeSink({ owningThreadFor: () => 'writer-thread' })
    makeMarkerPersister(writer.sink)({ ...EVENT, replayed: true })
    expect(writer.appended.map((entry) => entry.threadId)).toEqual(['writer-thread'])
  })

  it('records a doc only once per (thread, docPath) within a session', () => {
    const { sink, appended } = makeSink()
    const persist = makeMarkerPersister(sink)
    persist(EVENT)
    persist({ ...EVENT, mtime: 2000 }) // the doc changed again — same position
    expect(appended).toHaveLength(1)
  })

  it('records distinct docs and distinct threads independently', () => {
    let thread = 'thread-1'
    const { sink, appended } = makeSink({ activeThreadFor: () => thread })
    const persist = makeMarkerPersister(sink)
    persist(EVENT)
    persist({ ...EVENT, path: 'flow/plans/plan_bar_v1.md', name: 'plan_bar_v1.md' })
    thread = 'thread-2'
    persist(EVENT)
    expect(appended.map((entry) => entry.threadId)).toEqual(['thread-1', 'thread-1', 'thread-2'])
  })

  it('the WRITER thread outranks the active one — reading elsewhere loses nothing (#1717)', () => {
    // The live report: the agent wrote a discovery doc while the user was on
    // another thread; the marker attributed by focus was never written, so
    // the card vanished on the next reload (#1056's suppression, working as
    // designed on a marker that did not exist).
    const { sink, appended } = makeSink({
      activeThreadFor: () => 'thread-the-user-is-reading',
      owningThreadFor: () => 'thread-that-wrote-the-doc',
    })
    makeMarkerPersister(sink)(EVENT)
    expect(appended).toEqual([
      { threadId: 'thread-that-wrote-the-doc', content: '[artifact] plan flow/plans/plan_foo_v1.md' },
    ])
  })

  it('a recorded writer rescues the no-active-thread case entirely (#1717)', () => {
    const { sink, appended } = makeSink({
      activeThreadFor: () => null,
      owningThreadFor: () => 'thread-that-wrote-the-doc',
    })
    makeMarkerPersister(sink)(EVENT)
    expect(appended.map((entry) => entry.threadId)).toEqual(['thread-that-wrote-the-doc'])
  })

  it('a hand-edited doc with no writer still falls back to the active thread (#1717)', () => {
    const { sink, appended } = makeSink({ owningThreadFor: () => null })
    makeMarkerPersister(sink)(EVENT)
    expect(appended.map((entry) => entry.threadId)).toEqual(['thread-1'])
  })

  it('a doc written into a project ATTACHED to the thread names its root, and the thread is returned for the broadcast (live 2026-10-09)', () => {
    const { sink, appended } = makeSink({
      activeThreadFor: () => null,
      owningThreadFor: () => 'writer',
      primaryRootOf: () => '/primary',
    })
    const owner = makeMarkerPersister(sink)(EVENT)
    expect(owner).toBe('writer')
    expect(appended).toEqual([{ threadId: 'writer', content: '[artifact] plan flow/plans/plan_foo_v1.md @/root' }])
  })

  it("a doc in the thread's OWN project keeps the old marker content (the dedupe compares content)", () => {
    const { sink, appended } = makeSink({ owningThreadFor: () => 'writer', primaryRootOf: () => '/root' })
    expect(makeMarkerPersister(sink)(EVENT)).toBe('writer')
    expect(appended).toEqual([{ threadId: 'writer', content: '[artifact] plan flow/plans/plan_foo_v1.md' }])
  })

  it('returns null when the doc belongs to no thread — the broadcast then carries no owner', () => {
    const { sink } = makeSink({ activeThreadFor: () => null, owningThreadFor: () => null })
    expect(makeMarkerPersister(sink)(EVENT)).toBeNull()
    expect(makeMarkerPersister(null)(EVENT)).toBeNull()
  })

  it('skips the append when the store already has the marker (relaunch dedupe)', () => {
    const { sink, appended } = makeSink({ hasMarker: () => true })
    makeMarkerPersister(sink)(EVENT)
    expect(appended).toEqual([])
  })

  it('does nothing when no thread is active or no sink is configured', () => {
    const { sink, appended } = makeSink({ activeThreadFor: () => null })
    makeMarkerPersister(sink)(EVENT)
    expect(appended).toEqual([])
    expect(() => makeMarkerPersister(null)(EVENT)).not.toThrow()
    expect(() => makeMarkerPersister(undefined)(EVENT)).not.toThrow()
  })

  it('fails soft when the sink throws — the broadcast path must survive', () => {
    const { sink } = makeSink({
      append: () => {
        throw new Error('db locked')
      },
    })
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => makeMarkerPersister(sink)(EVENT)).not.toThrow()
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('parseNarrateResult', () => {
  it('extracts the CLI success line as the summary', () => {
    const result: CliRunResult = { ok: true, stdout: 'narrate: foo — 3 steps compiled\n' }
    expect(parseNarrateResult(result)).toEqual({
      ok: true,
      summary: 'narrate: foo — 3 steps compiled',
    })
  })

  it('takes the last non-empty stdout line when there is trailing whitespace', () => {
    const result: CliRunResult = { ok: true, stdout: '\nnarrate: foo — 1 steps compiled\n\n' }
    expect(parseNarrateResult(result)).toEqual({
      ok: true,
      summary: 'narrate: foo — 1 steps compiled',
    })
  })

  it('falls back to a generic summary when stdout is empty', () => {
    const result: CliRunResult = { ok: true, stdout: '' }
    expect(parseNarrateResult(result)).toEqual({ ok: true, summary: 'narrate: done' })
  })

  it('surfaces the full verbatim stderr block on refusal (multi-line)', () => {
    const result: CliRunResult = {
      ok: false,
      stdout: '',
      error: 'unresolved anchor: module:bar',
      stderr: 'narrate refused: unresolved anchor: module:foo\nunresolved anchor: module:bar\n',
    }
    expect(parseNarrateResult(result)).toEqual({
      ok: false,
      reason: 'narrate refused: unresolved anchor: module:foo\nunresolved anchor: module:bar',
    })
  })

  it('falls back to the truncated error when there is no stderr block (e.g. timeout)', () => {
    const result: CliRunResult = { ok: false, stdout: '', error: 'timed out' }
    expect(parseNarrateResult(result)).toEqual({ ok: false, reason: 'timed out' })
  })

  it('falls back to a generic reason when neither stderr nor error is present', () => {
    const result: CliRunResult = { ok: false, stdout: '' }
    expect(parseNarrateResult(result)).toEqual({ ok: false, reason: 'narrate failed' })
  })
})

// Real chokidar over a temp `flow/` tree — mirrors blueprint-observer.test.ts's
// graphify-landing pattern (generous timeout, a beat before writing so the
// watcher is fully initialized before the write it must observe).
describe('ArtifactObserver (real chokidar)', () => {
  let dir: string
  let observer: ArtifactObserver | null = null
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }

  const BEAT_MS = 500
  const SETTLE_MS = 800

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-obs-'))
  })

  afterEach(async () => {
    await observer?.dispose()
    observer = null
    rmSync(dir, { recursive: true, force: true })
  })

  function collectOne(): Promise<FlowArtifactChangedEvent> {
    return new Promise((resolve) => {
      const off = observer?.on((event) => {
        off?.()
        resolve(event)
      })
    })
  }

  it('emits flow:artifactChanged for a new plan doc', async () => {
    mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
    observer = new ArtifactObserver(roots)
    observer.start()
    const next = collectOne()
    await new Promise((r) => setTimeout(r, BEAT_MS))
    writeFileSync(join(dir, 'flow', 'plans', 'plan_foo_v1.md'), '# Plan Foo\n')

    const event = await next
    expect(event).toEqual({
      rootId: dir,
      kind: 'plan',
      path: 'flow/plans/plan_foo_v1.md',
      name: 'plan_foo_v1.md',
      mtime: expect.any(Number),
      walkthrough: false,
    })
  }, 15_000)

  it('re-emits the DISCOVERY when its walkthrough page lands after the markdown', async () => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
    writeFileSync(join(dir, 'flow', 'discovery', 'discovery_pay_v1.md'), '# Pay\n')
    observer = new ArtifactObserver(roots)
    observer.start()
    await new Promise((r) => setTimeout(r, BEAT_MS))
    const next = collectOne()
    writeFileSync(join(dir, 'flow', 'discovery', 'discovery_pay_v1.walkthrough.html'), '<p>Pay</p>')

    const event = await next
    expect(event.path).toBe('flow/discovery/discovery_pay_v1.md')
    expect(event.walkthrough).toBe(true)
    expect(event.walkthroughMtime).toEqual(expect.any(Number))
  }, 15_000)

  it('re-emits the discovery without the page when the page is removed', async () => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
    const page = join(dir, 'flow', 'discovery', 'discovery_pay_v1.walkthrough.html')
    writeFileSync(join(dir, 'flow', 'discovery', 'discovery_pay_v1.md'), '# Pay\n')
    writeFileSync(page, '<p>Pay</p>')
    observer = new ArtifactObserver(roots)
    observer.start()
    await new Promise((r) => setTimeout(r, BEAT_MS))
    const next = collectOne()
    rmSync(page)

    const event = await next
    expect(event.path).toBe('flow/discovery/discovery_pay_v1.md')
    expect(event.walkthrough).toBe(false)
  }, 15_000)

  // THE HARD MIGRATION repoints `flow` from a vault folder to a Workspace
  // project folder while the app runs. A link replaced by a link is not an
  // event the root watch reliably reports, so main announces it and the
  // watcher follows the new target.
  it('follows a flow/ link repointed into a Workspace once main announces it', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'artifact-vault-'))
    const workspace = mkdtempSync(join(tmpdir(), 'artifact-ws-'))
    try {
      mkdirSync(join(vault, 'flow', 'plans'), { recursive: true })
      mkdirSync(join(workspace, 'project', 'plans'), { recursive: true })
      symlinkSync(join(vault, 'flow'), join(dir, 'flow'))
      observer = new ArtifactObserver(roots)
      observer.start()
      await new Promise((r) => setTimeout(r, BEAT_MS))
      rmSync(join(dir, 'flow'))
      symlinkSync(join(workspace, 'project'), join(dir, 'flow'))
      announceFlowLinksChanged()
      await new Promise((r) => setTimeout(r, BEAT_MS))
      const next = collectOne()
      writeFileSync(join(workspace, 'project', 'plans', 'plan_moved_v1.md'), '# Moved\n')
      const event = await next
      expect(event.path).toBe('flow/plans/plan_moved_v1.md')
    } finally {
      rmSync(vault, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 15_000)

  // A project provisioned into the central vault has `flow/` as a SYMLINK
  // (`<root>/flow -> ~/plan-flow/brain/projects/<p>/flow`). chokidar watching
  // the root never sees writes behind the link, so every card for a project
  // set up that way went silent (found 2026-10-01: no card ever appeared).
  it('emits for a doc written behind a flow/ SYMLINK (vault-linked project)', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'artifact-vault-'))
    try {
      mkdirSync(join(vault, 'flow', 'discovery'), { recursive: true })
      symlinkSync(join(vault, 'flow'), join(dir, 'flow'))
      observer = new ArtifactObserver(roots)
      observer.start()
      await new Promise((r) => setTimeout(r, BEAT_MS))
      const next = collectOne()
      writeFileSync(join(dir, 'flow', 'discovery', 'discovery_vault_v1.md'), '# Vault\n')

      const event = await next
      // Reported under the ROOT's path, exactly as a plain flow/ would be.
      expect(event.rootId).toBe(dir)
      expect(event.path).toBe('flow/discovery/discovery_vault_v1.md')
      expect(event.kind).toBe('discovery')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  }, 15_000)

  it('follows flow/ when it is turned into a symlink AFTER watching began (provisioning)', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'artifact-vault-'))
    try {
      mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
      observer = new ArtifactObserver(roots)
      observer.start()
      await new Promise((r) => setTimeout(r, BEAT_MS))
      // What the vault link does: move the real folder out, leave a link behind.
      renameSync(join(dir, 'flow'), join(vault, 'flow'))
      symlinkSync(join(vault, 'flow'), join(dir, 'flow'))
      await new Promise((r) => setTimeout(r, BEAT_MS))
      const next = collectOne()
      writeFileSync(join(dir, 'flow', 'discovery', 'discovery_late_v1.md'), '# Late\n')

      const event = await next
      expect(event.rootId).toBe(dir)
      expect(event.path).toBe('flow/discovery/discovery_late_v1.md')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  }, 15_000)

  it('does not report docs MOVED behind the link as new writes', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'artifact-vault-'))
    try {
      mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
      writeFileSync(join(dir, 'flow', 'discovery', 'discovery_old_v1.md'), '# Old\n')
      observer = new ArtifactObserver(roots)
      observer.start()
      const seen: string[] = []
      observer.on((event) => seen.push(event.path))
      await new Promise((r) => setTimeout(r, BEAT_MS))
      renameSync(join(dir, 'flow'), join(vault, 'flow'))
      symlinkSync(join(vault, 'flow'), join(dir, 'flow'))
      await new Promise((r) => setTimeout(r, BEAT_MS * 3))
      // State the positive first: a write after the move IS reported…
      const next = collectOne()
      writeFileSync(join(dir, 'flow', 'discovery', 'discovery_new_v1.md'), '# New\n')
      expect((await next).path).toBe('flow/discovery/discovery_new_v1.md')
      // …and the relocated historical doc never was.
      expect(seen).not.toContain('flow/discovery/discovery_old_v1.md')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  }, 15_000)

  it('emits for a discovery doc CHANGE, not just adds', async () => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
    const docPath = join(dir, 'flow', 'discovery', 'discovery_foo_v1.md')
    writeFileSync(docPath, '# Discovery Foo\n')
    observer = new ArtifactObserver(roots)
    observer.start()
    await new Promise((r) => setTimeout(r, BEAT_MS))
    const next = collectOne()
    writeFileSync(docPath, '# Discovery Foo (updated)\n')

    const event = await next
    expect(event.kind).toBe('discovery')
    expect(event.path).toBe('flow/discovery/discovery_foo_v1.md')
  }, 15_000)

  it('fails soft when the artifact subdirs (and flow/ itself) do not exist yet, then picks up files once created', async () => {
    // No flow/ tree at all yet — the watcher roots on `dir` (which always
    // exists), so it must tolerate the whole flow/<subdir> chain appearing later.
    observer = new ArtifactObserver(roots)
    observer.start()
    await new Promise((r) => setTimeout(r, BEAT_MS))

    const next = collectOne()
    mkdirSync(join(dir, 'flow', 'brainstorms'), { recursive: true })
    writeFileSync(join(dir, 'flow', 'brainstorms', 'brainstorm_foo.md'), '# Brainstorm\n')

    const event = await next
    expect(event.kind).toBe('brainstorm')
    expect(event.name).toBe('brainstorm_foo.md')
  }, 15_000)

  it('ignores non-.md files and dotfiles', async () => {
    mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
    observer = new ArtifactObserver(roots)
    observer.start()
    const events: FlowArtifactChangedEvent[] = []
    observer.on((event) => events.push(event))
    await new Promise((r) => setTimeout(r, BEAT_MS))

    writeFileSync(join(dir, 'flow', 'plans', 'notes.txt'), 'not a plan\n')
    writeFileSync(join(dir, 'flow', 'plans', '.DS_Store'), 'junk\n')
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    expect(events).toEqual([])
  }, 15_000)

  it('does not watch flow/archive', async () => {
    mkdirSync(join(dir, 'flow', 'archive'), { recursive: true })
    observer = new ArtifactObserver(roots)
    observer.start()
    const events: FlowArtifactChangedEvent[] = []
    observer.on((event) => events.push(event))
    await new Promise((r) => setTimeout(r, BEAT_MS))

    writeFileSync(join(dir, 'flow', 'archive', 'plan_old_v1.md'), '# Old plan\n')
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    expect(events).toEqual([])
  }, 15_000)
})
