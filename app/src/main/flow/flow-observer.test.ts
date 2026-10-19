// FlowObserver write-path tests — the `.flowconfig` merge helper (pure), the
// setConfig method (temp-dir round-trip), and respondPrompt's stale-reply
// refusal (#1004). Guards the contracts behind the `flow:setConfig` and
// `flow:respondPrompt` IPC channels.

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { FlowObserver, mergeFlowconfigText, parseFlowconfigText } from './flow-observer'

describe('mergeFlowconfigText', () => {
  it('rewrites existing keys in place and preserves comments/order', () => {
    const existing = '# git control\nautopilot: false\npush: true\n'
    const merged = mergeFlowconfigText(existing, { autopilot: 'true' })
    expect(merged).toBe('# git control\nautopilot: true\npush: true\n')
  })

  it('appends unknown keys and is newline-terminated', () => {
    const merged = mergeFlowconfigText('autopilot: false\n', { push: 'true' })
    expect(merged).toBe('autopilot: false\npush: true\n')
  })

  it('creates a body from empty input', () => {
    expect(mergeFlowconfigText('', { autopilot: 'true' })).toBe('autopilot: true\n')
  })

  it('does not accumulate blank lines across merges', () => {
    let body = ''
    body = mergeFlowconfigText(body, { a: '1' })
    body = mergeFlowconfigText(body, { b: '2' })
    body = mergeFlowconfigText(body, { a: '3' })
    expect(body).toBe('a: 3\nb: 2\n')
  })
})

