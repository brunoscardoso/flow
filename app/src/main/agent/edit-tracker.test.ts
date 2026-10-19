// EditTracker tests — real temp-dir files per test. The tests simulate the
// ADR-001 sequence: captureApprovedEdit() fires BEFORE the SDK writes, so
// each test writes the predicted content to disk itself (playing the SDK)
// before exercising review-state operations that re-read disk.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { PendingFileChange } from '../../shared/ipc-contract'
import { ALL_HUNKS, EditTracker, PENDING_CHANGES_EVENT } from './edit-tracker'

const THREAD_ID = 'thread-1'

describe('EditTracker', () => {
  let root: string
  let tracker: EditTracker

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-edit-tracker-'))
    tracker = new EditTracker()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  function absPath(relPath: string): string {
    return join(root, relPath)
  }

  async function captureEdit(
    relPath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<void> {
    await tracker.captureApprovedEdit({
      threadId: THREAD_ID,
      projectRoot: root,
      toolName: 'Edit',
      input: {
        file_path: absPath(relPath),
        old_string: oldString,
        new_string: newString,
        ...(replaceAll ? { replace_all: true } : {}),
      },
    })
  }

  /** The one pending change for `relPath`, asserting it exists. */
  function pendingFor(relPath: string): PendingFileChange {
    const changes = tracker.listPendingChanges(root)
    const change = changes.find((entry) => entry.filePath === relPath)
    expect(change).toBeDefined()
    return change as PendingFileChange
  }

  // ── flow/ artifacts are auto-written, never reviewed ─────────────────

  describe('flow/ artifacts skip review', () => {
    it('an Edit under flow/ produces no pending change', async () => {
      mkdirSync(absPath('flow'), { recursive: true })
      writeFileSync(absPath('flow/tasklist.md'), 'a\nb\n', 'utf8')
      await captureEdit('flow/tasklist.md', 'a', 'A')
      writeFileSync(absPath('flow/tasklist.md'), 'A\nb\n', 'utf8') // SDK write
      expect(tracker.listPendingChanges(root)).toHaveLength(0)
    })

    it('a real project file with the same edit IS reviewed', async () => {
      writeFileSync(absPath('src.md'), 'a\nb\n', 'utf8')
      await captureEdit('src.md', 'a', 'A')
      writeFileSync(absPath('src.md'), 'A\nb\n', 'utf8')
      expect(tracker.listPendingChanges(root)).toHaveLength(1)
    })

    it('a sibling dir like flowers/ is still reviewed (no false match)', async () => {
      mkdirSync(absPath('flowers'), { recursive: true })
      writeFileSync(absPath('flowers/notes.md'), 'a\nb\n', 'utf8')
      await captureEdit('flowers/notes.md', 'a', 'A')
      writeFileSync(absPath('flowers/notes.md'), 'A\nb\n', 'utf8')
      expect(tracker.listPendingChanges(root)).toHaveLength(1)
    })

    it('verifyToolResult (bypass-capture path) also skips flow/', async () => {
      mkdirSync(absPath('flow'), { recursive: true })
      writeFileSync(absPath('flow/log.md'), 'y\n', 'utf8') // SDK already wrote
      await tracker.verifyToolResult({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Write',
        input: { file_path: absPath('flow/log.md'), content: 'y\n' },
        response: { originalFile: 'x\n' },
      })
      expect(tracker.listPendingChanges(root)).toHaveLength(0)
    })
  })

  // ── Hunk computation ─────────────────────────────────────────────────

  describe('hunk computation', () => {
    it('a single Edit produces one hunk with exact before/after text', async () => {
      writeFileSync(absPath('a.ts'), 'line1\nline2\nline3\n', 'utf8')
      await captureEdit('a.ts', 'line2', 'LINE2')
      writeFileSync(absPath('a.ts'), 'line1\nLINE2\nline3\n', 'utf8') // SDK write

      const change = pendingFor('a.ts')
      expect(change.threadId).toBe(THREAD_ID)
      expect(change.rootId).toBe(root)
      expect(change.hunks).toHaveLength(1)
      expect(change.hunks[0]).toMatchObject({
        beforeText: 'line2',
        afterText: 'LINE2',
        status: 'pending',
        range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
      })
    })

    it('sequential edits to one file accumulate against the ORIGINAL baseline', async () => {
      writeFileSync(absPath('a.ts'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8')

      await captureEdit('a.ts', 'l2', 'L2')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l4', 'L4')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nL4\nl5\n', 'utf8')

      const change = pendingFor('a.ts')
      expect(change.hunks).toHaveLength(2)
      expect(change.hunks.map((h) => [h.beforeText, h.afterText])).toEqual([
        ['l2', 'L2'],
        ['l4', 'L4'],
      ])
    })

    it('replace_all replaces every occurrence in the prediction', async () => {
      writeFileSync(absPath('a.ts'), 'foo bar\nmiddle\nfoo baz\n', 'utf8')
      await captureEdit('a.ts', 'foo', 'qux', true)
      writeFileSync(absPath('a.ts'), 'qux bar\nmiddle\nqux baz\n', 'utf8')

      const change = pendingFor('a.ts')
      expect(change.hunks).toHaveLength(2)
      expect(change.hunks.map((h) => [h.beforeText, h.afterText])).toEqual([
        ['foo bar', 'qux bar'],
        ['foo baz', 'qux baz'],
      ])
    })

    it('an Edit whose old_string is absent is not tracked (the tool will error)', async () => {
      writeFileSync(absPath('a.ts'), 'line1\n', 'utf8')
      await captureEdit('a.ts', 'no-such-text', 'x')
      expect(tracker.listPendingChanges(root)).toEqual([])
    })

    it('a MultiEdit applies its edits sequentially and IS reviewable (#95)', async () => {
      writeFileSync(absPath('a.ts'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8')
      await tracker.captureApprovedEdit({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'MultiEdit',
        input: {
          file_path: absPath('a.ts'),
          edits: [
            { old_string: 'l2', new_string: 'L2' },
            { old_string: 'l4', new_string: 'L4' },
          ],
        },
      })
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nL4\nl5\n', 'utf8') // SDK write

      const change = pendingFor('a.ts')
      expect(change.hunks.map((h) => [h.beforeText, h.afterText])).toEqual([
        ['l2', 'L2'],
        ['l4', 'L4'],
      ])
    })

    it('a MultiEdit whose later edit sees an earlier edit’s result applies in order', async () => {
      writeFileSync(absPath('a.ts'), 'x\n', 'utf8')
      await tracker.captureApprovedEdit({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'MultiEdit',
        input: {
          file_path: absPath('a.ts'),
          edits: [
            { old_string: 'x', new_string: 'y' },
            { old_string: 'y', new_string: 'z' }, // only matches after the first edit
          ],
        },
      })
      writeFileSync(absPath('a.ts'), 'z\n', 'utf8')

      const change = pendingFor('a.ts')
      expect(change.hunks.map((h) => [h.beforeText, h.afterText])).toEqual([['x', 'z']])
    })

    it('a MultiEdit whose edit cannot apply is not tracked (the tool will error)', async () => {
      writeFileSync(absPath('a.ts'), 'l1\n', 'utf8')
      await tracker.captureApprovedEdit({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'MultiEdit',
        input: {
          file_path: absPath('a.ts'),
          edits: [{ old_string: 'no-such-text', new_string: 'x' }],
        },
      })
      expect(tracker.listPendingChanges(root)).toEqual([])
    })

    it('a Write predicting identical content produces no pending change', async () => {
      writeFileSync(absPath('a.ts'), 'same\n', 'utf8')
      await tracker.captureApprovedEdit({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Write',
        input: { file_path: absPath('a.ts'), content: 'same\n' },
      })
      expect(tracker.listPendingChanges(root)).toEqual([])
    })

    it('ignores non-edit tools', async () => {
      await tracker.captureApprovedEdit({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Bash',
        input: { command: 'rm x' },
      })
      expect(tracker.listPendingChanges(root)).toEqual([])
    })
  })

  // ── Accept / reject ──────────────────────────────────────────────────

  describe('accept', () => {
    it('folds the hunk into the baseline and leaves disk untouched', async () => {
      writeFileSync(absPath('a.ts'), 'line1\nline2\nline3\n', 'utf8')
      await captureEdit('a.ts', 'line2', 'LINE2')
      writeFileSync(absPath('a.ts'), 'line1\nLINE2\nline3\n', 'utf8')

      const hunkId = pendingFor('a.ts').hunks[0].hunkId
      await tracker.resolveHunk({ rootId: root, threadId: THREAD_ID, filePath: 'a.ts', hunkId, action: 'accept' })

      expect(tracker.listPendingChanges(root)).toEqual([])
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe('line1\nLINE2\nline3\n')
    })

    it('accepting one of two hunks leaves only the other pending', async () => {
      writeFileSync(absPath('a.ts'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l2', 'L2')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l4', 'L4')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nL4\nl5\n', 'utf8')

      const first = pendingFor('a.ts').hunks.find((h) => h.beforeText === 'l2')
      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: first!.hunkId,
        action: 'accept',
      })

      const remaining = pendingFor('a.ts').hunks
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ beforeText: 'l4', afterText: 'L4' })
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe('l1\nL2\nl3\nL4\nl5\n')
    })
  })

  describe('reject', () => {
    it('restores the baseline content byte-exact (trailing newline preserved)', async () => {
      const baseline = 'line1\nline2\nline3\n'
      writeFileSync(absPath('a.ts'), baseline, 'utf8')
      await captureEdit('a.ts', 'line2', 'LINE2')
      writeFileSync(absPath('a.ts'), 'line1\nLINE2\nline3\n', 'utf8')

      const hunkId = pendingFor('a.ts').hunks[0].hunkId
      await tracker.resolveHunk({ rootId: root, threadId: THREAD_ID, filePath: 'a.ts', hunkId, action: 'reject' })

      expect(tracker.listPendingChanges(root)).toEqual([])
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(baseline)
    })

    it('restores a no-trailing-newline baseline byte-exact', async () => {
      const baseline = 'alpha\nbeta'
      writeFileSync(absPath('a.ts'), baseline, 'utf8')
      await captureEdit('a.ts', 'beta', 'BETA')
      writeFileSync(absPath('a.ts'), 'alpha\nBETA', 'utf8')

      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
      })
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(baseline)
    })

    it('fully rejecting an agent-created file deletes it from disk', async () => {
      const created = absPath('brand-new.ts')
      expect(existsSync(created)).toBe(false)

      await tracker.captureApprovedEdit({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Write',
        input: { file_path: created, content: 'export const x = 1\n' },
      })
      writeFileSync(created, 'export const x = 1\n', 'utf8') // SDK write

      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'brand-new.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
      })

      expect(existsSync(created)).toBe(false)
      expect(tracker.listPendingChanges(root)).toEqual([])
    })

    it('rejecting a bypass Write that overwrote an existing file does NOT delete it (#108)', async () => {
      // Existing project file the agent overwrites under bypassPermissions —
      // canUseTool is skipped, so only the PostToolUse (verify) path runs, and
      // the SDK Write response carries no originalFile.
      const existing = absPath('config.ts')
      writeFileSync(existing, 'export const original = true\n', 'utf8')
      writeFileSync(existing, 'export const overwritten = true\n', 'utf8') // SDK write
      await tracker.verifyToolResult({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Write',
        input: { file_path: existing, content: 'export const overwritten = true\n' },
        response: {}, // no originalFile — the data-loss trigger
      })

      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'config.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
      })

      // The pre-existing file must survive the reject — never rm'd.
      expect(existsSync(existing)).toBe(true)
    })

    it('throws for an unknown file or unknown hunk id', async () => {
      await expect(
        tracker.resolveHunk({ rootId: root, threadId: THREAD_ID, filePath: 'nope.ts', hunkId: ALL_HUNKS, action: 'accept' }),
      ).rejects.toThrow(/No pending changes/)

      writeFileSync(absPath('a.ts'), 'line1\n', 'utf8')
      await captureEdit('a.ts', 'line1', 'LINE1')
      writeFileSync(absPath('a.ts'), 'LINE1\n', 'utf8')
      await expect(
        tracker.resolveHunk({ rootId: root, threadId: THREAD_ID, filePath: 'a.ts', hunkId: 'bogus', action: 'accept' }),
      ).rejects.toThrow(/Unknown or already-resolved hunk/)
    })
  })

  // LOG-3 regression: resolveHunk is serialized per file — two concurrent
  // rejects must not race read-modify-write and silently lose the first
  // revert (the second call re-reading disk BEFORE the first one wrote).
  describe('concurrent resolution (LOG-3)', () => {
    it('two concurrent rejects on one file both apply — nothing is lost', async () => {
      const baseline = 'l1\nl2\nl3\nl4\nl5\n'
      writeFileSync(absPath('a.ts'), baseline, 'utf8')
      await captureEdit('a.ts', 'l2', 'L2')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l4', 'L4')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nL4\nl5\n', 'utf8')

      const hunks = pendingFor('a.ts').hunks
      expect(hunks).toHaveLength(2)

      // Fire both rejects WITHOUT awaiting the first.
      await Promise.all(
        hunks.map((hunk) =>
          tracker.resolveHunk({
            rootId: root,
            threadId: THREAD_ID,
            filePath: 'a.ts',
            hunkId: hunk.hunkId,
            action: 'reject',
          }),
        ),
      )

      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(baseline)
      expect(tracker.listPendingChanges(root)).toEqual([])
    })

    it('a failed resolve does not wedge the file queue', async () => {
      writeFileSync(absPath('a.ts'), 'one\ntwo\n', 'utf8')
      await captureEdit('a.ts', 'one', 'ONE')
      writeFileSync(absPath('a.ts'), 'ONE\ntwo\n', 'utf8')

      const bogus = tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: 'bogus',
        action: 'accept',
      })
      const valid = tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'accept',
      })

      await expect(bogus).rejects.toThrow(/Unknown or already-resolved hunk/)
      await expect(valid).resolves.toMatchObject({ status: 'resolved' })
      expect(tracker.listPendingChanges(root)).toEqual([])
    })
  })

  describe("'*' bulk resolve", () => {
    it('accepts every pending hunk of the file atomically', async () => {
      writeFileSync(absPath('a.ts'), 'l1\nl2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l2', 'L2')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l4', 'L4')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nL4\nl5\n', 'utf8')
      expect(pendingFor('a.ts').hunks).toHaveLength(2)

      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'accept',
      })

      expect(tracker.listPendingChanges(root)).toEqual([])
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe('l1\nL2\nl3\nL4\nl5\n')
    })

    it('rejects every pending hunk, restoring the original baseline', async () => {
      const baseline = 'l1\nl2\nl3\nl4\nl5\n'
      writeFileSync(absPath('a.ts'), baseline, 'utf8')
      await captureEdit('a.ts', 'l2', 'L2')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nl4\nl5\n', 'utf8')
      await captureEdit('a.ts', 'l4', 'L4')
      writeFileSync(absPath('a.ts'), 'l1\nL2\nl3\nL4\nl5\n', 'utf8')

      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
      })

      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(baseline)
      expect(tracker.listPendingChanges(root)).toEqual([])
    })
  })

  // LOG-4 regression: tracked state is keyed per (threadId, absPath) — with
  // path-only keying, a later thread's edit overwrote threadId and
  // misattributed the whole accumulated diff to the second thread.
  describe('two threads editing one file (LOG-4)', () => {
    const THREAD_B = 'thread-2'
    const ORIGINAL = 'l1\nl2\nl3\nl4\nl5\n'
    const AFTER_A = 'l1\nA2\nl3\nl4\nl5\n'
    const AFTER_A_AND_B = 'l1\nA2\nl3\nB4\nl5\n'

    /** Thread A edits l2, SDK writes; then thread B edits l4, SDK writes. */
    async function editFromBothThreads(): Promise<void> {
      writeFileSync(absPath('a.ts'), ORIGINAL, 'utf8')

      await captureEdit('a.ts', 'l2', 'A2')
      writeFileSync(absPath('a.ts'), AFTER_A, 'utf8') // thread A's SDK write

      // Thread B's capture happens AFTER A's write — its baseline is the
      // post-A disk content, so B's diff contains only B's own change.
      await tracker.captureApprovedEdit({
        threadId: THREAD_B,
        projectRoot: root,
        toolName: 'Edit',
        input: { file_path: absPath('a.ts'), old_string: 'l4', new_string: 'B4' },
      })
      writeFileSync(absPath('a.ts'), AFTER_A_AND_B, 'utf8') // thread B's SDK write
    }

    it('each thread gets its own entry attributing only its own hunks', async () => {
      await editFromBothThreads()

      const changes = tracker.listPendingChanges(root)
      expect(changes).toHaveLength(2)

      const forA = changes.find((change) => change.threadId === THREAD_ID)
      const forB = changes.find((change) => change.threadId === THREAD_B)
      expect(forA).toBeDefined()
      expect(forB).toBeDefined()
      expect(forA!.filePath).toBe('a.ts')
      expect(forB!.filePath).toBe('a.ts')
      expect(forA!.hunks.map((h) => [h.beforeText, h.afterText])).toEqual([['l2', 'A2']])
      expect(forB!.hunks.map((h) => [h.beforeText, h.afterText])).toEqual([['l4', 'B4']])
    })

    it("rejecting thread B's '*' keeps thread A's edit on disk and pending", async () => {
      await editFromBothThreads()

      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_B,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
      })

      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(AFTER_A)
      const remaining = tracker.listPendingChanges(root)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].threadId).toBe(THREAD_ID)
      expect(remaining[0].hunks.map((h) => [h.beforeText, h.afterText])).toEqual([['l2', 'A2']])

      // Rejecting A afterwards restores the original file byte-exact.
      await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
      })
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(ORIGINAL)
      expect(tracker.listPendingChanges(root)).toEqual([])
    })

    it('resolveHunk with a non-owning threadId does not touch another thread entry', async () => {
      await editFromBothThreads()

      await expect(
        tracker.resolveHunk({
          rootId: root,
          threadId: 'thread-3',
          filePath: 'a.ts',
          hunkId: ALL_HUNKS,
          action: 'reject',
        }),
      ).rejects.toThrow(/No pending changes/)

      expect(tracker.listPendingChanges(root)).toHaveLength(2)
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe(AFTER_A_AND_B)
    })

    it("verifyToolResult only re-syncs the reporting thread's entry", async () => {
      await editFromBothThreads()

      // Thread B's PostToolUse fires against a disk that matches B's
      // prediction — neither entry may change.
      await tracker.verifyToolResult({
        threadId: THREAD_B,
        projectRoot: root,
        toolName: 'Edit',
        input: { file_path: absPath('a.ts'), old_string: 'l4', new_string: 'B4' },
        response: {},
      })

      const changes = tracker.listPendingChanges(root)
      expect(changes).toHaveLength(2)
      expect(changes.find((change) => change.threadId === THREAD_ID)!.hunks).toHaveLength(1)
      expect(changes.find((change) => change.threadId === THREAD_B)!.hunks).toHaveLength(1)
    })
  })

  // ── PostToolUse verification (drift + bypass) ────────────────────────

  describe('verifyToolResult', () => {
    it('re-syncs review state from disk when the applied change drifted', async () => {
      writeFileSync(absPath('a.ts'), 'line1\nline2\n', 'utf8')
      await captureEdit('a.ts', 'line2', 'PREDICTED')
      // The SDK actually wrote something else.
      writeFileSync(absPath('a.ts'), 'line1\nACTUAL\n', 'utf8')

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      await tracker.verifyToolResult({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Edit',
        input: { file_path: absPath('a.ts'), old_string: 'line2', new_string: 'PREDICTED' },
        response: {},
      })

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('re-syncing review state'))
      const change = pendingFor('a.ts')
      expect(change.hunks).toHaveLength(1)
      expect(change.hunks[0]).toMatchObject({ beforeText: 'line2', afterText: 'ACTUAL' })
    })

    it('keeps state unchanged when disk matches the prediction', async () => {
      writeFileSync(absPath('a.ts'), 'line1\nline2\n', 'utf8')
      await captureEdit('a.ts', 'line2', 'LINE2')
      writeFileSync(absPath('a.ts'), 'line1\nLINE2\n', 'utf8')
      const before = pendingFor('a.ts')

      await tracker.verifyToolResult({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Edit',
        input: { file_path: absPath('a.ts'), old_string: 'line2', new_string: 'LINE2' },
        response: {},
      })

      expect(pendingFor('a.ts')).toEqual(before)
    })

    it('captures an edit that bypassed canUseTool, using the SDK originalFile record', async () => {
      // No captureApprovedEdit happened — only the post-hook fires.
      writeFileSync(absPath('a.ts'), 'line1\nCHANGED\n', 'utf8')

      await tracker.verifyToolResult({
        threadId: THREAD_ID,
        projectRoot: root,
        toolName: 'Edit',
        input: { file_path: absPath('a.ts'), old_string: 'line2', new_string: 'CHANGED' },
        response: { originalFile: 'line1\nline2\n' },
      })

      const change = pendingFor('a.ts')
      expect(change.hunks).toHaveLength(1)
      expect(change.hunks[0]).toMatchObject({ beforeText: 'line2', afterText: 'CHANGED' })
    })
  })

  // ── Path mapping & misc ──────────────────────────────────────────────

  it('maps absolute paths to root-relative filePaths with forward slashes', async () => {
    mkdirSync(absPath(join('sub', 'dir')), { recursive: true })
    const nested = absPath(join('sub', 'dir', 'file.ts'))
    writeFileSync(nested, 'one\n', 'utf8')
    await captureEdit(join('sub', 'dir', 'file.ts'), 'one', 'ONE')
    writeFileSync(nested, 'ONE\n', 'utf8')

    const changes = tracker.listPendingChanges(root)
    expect(changes).toHaveLength(1)
    expect(changes[0].filePath).toBe('sub/dir/file.ts')
  })

  it('scopes listPendingChanges by rootId', async () => {
    writeFileSync(absPath('a.ts'), 'one\n', 'utf8')
    await captureEdit('a.ts', 'one', 'ONE')
    writeFileSync(absPath('a.ts'), 'ONE\n', 'utf8')

    expect(tracker.listPendingChanges(root)).toHaveLength(1)
    expect(tracker.listPendingChanges('/some/other/root')).toEqual([])
    expect(tracker.listPendingChanges()).toHaveLength(1)
  })

  it('emits pending-changes events on capture and on resolve', async () => {
    const emissions: PendingFileChange[][] = []
    tracker.on(PENDING_CHANGES_EVENT, (changes: PendingFileChange[]) => emissions.push(changes))

    writeFileSync(absPath('a.ts'), 'one\n', 'utf8')
    await captureEdit('a.ts', 'one', 'ONE')
    writeFileSync(absPath('a.ts'), 'ONE\n', 'utf8')
    expect(emissions).toHaveLength(1)
    expect(emissions[0][0].filePath).toBe('a.ts')

    await tracker.resolveHunk({ rootId: root, threadId: THREAD_ID, filePath: 'a.ts', hunkId: ALL_HUNKS, action: 'accept' })
    expect(emissions).toHaveLength(2)
    expect(emissions[1]).toEqual([])
  })

  it('clear() discards review state without touching disk', async () => {
    writeFileSync(absPath('a.ts'), 'one\n', 'utf8')
    await captureEdit('a.ts', 'one', 'ONE')
    writeFileSync(absPath('a.ts'), 'ONE\n', 'utf8')

    tracker.clear()
    expect(tracker.listPendingChanges(root)).toEqual([])
    expect(readFileSync(absPath('a.ts'), 'utf8')).toBe('ONE\n')
  })
  describe('reconcileWithGit (#893)', () => {
    /** Seed one pending edit: a.ts baseline 'ONE' → agent wrote 'TWO'. */
    async function seedPending(relPath = 'a.ts'): Promise<void> {
      writeFileSync(absPath(relPath), 'ONE\n')
      await captureEdit(relPath, 'ONE', 'TWO')
      writeFileSync(absPath(relPath), 'TWO\n') // the SDK's write landing
      expect(tracker.listPendingChanges(root)).toHaveLength(1)
    }

    it('REPRO: without reconciliation a committed file kept stale pending hunks', async () => {
      // The reported bug: everything committed/pushed (file clean in git),
      // strip still offering Accept/Reject. Reconcile resolves it as accepted.
      await seedPending()
      await tracker.reconcileWithGit(root, []) // clean tree — file absent
      expect(tracker.listPendingChanges(root)).toHaveLength(0)
      // Disk untouched — accept folds the baseline, never rewrites the file.
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe('TWO\n')
    })

    it('fully staged file (approval IS staging, #857) settles as accepted', async () => {
      await seedPending()
      await tracker.reconcileWithGit(root, [
        { filePath: 'a.ts', staged: true, worktreeState: null },
      ])
      expect(tracker.listPendingChanges(root)).toHaveLength(0)
      expect(readFileSync(absPath('a.ts'), 'utf8')).toBe('TWO\n')
    })

    it('unstaged dirty file stays pending', async () => {
      await seedPending()
      await tracker.reconcileWithGit(root, [
        { filePath: 'a.ts', staged: false, worktreeState: 'modified' },
      ])
      expect(tracker.listPendingChanges(root)).toHaveLength(1)
    })

    it('staged-then-re-edited file stays pending (worktree still dirty)', async () => {
      await seedPending()
      await tracker.reconcileWithGit(root, [
        { filePath: 'a.ts', staged: true, worktreeState: 'modified' },
      ])
      expect(tracker.listPendingChanges(root)).toHaveLength(1)
    })

    it('only reconciles the matching root and broadcasts once', async () => {
      await seedPending()
      const events: unknown[] = []
      tracker.on(PENDING_CHANGES_EVENT, (payload) => events.push(payload))
      await tracker.reconcileWithGit('/some/other/root', [])
      expect(tracker.listPendingChanges(root)).toHaveLength(1)
      expect(events).toHaveLength(0)
      await tracker.reconcileWithGit(root, [])
      expect(events).toHaveLength(1)
      expect(tracker.listPendingChanges(root)).toHaveLength(0)
    })
  })

  // #1290: rejecting an agent's ONE hunk destroyed the user's own saved edits
  // too. resolveHunkSerialized re-reads disk ("unreviewed drift joins THIS
  // entry's diff"), so by click time the hunk set is {your line, the agent's}
  // and ALL_HUNKS reverts both — with no confirm, and under a strip that still
  // said "1 pending hunk in 1 file". The lost line was never committed, so it
  // was unrecoverable.
  describe('resolve scope guard (#1290)', () => {
    /** An agent edit mid-file, then the user adding and saving their own line
     *  far enough away to be its own hunk (adjacent edits coalesce into one). */
    const BASE = ['l1', 'l2', 'l3', "const prefix = 'alpha'", 'l5', 'l6', 'l7'].join('\n') + '\n'
    const AGENT = BASE.replace('alpha', 'omega')
    const AGENT_PLUS_USER = `${AGENT}const USER_TYPED = 'do-not-lose-me'\n`

    async function agentEditPlusUserDrift(): Promise<void> {
      writeFileSync(absPath('a.ts'), BASE, 'utf8')
      await captureEdit('a.ts', 'alpha', 'omega')
      writeFileSync(absPath('a.ts'), AGENT, 'utf8')
      // The user types their own line at the END and saves — after the review
      // was broadcast, so the strip still says "1 pending hunk".
      writeFileSync(absPath('a.ts'), AGENT_PLUS_USER, 'utf8')
    }

    it('refuses a whole-file reject that would cover more than the caller saw', async () => {
      await agentEditPlusUserDrift()
      const outcome = await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
        expectedHunks: 1, // what the strip was showing
      })
      expect(outcome).toMatchObject({ status: 'scope-changed', expected: 1 })
      expect((outcome as { hunks: number }).hunks).toBeGreaterThan(1)
      // NOTHING was written — the user's line is still on disk.
      expect(readFileSync(absPath('a.ts'), 'utf8')).toContain('do-not-lose-me')
    })

    it('proceeds once the caller confirms the wider scope', async () => {
      await agentEditPlusUserDrift()
      const outcome = await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
        // No expectedHunks — the confirmed re-issue.
      })
      expect(outcome).toMatchObject({ status: 'resolved' })
      expect(readFileSync(absPath('a.ts'), 'utf8')).toContain('alpha')
    })

    it('does not interfere when the file has NOT drifted', async () => {
      writeFileSync(absPath('a.ts'), BASE, 'utf8')
      await captureEdit('a.ts', 'alpha', 'omega')
      writeFileSync(absPath('a.ts'), AGENT, 'utf8')
      const outcome = await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'reject',
        expectedHunks: 1,
      })
      expect(outcome).toMatchObject({ status: 'resolved', hunks: 1 })
      expect(readFileSync(absPath('a.ts'), 'utf8')).toContain('alpha')
    })

    it('leaves callers that pass no expectation exactly as they were', async () => {
      // Backward compatible: omitting expectedHunks is the pre-#1290 behaviour.
      await agentEditPlusUserDrift()
      const outcome = await tracker.resolveHunk({
        rootId: root,
        threadId: THREAD_ID,
        filePath: 'a.ts',
        hunkId: ALL_HUNKS,
        action: 'accept',
      })
      expect(outcome).toMatchObject({ status: 'resolved' })
    })
  })
})