describe('FlowObserver.setConfig', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-observer-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const emptyRoots = { getRoots: () => [], onRootsChanged: () => () => {} }

  it('creates flow/.flowconfig when missing and writes updates', async () => {
    const observer = new FlowObserver(emptyRoots)
    await observer.setConfig(root, { autopilot: 'true', push: 'true' })
    const written = readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8')
    expect(parseFlowconfigText(written)).toMatchObject({ autopilot: 'true', push: 'true' })
    await observer.dispose()
  })

  it('merges into an existing config non-destructively', async () => {
    const flowDir = join(root, 'flow')
    mkdirSync(flowDir, { recursive: true })
    writeFileSync(join(flowDir, '.flowconfig'), '# header\nmodel_routing: true\nautopilot: false\n')
    const observer = new FlowObserver(emptyRoots)
    await observer.setConfig(root, { autopilot: 'true' })
    const written = readFileSync(join(flowDir, '.flowconfig'), 'utf-8')
    expect(written).toContain('# header')
    expect(parseFlowconfigText(written)).toMatchObject({
      model_routing: 'true',
      autopilot: 'true',
    })
    await observer.dispose()
  })

  it('is a no-op for empty updates', async () => {
    const observer = new FlowObserver(emptyRoots)
    await observer.setConfig(root, {})
    expect(() => readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8')).toThrow()
    await observer.dispose()
  })

  // #1452 — this is a read-modify-write over the WHOLE file. Unserialized, two
  // overlapping calls both read the same snapshot and the second silently
  // dropped the first's key. The settings panel produces exactly that pair on
  // one ordinary click: its text inputs commit on blur, so clicking any control
  // after typing fires the blur-commit and the click-commit microseconds apart.
  describe('concurrent writes (#1452)', () => {
    it('keeps BOTH keys when two calls overlap', async () => {
      const observer = new FlowObserver(emptyRoots)
      await Promise.all([
        observer.setConfig(root, { branch: 'release/2.0' }),
        observer.setConfig(root, { autopilot: 'true' }),
      ])
      const written = readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8')
      expect(parseFlowconfigText(written)).toMatchObject({
        branch: 'release/2.0',
        autopilot: 'true',
      })
      await observer.dispose()
    })

    it('keeps every key across a burst, in issue order', async () => {
      const observer = new FlowObserver(emptyRoots)
      await Promise.all([
        observer.setConfig(root, { a: '1' }),
        observer.setConfig(root, { b: '2' }),
        observer.setConfig(root, { c: '3' }),
        observer.setConfig(root, { d: '4' }),
        observer.setConfig(root, { a: '5' }), // last writer of `a` wins
      ])
      const parsed = parseFlowconfigText(readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8'))
      expect(parsed).toMatchObject({ a: '5', b: '2', c: '3', d: '4' })
      await observer.dispose()
    })

    it('never leaves a torn file — every read is a whole config', async () => {
      const observer = new FlowObserver(emptyRoots)
      const configPath = join(root, 'flow', '.flowconfig')
      await observer.setConfig(root, { seed: 'true' })
      const writes = Array.from({ length: 12 }, (_, i) =>
        observer.setConfig(root, { [`key${i}`]: `value-${i}`.repeat(40) }),
      )
      // Sample mid-flight: the atomic rename means a reader sees the old file or
      // the new one, never a half-rewritten one.
      const samples: string[] = []
      for (let i = 0; i < 12; i += 1) {
        try {
          samples.push(readFileSync(configPath, 'utf-8'))
        } catch {
          /* between rename calls the path always exists; a miss is not a tear */
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await Promise.all(writes)
      for (const sample of samples) {
        // A torn write shows up as a line that is neither `key: value` nor a
        // comment — the observed corruption was a trailing fragment (`e`).
        for (const line of sample.split('\n').filter((l) => l.trim() !== '')) {
          expect(line).toMatch(/^\s*(#|[A-Za-z_][\w.]*\s*:)/)
        }
      }
      const parsed = parseFlowconfigText(readFileSync(configPath, 'utf-8'))
      expect(parsed).toMatchObject({ seed: 'true', key0: 'value-0'.repeat(40) })
      await observer.dispose()
    })

    it('a failed write does not poison the writes queued behind it', async () => {
      const observer = new FlowObserver(emptyRoots)
      // A path whose `flow` is a FILE — mkdir fails, so this write rejects.
      const blocked = mkdtempSync(join(tmpdir(), 'flow-observer-blocked-'))
      writeFileSync(join(blocked, 'flow'), 'not a directory')
      await expect(observer.setConfig(blocked, { a: '1' })).rejects.toThrow()
      // The SAME root must still be writable afterwards (different root here is
      // trivially fine; the queue is per-root, so re-use the broken one's peer).
      await observer.setConfig(root, { after: 'true' })
      expect(parseFlowconfigText(readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8'))).
        toMatchObject({ after: 'true' })
      rmSync(blocked, { recursive: true, force: true })
      await observer.dispose()
    })
  })
})

describe('FlowObserver.respondPrompt', () => {
  let root: string
  let promptPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-observer-'))
    mkdirSync(join(root, 'flow'), { recursive: true })
    promptPath = join(root, 'flow', '.heartbeat-prompt.md')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const emptyRoots = { getRoots: () => [], onRootsChanged: () => () => {} }
  const archiveDir = () => join(root, 'flow', 'archive', 'heartbeat-prompts')
  const currentPromptId = () => `hb-${Math.trunc(statSync(promptPath).mtimeMs)}`

  it('archives the reply and unlinks the prompt when the promptId matches', async () => {
    writeFileSync(promptPath, '**Task**: deploy-check\n\nApprove the migration?\n', 'utf-8')
    const observer = new FlowObserver(emptyRoots)
    await observer.respondPrompt(root, currentPromptId(), 'yes, approved')

    expect(existsSync(promptPath)).toBe(false)
    const archived = readdirSync(archiveDir())
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/^prompt_deploy-check_/)
    const body = readFileSync(join(archiveDir(), archived[0]), 'utf-8')
    expect(body).toContain('yes, approved')
    await observer.dispose()
  })

  it('refuses a reply whose promptId no longer matches the pending prompt (#1004)', async () => {
    // The question the user typed their answer for…
    writeFileSync(promptPath, '**Task**: deploy-check\n\nApprove the migration?\n', 'utf-8')
    const staleId = currentPromptId()
    // …swapped underneath them by a second blocked task (new mtime → new id).
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(promptPath, '**Task**: db-drop\n\nDROP the production database?\n', 'utf-8')
    expect(currentPromptId()).not.toBe(staleId)

    const observer = new FlowObserver(emptyRoots)
    await expect(observer.respondPrompt(root, staleId, 'yes, approved')).rejects.toThrow(
      /changed its question/,
    )

    // The never-seen question survives (unlinking it is what resumes the
    // daemon), and no stray archive records the undelivered answer.
    expect(existsSync(promptPath)).toBe(true)
    expect(readFileSync(promptPath, 'utf-8')).toContain('db-drop')
    expect(existsSync(archiveDir()) ? readdirSync(archiveDir()) : []).toEqual([])
    await observer.dispose()
  })
})

// ── #1164: the flow/ watch survives the directory being created or replaced ──
//
// project:add registers the root (arming the watch) and THEN
// fire-and-forgets provisioning, which runs `planflow-ai init --force` and
// creates/replaces the flow vault symlink. The watcher was left bound to the
// old (or absent) path, so a project added during the session never produced
// another flow/ event: the status line froze and a blocked task raised nothing.
//
// Measured on this platform: the ABSENT-then-created case is the one that
// regresses (chokidar never picks up a path that did not exist when the watch
// armed) — which is exactly the onboarding path, a project with no flow/ yet.
// The REPLACE case passes even without the fix here, because inotify
// re-attaches on recreate; it is kept as a guard because fsevents (macOS, where
// this was reported) does not necessarily behave the same.

describe('FlowObserver root re-arm (#1164)', () => {
  const observers: FlowObserver[] = []
  const dirs: string[] = []

  afterEach(() => {
    for (const observer of observers.splice(0)) observer.dispose()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Wait for `predicate` to hold, polling — chokidar is inherently async. */
  /**
   * Wait for the watcher, with room for how slow it can be on this platform.
   *
   * These tests are the one place that depends on fsevents delivering a change
   * for a directory under `/var/folders`, which is this repo's known-unreliable
   * corner. Under a full parallel suite — 540 suites competing for the same
   * disk — it is the DELIVERY that runs late, not the watcher: every one of
   * these passes in isolation, every time.
   *
   * Raised twice. 8s failed under load; 20s failed under load on a different
   * test in the same file, which is the tell that the number was still being
   * chosen against a quiet machine. 60s, inside a 90s per-test deadline.
   *
   * This does not mask a broken watcher. A watcher that never fires still
   * fails — it just takes a minute to say so, which is the correct trade for a
   * signal that is otherwise noise.
   */
  async function until(predicate: () => boolean, timeoutMs = 60000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return predicate()
  }

  async function startObserver(rootPath: string): Promise<FlowObserver> {
    const observer = new FlowObserver({
      getRoots: () => [{ rootPath }],
      onRootsChanged: () => () => undefined,
    })
    observers.push(observer)
    observer.start()
    // Let chokidar finish its initial scan — an event fired before the watcher
    // is ready is simply never delivered, which would test the harness rather
    // than the fix. (In the real flow, provisioning takes seconds.)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return observer
  }

  it('observes state changes in a flow/ created AFTER the watch armed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-observer-late-'))
    dirs.push(root)

    // Armed with no flow/ at all — the runtime-add shape before provisioning.
    const observer = await startObserver(root)
    let states = 0
    observer.on('state-changed', () => {
      states += 1
    })

    // Provisioning lands.
    mkdirSync(join(root, 'flow'), { recursive: true })
    writeFileSync(join(root, 'flow', 'STATE.md'), '- **Current Phase**: Phase 1\n')
    expect(await until(() => states > 0)).toBe(true)

    // …and a later phase advance is observed, which is the symptom users saw.
    const before = states
    writeFileSync(join(root, 'flow', 'STATE.md'), '- **Current Phase**: Phase 2\n')
    expect(await until(() => states > before)).toBe(true)
    expect(observer.getState(root).activePhase).toBe('Phase 2')
  }, 90000)

  it('re-arms when flow/ is REPLACED under it (init --force)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-observer-replaced-'))
    dirs.push(root)
    mkdirSync(join(root, 'flow'), { recursive: true })
    writeFileSync(join(root, 'flow', 'STATE.md'), '- **Current Phase**: Phase 1\n')

    const observer = await startObserver(root)
    let states = 0
    observer.on('state-changed', () => {
      states += 1
    })

    // What `planflow-ai init --force` does to the directory being watched.
    rmSync(join(root, 'flow'), { recursive: true, force: true })
    mkdirSync(join(root, 'flow'), { recursive: true })
    writeFileSync(join(root, 'flow', 'STATE.md'), '- **Current Phase**: Phase 3\n')

    expect(await until(() => observer.getState(root).activePhase === 'Phase 3')).toBe(true)

    // The watch is live on the NEW directory, not the destroyed inode.
    const before = states
    writeFileSync(join(root, 'flow', 'STATE.md'), '- **Current Phase**: Phase 4\n')
    expect(await until(() => states > before)).toBe(true)
    expect(observer.getState(root).activePhase).toBe('Phase 4')
  }, 90000)
})

describe('FlowObserver.dispose closes EVERY watcher (#1284)', () => {
  // Flow stopped quitting: with a project open, ⌘Q closed the window and left
  // the process running (measured alive 26 minutes later; the whole E2E suite
  // went red on teardown). #1241 added a second persistent chokidar watcher
  // per root — the one that re-arms the flow/ watch after provisioning — and
  // dispose() closed only the first. A persistent watcher holds the libuv
  // event loop, so the process outlived its own window.
  it('closes the flow/ watcher AND the root watcher (#1241’s second watcher)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-observer-dispose-'))
    mkdirSync(join(dir, 'flow'), { recursive: true })
    try {
      const observer = new FlowObserver({
        getRoots: () => [{ rootPath: dir, name: 'probe' }],
        onRootsChanged: () => () => {},
      } as unknown as ConstructorParameters<typeof FlowObserver>[0])
      observer.start() // watchers only exist once watching has started
      // Reach the private watch table: the leak is invisible from outside, and
      // the regression it caused (a process that will not exit) cannot be
      // asserted from inside a jest worker.
      const watches = (observer as unknown as {
        watches: Map<string, { watcher: { closed: boolean }; rootWatcher: { closed: boolean } }>
      }).watches
      const entry = watches.get(dir)
      expect(entry).toBeDefined() // the root is being watched
      expect(entry?.watcher.closed).toBe(false)
      expect(entry?.rootWatcher.closed).toBe(false)

      await observer.dispose()

      expect(entry?.watcher.closed).toBe(true)
      // The one that was leaked.
      expect(entry?.rootWatcher.closed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays safe to call twice', async () => {
    const observer = new FlowObserver({ getRoots: () => [], onRootsChanged: () => () => {} })
    await observer.dispose()
    await expect(observer.dispose()).resolves.toBeUndefined()
  })
})
