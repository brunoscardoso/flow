// task-service tests — creation coordination + the decoupled lane/seed hook
// factories, against real stores (real DB) with a fake IntegrationsManager.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { TaskStore } from '../store/task-store'
import type { IntegrationsManager } from '../integrations/integrations-manager'
import type { NormalizedIssue } from '../issue-ref'
// The BOARD's key builder, imported on purpose: the claim → run-record join is
// only true if both sides produce the same string, and asserting a literal on
// each side would let them drift apart while both tests stayed green.
import { queueItemExternalKey } from '../../renderer/tasks/board-model'
import {
  applyTaskUpdate,
  createManualTask,
  createTaskFromIssue,
  createTaskFromQueueItem,
  ensureTaskThread,
  generateTaskBrief,
  buildBriefPrompt,
  taskHasBriefContent,
  makeSeedProvider,
  makeOnTurnStart,
  makeOnTurnComplete,
  syncTaskTitleFromThread,
  type ApplyTaskUpdateDeps,
} from './task-service'
import { briefOnActivation } from './brief-on-activation'

const ROOT = '/tmp/proj'

function fakeIntegrations(issue: NormalizedIssue): IntegrationsManager {
  return { fetchIssue: async () => issue } as unknown as IntegrationsManager
}

describe('task-service', () => {
  let tempDir: string
  let db: FlowDatabase
  let taskStore: TaskStore
  let threadStore: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-task-svc-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    taskStore = new TaskStore(db)
    threadStore = new ThreadStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('createManualTask creates a task + its 1:1 thread', () => {
    const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Refactor' })
    expect(task.source).toBe('manual')
    expect(task.threadId).not.toBeNull()
    expect(threadStore.getThread(task.threadId!)).not.toBeNull()
  })

  it('createManualTask seeds the spawned thread with additional context roots (#695)', () => {
    const task = createManualTask(
      { taskStore, threadStore },
      { projectRoot: ROOT, title: 'Cross-repo', additionalRoots: ['/tmp/other-a', '/tmp/other-b'] },
    )
    expect(threadStore.getThreadRoots(task.threadId!)).toEqual(['/tmp/other-a', '/tmp/other-b'])
  })

  it('createManualTask without additionalRoots leaves the thread single-root', () => {
    const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Solo' })
    expect(threadStore.getThreadRoots(task.threadId!)).toEqual([])
  })

  // A "from scratch" task is created titleless and named from its opening
  // message via the thread auto-titler, which writes the thread store directly.
  // Without this mirror the card stayed "Untitled task" forever.
  describe('syncTaskTitleFromThread', () => {
    it('mirrors an auto-generated thread title onto the owning task', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: '' })
      // The auto-titler names the thread directly, bypassing the task.
      threadStore.updateThread(task.threadId!, { title: 'Fix discovery view' })
      syncTaskTitleFromThread({ taskStore }, task.threadId!, 'Fix discovery view')
      expect(taskStore.getTask(task.id)?.title).toBe('Fix discovery view')
    })

    it('does not touch the task when the title is unchanged', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Same' })
      const before = taskStore.getTask(task.id)!.updatedAt
      syncTaskTitleFromThread({ taskStore }, task.threadId!, 'Same')
      expect(taskStore.getTask(task.id)?.updatedAt).toBe(before)
    })

    it('is a no-op for a thread that owns no task', () => {
      const bare = threadStore.createThread({ projectRoot: ROOT, title: '' })
      expect(() => syncTaskTitleFromThread({ taskStore }, bare.id, 'Anything')).not.toThrow()
    })
  })

  // #1061 — deleting a task's 1:1 chat (reachable from the sidebar's search,
  // which flattens task threads into ordinary rows) left the task alive with a
  // null thread_id and no way to ever attach another one.
  describe('ensureTaskThread (#1061)', () => {
    it('is a no-op for a task whose thread is intact', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Ship it' })
      const ensured = ensureTaskThread({ taskStore, threadStore }, task.id)
      expect(ensured.threadId).toBe(task.threadId)
      expect(threadStore.listThreads(ROOT)).toHaveLength(1)
    })

    it('attaches a fresh thread to a task whose chat was deleted', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Ship it' })
      const original = task.threadId!
      taskStore.clearThread(original)
      threadStore.deleteThread(original)
      expect(taskStore.getTask(task.id)?.threadId).toBeNull()

      const ensured = ensureTaskThread({ taskStore, threadStore }, task.id)

      expect(ensured.threadId).not.toBeNull()
      expect(ensured.threadId).not.toBe(original)
      // Persisted, not just returned — the next open finds it too.
      expect(taskStore.getTask(task.id)?.threadId).toBe(ensured.threadId)
      const thread = threadStore.getThread(ensured.threadId!)
      expect(thread?.projectRoot).toBe(ROOT)
      expect(thread?.title).toBe('Ship it')
    })

    it('recovers from the raw FK path too, with no explicit unlink', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Ship it' })
      const original = task.threadId!
      // tasks.thread_id is `REFERENCES threads(id) ON DELETE SET NULL`, so the
      // column can never dangle: deleting the thread alone already nulls it.
      // (Linking a dead id is refused outright by the same FK — asserted below —
      // which is why the null branch is the only reachable orphan shape.)
      threadStore.deleteThread(original)
      expect(taskStore.getTask(task.id)?.threadId).toBeNull()
      expect(() => taskStore.linkThread(task.id, original)).toThrow(/FOREIGN KEY/)

      const ensured = ensureTaskThread({ taskStore, threadStore }, task.id)

      expect(ensured.threadId).not.toBe(original)
      expect(threadStore.getThread(ensured.threadId!)).not.toBeNull()
    })

    it('throws for a task that no longer exists', () => {
      expect(() => ensureTaskThread({ taskStore, threadStore }, 'nope')).toThrow(/no longer exists/)
    })
  })

  it('createTaskFromIssue fetches, seeds description, and links a thread', async () => {
    const issue: NormalizedIssue = {
      key: 'o/r#5',
      title: 'Bug',
      description: 'the bug',
      status: 'open',
      url: 'https://github.com/o/r/issues/5',
    }
    const { task, created } = await createTaskFromIssue(
      { taskStore, threadStore, integrations: fakeIntegrations(issue) },
      { projectRoot: ROOT, keyOrUrl: 'o/r#5' },
    )
    expect(created).toBe(true)
    // Title is prefixed with the issue code (#5 for a GitHub issue); the stored
    // externalKey stays the full dedup key.
    expect(task).toMatchObject({ source: 'github', externalKey: 'o/r#5', description: 'the bug' })
    expect(task.title).toBe('#5: Bug')
    expect(threadStore.getThread(task.threadId!)?.title).toBe('#5: Bug')
  })

  it('createTaskFromIssue prefixes a Jira task title with the ticket key', async () => {
    const issue: NormalizedIssue = {
      key: 'ACME-2109',
      title: 'Duplicate inserts into tenant_users',
      description: 'race',
      status: 'open',
      url: 'https://x.atlassian.net/browse/ACME-2109',
    }
    const { task } = await createTaskFromIssue(
      { taskStore, threadStore, integrations: fakeIntegrations(issue) },
      { projectRoot: ROOT, keyOrUrl: 'ACME-2109' },
    )
    expect(task.title).toBe('ACME-2109: Duplicate inserts into tenant_users')
  })

  it('createTaskFromIssue seeds the spawned thread with additional context roots (#1694)', async () => {
    const issue: NormalizedIssue = {
      key: 'o/r#9',
      title: 'Cross-repo bug',
      description: 'spans two repos',
      status: 'open',
      url: 'https://github.com/o/r/issues/9',
    }
    const { task } = await createTaskFromIssue(
      { taskStore, threadStore, integrations: fakeIntegrations(issue) },
      { projectRoot: ROOT, keyOrUrl: 'o/r#9', additionalRoots: ['/tmp/other-a', '/tmp/other-b'] },
    )
    expect(threadStore.getThreadRoots(task.threadId!)).toEqual(['/tmp/other-a', '/tmp/other-b'])
  })

  it('createTaskFromIssue without additionalRoots leaves the thread single-root', async () => {
    const issue: NormalizedIssue = {
      key: 'o/r#10',
      title: 'Solo import',
      description: 'x',
      status: 'open',
      url: 'u',
    }
    const { task } = await createTaskFromIssue(
      { taskStore, threadStore, integrations: fakeIntegrations(issue) },
      { projectRoot: ROOT, keyOrUrl: 'o/r#10' },
    )
    expect(threadStore.getThreadRoots(task.threadId!)).toEqual([])
  })

  it('createTaskFromIssue dedup keeps the existing thread roots untouched (#1694)', async () => {
    const issue: NormalizedIssue = {
      key: 'o/r#11',
      title: 'Re-import',
      description: 'x',
      status: 'open',
      url: 'u',
    }
    const deps = { taskStore, threadStore, integrations: fakeIntegrations(issue) }
    const first = await createTaskFromIssue(deps, { projectRoot: ROOT, keyOrUrl: 'o/r#11' })
    // additionalRoots is a creation-time seed: a dedup re-import with folders
    // checked must not mutate the existing task's thread.
    const second = await createTaskFromIssue(deps, {
      projectRoot: ROOT,
      keyOrUrl: 'o/r#11',
      additionalRoots: ['/tmp/late-add'],
    })
    expect(second.created).toBe(false)
    expect(threadStore.getThreadRoots(first.task.threadId!)).toEqual([])
  })

  it('createTaskFromIssue dedups a re-import (created=false, no new thread)', async () => {
    const issue: NormalizedIssue = {
      key: 'o/r#5',
      title: 'Bug',
      description: 'x',
      status: 'open',
      url: 'u',
    }
    const deps = { taskStore, threadStore, integrations: fakeIntegrations(issue) }
    const first = await createTaskFromIssue(deps, { projectRoot: ROOT, keyOrUrl: 'o/r#5' })
    const second = await createTaskFromIssue(deps, { projectRoot: ROOT, keyOrUrl: 'o/r#5' })
    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
    expect(threadStore.listThreads(ROOT)).toHaveLength(1)
  })

  // ── The run record a claimed queue item materializes into ────────────────
  //
  // loops-on-the-board, Task 6.6 / D3. The board claims through `loop claim`
  // and then materializes the local record HERE — through the importer, not
  // through a second creation path — because the two sides already agree on one
  // string: `queueItemExternalKey(location, id)` builds `owner/repo#123`, which
  // is exactly what `parseIssueRef` produces and what the importer stores. That
  // agreement is what makes a claimed item and its record the same card, and it
  // is what these tests are really guarding.
  describe('a claimed queue item’s run record (loops-on-the-board, D3)', () => {
    const ISSUE: NormalizedIssue = {
      key: 'dev/plan-flow#1533',
      title: 'code map refactor',
      description: 'the finding',
      status: 'open',
      url: 'https://github.com/dev/plan-flow/issues/1533',
    }

    it('materializes a task + its 1:1 thread under the key the board joins on', async () => {
      // The board's own key builder, called with what `loop list` reported.
      const joinKey = queueItemExternalKey('dev/plan-flow', '1533')
      expect(joinKey).toBe(ISSUE.key)

      const { task, created } = await createTaskFromIssue(
        { taskStore, threadStore, integrations: fakeIntegrations(ISSUE) },
        { projectRoot: ROOT, keyOrUrl: joinKey! },
      )

      expect(created).toBe(true)
      expect(task.externalKey).toBe(joinKey)
      expect(task.source).toBe('github')
      // The thread IS the run's evidence slot: the transcript, the tool calls
      // and whatever the run produced all hang off it, and the task's brief is
      // generated against the same record.
      expect(threadStore.getThread(task.threadId!)).not.toBeNull()
      expect(task.briefStatus).toBe('idle')
    })

    it('claiming the same item twice keeps ONE record — a re-claim is not a fork', async () => {
      const deps = { taskStore, threadStore, integrations: fakeIntegrations(ISSUE) }
      const first = await createTaskFromIssue(deps, { projectRoot: ROOT, keyOrUrl: ISSUE.key })
      // The second claim arrives by the item's URL rather than its shorthand —
      // the board prefers the link the backend published, and both parse to the
      // same ref, so the record must be the same one.
      const second = await createTaskFromIssue(deps, { projectRoot: ROOT, keyOrUrl: ISSUE.url })

      expect(second.created).toBe(false)
      expect(second.task.id).toBe(first.task.id)
      expect(taskStore.listTasks(ROOT)).toHaveLength(1)
      expect(threadStore.listThreads(ROOT)).toHaveLength(1)
    })

    it('keeps the record after the item closes — the window moves on, the record does not', async () => {
      const deps = { taskStore, threadStore, integrations: fakeIntegrations(ISSUE) }
      const { task } = await createTaskFromIssue(deps, { projectRoot: ROOT, keyOrUrl: ISSUE.key })
      taskStore.updateTask(task.id, { lane: 'done' })

      // The item is gone from the list — closed on the queue by whoever owns it.
      // Nothing removes, archives or unlinks the run record: the run happened,
      // and Done is a lane of things Flow did.
      const kept = taskStore.getTaskByExternalKey(ROOT, 'github', ISSUE.key)
      expect(kept).not.toBeNull()
      expect(kept?.archivedAt).toBeNull()
      expect(kept?.lane).toBe('done')
      expect(kept?.threadId).toBe(task.threadId)
      expect(taskStore.listTasks(ROOT)).toHaveLength(1)
    })
  })

  // ── The record for an item that was ALREADY READ (FR-7, no refetch) ──────
  //
  // What Phase 6 left open. The importer above is the fetched path, and a fetch
  // needs a tracker and a token — so the two cases FR-7 cares about most
  // recorded NOTHING: a ledger queue has no tracker at all, and a GitHub queue
  // on a machine with no working `gh`/PAT claimed the item and then failed the
  // refetch of a thing the board was already holding. The claim landed both
  // times; only the record was missing. `createTaskFromQueueItem` closes that
  // by taking the facts the read produced — and its deps are `taskStore +
  // threadStore` only, which is the no-refetch guarantee stated as a type.
  describe('createTaskFromQueueItem (FR-7)', () => {
    // Rejects everything: the machine has no working provider token. Any path
    // that reaches the tracker fails here, which is the point.
    const tokenless = {
      fetchIssue: async () => {
        throw new Error('GitHub: Bad credentials (401)')
      },
    } as unknown as IntegrationsManager

    it('records a ledger item — the queue kind that could never be fetched', () => {
      const joinKey = queueItemExternalKey('flow/loops/queue.jsonl', '7')
      expect(joinKey).toBe('flow/loops/queue.jsonl#7')

      const { task, created } = createTaskFromQueueItem(
        { taskStore, threadStore },
        {
          projectRoot: ROOT,
          externalKey: joinKey!,
          itemId: '7',
          title: 'tidy the ledger',
          body: 'the finding\n\nloop: ops',
          queueKind: 'ledger',
        },
      )

      expect(created).toBe(true)
      // Keyed on the string the board's join tries FIRST — anything else and
      // the card the user just claimed would not find its own record.
      expect(task.externalKey).toBe(joinKey)
      // The ledger is Flow's own list, not a tracker Flow imported from, so the
      // source that claims no tracker is the honest one — and it is the source
      // the board already draws as `you` for a ledger item's chip.
      expect(task.source).toBe('manual')
      expect(task.externalUrl).toBeNull()
      expect(task.title).toBe('#7: tidy the ledger')
      expect(task.description).toBe('the finding\n\nloop: ops')
      // The thread IS the run's evidence slot.
      expect(threadStore.getThread(task.threadId!)).not.toBeNull()
    })

    it('records a GitHub item on a machine whose token does not work', async () => {
      const key = queueItemExternalKey('dev/plan-flow', '1533')!
      const url = 'https://github.com/dev/plan-flow/issues/1533'

      // The old path, on this machine: the claim is already held, and the
      // record refuses over a credential it should never have needed.
      await expect(
        createTaskFromIssue(
          { taskStore, threadStore, integrations: tokenless },
          { projectRoot: ROOT, keyOrUrl: key },
        ),
      ).rejects.toThrow(/Bad credentials/)
      expect(taskStore.listTasks(ROOT)).toHaveLength(0)

      const { task, created } = createTaskFromQueueItem(
        { taskStore, threadStore },
        {
          projectRoot: ROOT,
          externalKey: key,
          itemId: '1533',
          url,
          title: 'code map refactor',
          body: 'the finding',
          queueKind: 'github',
        },
      )

      expect(created).toBe(true)
      expect(task).toMatchObject({ source: 'github', externalKey: key, externalUrl: url })
      expect(task.title).toBe('#1533: code map refactor')
      expect(threadStore.getThread(task.threadId!)).not.toBeNull()
    })

    it('a re-claim finds the record instead of forking it', () => {
      const facts = {
        projectRoot: ROOT,
        externalKey: 'flow/loops/queue.jsonl#7',
        itemId: '7',
        title: 'tidy the ledger',
        queueKind: 'ledger',
      }
      const first = createTaskFromQueueItem({ taskStore, threadStore }, facts)
      const second = createTaskFromQueueItem({ taskStore, threadStore }, facts)

      expect(second.created).toBe(false)
      expect(second.task.id).toBe(first.task.id)
      expect(taskStore.listTasks(ROOT)).toHaveLength(1)
      expect(threadStore.listThreads(ROOT)).toHaveLength(1)
    })

    it('shares ONE record with the importer — either entry point, same row', async () => {
      const ISSUE: NormalizedIssue = {
        key: 'dev/plan-flow#1533',
        title: 'code map refactor',
        description: 'the finding',
        status: 'open',
        url: 'https://github.com/dev/plan-flow/issues/1533',
      }
      const imported = await createTaskFromIssue(
        { taskStore, threadStore, integrations: fakeIntegrations(ISSUE) },
        { projectRoot: ROOT, keyOrUrl: ISSUE.key },
      )
      // The same item claimed from the board afterwards (a token that worked
      // once may not work now — the record must not fork either way).
      const claimed = createTaskFromQueueItem(
        { taskStore, threadStore },
        {
          projectRoot: ROOT,
          externalKey: ISSUE.key,
          itemId: '1533',
          url: ISSUE.url,
          title: ISSUE.title,
          queueKind: 'github',
        },
      )

      expect(claimed.created).toBe(false)
      expect(claimed.task.id).toBe(imported.task.id)
      expect(taskStore.listTasks(ROOT)).toHaveLength(1)
    })

    // Dedup is (projectRoot, source, external_key) — the source column, not the
    // key's shape, is what keeps a ledger record and a GitHub record apart.
    it('cannot collide with a GitHub record, even on an identical key string', () => {
      const key = 'o/r#5'
      const ledger = createTaskFromQueueItem(
        { taskStore, threadStore },
        { projectRoot: ROOT, externalKey: key, title: 'from the ledger', queueKind: 'ledger' },
      )
      const github = createTaskFromQueueItem(
        { taskStore, threadStore },
        { projectRoot: ROOT, externalKey: key, title: 'from GitHub', queueKind: 'github' },
      )

      expect(github.created).toBe(true)
      expect(github.task.id).not.toBe(ledger.task.id)
      expect(taskStore.getTaskByExternalKey(ROOT, 'manual', key)?.id).toBe(ledger.task.id)
      expect(taskStore.getTaskByExternalKey(ROOT, 'github', key)?.id).toBe(github.task.id)
    })

    it('names the source from the link when the queue kind said nothing', () => {
      const { task } = createTaskFromQueueItem(
        { taskStore, threadStore },
        {
          projectRoot: ROOT,
          url: 'https://github.com/o/r/issues/5',
          title: 'orphan queue',
        },
      )
      // No location, so the link is the key — and `parseIssueRef` (a regex, not
      // a request) canonicalizes it to the same key the importer would store.
      expect(task).toMatchObject({ source: 'github', externalKey: 'o/r#5' })
    })

    it('refuses an item with neither a key nor a link — there is nothing to record it under', () => {
      expect(() =>
        createTaskFromQueueItem({ taskStore, threadStore }, { projectRoot: ROOT, title: 'nameless' }),
      ).toThrow(/nothing to record the run under/)
      expect(taskStore.listTasks(ROOT)).toHaveLength(0)
      expect(threadStore.listThreads(ROOT)).toHaveLength(0)
    })

    it('keeps the record after the item closes — the window moves on, the record does not', () => {
      const { task } = createTaskFromQueueItem(
        { taskStore, threadStore },
        {
          projectRoot: ROOT,
          externalKey: 'flow/loops/queue.jsonl#7',
          itemId: '7',
          title: 'tidy the ledger',
          queueKind: 'ledger',
        },
      )
      taskStore.updateTask(task.id, { lane: 'done' })

      const kept = taskStore.getTaskByExternalKey(ROOT, 'manual', 'flow/loops/queue.jsonl#7')
      expect(kept?.archivedAt).toBeNull()
      expect(kept?.lane).toBe('done')
      expect(kept?.threadId).toBe(task.threadId)
    })

    it('caps a huge body by the same rule the fetched path uses', () => {
      const { task } = createTaskFromQueueItem(
        { taskStore, threadStore },
        {
          projectRoot: ROOT,
          externalKey: 'flow/loops/queue.jsonl#9',
          title: 'a long one',
          body: 'x'.repeat(20_000),
          queueKind: 'ledger',
        },
      )
      expect(task.description!.length).toBe(8_000)
      expect(task.description!.endsWith('…')).toBe(true)
    })
  })

  it('rejects an unrecognized reference', async () => {
    await expect(
      createTaskFromIssue(
        { taskStore, threadStore, integrations: fakeIntegrations({} as NormalizedIssue) },
        { projectRoot: ROOT, keyOrUrl: 'garbage' },
      ),
    ).rejects.toThrow()
  })

  describe('hook factories', () => {
    it('seedProvider returns issue context on a seeded thread, null otherwise', () => {
      const seeded = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'S', description: 'context here' },
      )
      const bare = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'B' })
      const seedOf = makeSeedProvider(taskStore)
      expect(seedOf(seeded.threadId!)).toContain('context here')
      expect(seedOf(bare.threadId!)).toBeNull()
    })

    it('onTurnStart moves a Todo task to Doing (and leaves Doing/Done alone)', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'T' })
      const onStart = makeOnTurnStart(taskStore)
      onStart(task.threadId!)
      expect(taskStore.getTask(task.id)?.lane).toBe('doing')
      taskStore.updateTask(task.id, { lane: 'done' })
      onStart(task.threadId!) // no-op — already past Todo
      expect(taskStore.getTask(task.id)?.lane).toBe('done')
    })

    it('onTurnStart hands the (prev, next) records to onActivated on the Todo → Doing move', () => {
      const task = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'A', description: 'context' },
      )
      const seen: { prev: string; next: string }[] = []
      const onStart = makeOnTurnStart(taskStore, (prev, next) =>
        seen.push({ prev: prev.lane, next: next.lane }),
      )
      onStart(task.threadId!)
      expect(seen).toEqual([{ prev: 'todo', next: 'doing' }])
      // Already in Doing → no move, so onActivated is not called again.
      onStart(task.threadId!)
      expect(seen).toHaveLength(1)
    })

    it('a manual task worked by the loop gets a brief before the agent runs (onTurnStart path)', async () => {
      // The board loop never touches tasks:update — it starts the agent, which
      // fires onTurnStart. Wiring briefOnActivation here is what gives a
      // loop-worked manual card a technical brief it otherwise never had.
      const briefGenerator = jest.fn().mockResolvedValue('- summary')
      const task = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'Add caching', description: 'LRU cache on the API layer' },
      )
      expect(task.briefStatus).toBe('idle')

      let pending: Promise<unknown> | null = null
      const onStart = makeOnTurnStart(taskStore, (prev, next) => {
        pending = briefOnActivation(prev, next, {
          hasContent: taskHasBriefContent,
          generate: (id) => generateTaskBrief({ taskStore, briefGenerator }, id),
        })
      })
      onStart(task.threadId!)
      await pending

      expect(briefGenerator).toHaveBeenCalledTimes(1)
      const after = taskStore.getTask(task.id)!
      expect(after.lane).toBe('doing')
      expect(after.briefStatus).toBe('ready')
      expect(after.brief).toBe('- summary')
    })

    it('a bare title-only card worked by the loop generates no brief', async () => {
      const briefGenerator = jest.fn().mockResolvedValue('- summary')
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Bare' })

      let pending: Promise<unknown> | null = null
      const onStart = makeOnTurnStart(taskStore, (prev, next) => {
        pending = briefOnActivation(prev, next, {
          hasContent: taskHasBriefContent,
          generate: (id) => generateTaskBrief({ taskStore, briefGenerator }, id),
        })
      })
      onStart(task.threadId!)
      await pending

      expect(briefGenerator).not.toHaveBeenCalled()
      expect(taskStore.getTask(task.id)?.briefStatus).toBe('idle')
    })

    it('onTurnComplete flags suggestDone only on success and not when Done', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'T' })
      const onDone = makeOnTurnComplete(taskStore)
      onDone(task.threadId!, false)
      expect(taskStore.getTask(task.id)?.suggestDone).toBe(false)
      onDone(task.threadId!, true)
      expect(taskStore.getTask(task.id)?.suggestDone).toBe(true)
    })
  })

  describe('technical brief', () => {
    it('taskHasBriefContent is true with a description or external key, false for a bare manual task', () => {
      const bare = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'B' })
      const described = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'D', description: 'has content' },
      )
      expect(taskHasBriefContent(bare)).toBe(false)
      expect(taskHasBriefContent(described)).toBe(true)
    })

    it('generateTaskBrief stores the generated text and marks the task ready', async () => {
      const task = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'Refactor auth', description: 'move token logic to main' },
      )
      const briefGenerator = jest.fn().mockResolvedValue('- point one\n- point two')
      const result = await generateTaskBrief({ taskStore, briefGenerator }, task.id)

      expect(briefGenerator).toHaveBeenCalledTimes(1)
      expect(briefGenerator.mock.calls[0][0]).toMatchObject({ projectRoot: ROOT })
      expect(result?.briefStatus).toBe('ready')
      expect(result?.brief).toBe('- point one\n- point two')
      expect(taskStore.getTask(task.id)?.brief).toBe('- point one\n- point two')
    })

    it('generateTaskBrief records error status when the generator throws', async () => {
      const task = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'T', description: 'x' },
      )
      const briefGenerator = jest.fn().mockRejectedValue(new Error('no api key'))
      const result = await generateTaskBrief({ taskStore, briefGenerator }, task.id)
      expect(result?.briefStatus).toBe('error')
      expect(taskStore.getTask(task.id)?.briefStatus).toBe('error')
    })

    it('generateTaskBrief records error status when the generator yields nothing', async () => {
      const task = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'T', description: 'x' },
      )
      const briefGenerator = jest.fn().mockResolvedValue('   ')
      const result = await generateTaskBrief({ taskStore, briefGenerator }, task.id)
      expect(result?.briefStatus).toBe('error')
    })

    it('generateTaskBrief is a no-op (stays idle) for a task with no content to summarize', async () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Bare' })
      const briefGenerator = jest.fn()
      const result = await generateTaskBrief({ taskStore, briefGenerator }, task.id)
      expect(briefGenerator).not.toHaveBeenCalled()
      expect(result?.briefStatus).toBe('idle')
    })

    it('returns null (never throws) when the task is deleted mid-generation (#114)', async () => {
      const task = createManualTask(
        { taskStore, threadStore },
        { projectRoot: ROOT, title: 'T', description: 'x' },
      )
      // The LLM call resolves only AFTER the task has been deleted — so the
      // terminal setBrief hits an unknown task. Must be swallowed, not thrown.
      const briefGenerator = jest.fn().mockImplementation(async () => {
        taskStore.deleteTask(task.id)
        return '- brief'
      })
      const result = await generateTaskBrief({ taskStore, briefGenerator }, task.id)
      expect(result).toBeNull()
      expect(taskStore.getTask(task.id)).toBeNull()
    })

    it('returns null for an already-unknown task without throwing (#114)', async () => {
      const briefGenerator = jest.fn()
      await expect(
        generateTaskBrief({ taskStore, briefGenerator }, 'no-such-task'),
      ).resolves.toBeNull()
      expect(briefGenerator).not.toHaveBeenCalled()
    })

    it('buildBriefPrompt frames an Azure PR as a pull request', () => {
      const issue: NormalizedIssue = {
        key: '120160',
        title: 'Add OneDrive connection',
        description: 'FE work for OneDrive',
        status: 'active',
        url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/120160',
      }
      // Round-trip through the store so source='azure' + url are set.
      const created = taskStore.createTask({
        projectRoot: ROOT,
        title: issue.title,
        source: 'azure',
        externalKey: issue.key,
        externalUrl: issue.url,
        description: issue.description,
      })
      const prompt = buildBriefPrompt(created)
      expect(prompt).toContain('pull request')
      expect(prompt).toContain('review focus areas')
    })
  })

  // The extraction that made the board tools and the tasks:update handler ONE
  // update path (allowed-pattern #14): these pin the four side effects so the
  // handler's behaviour is unchanged by moving it here.
  describe('applyTaskUpdate — the one update path', () => {
    let closeRemoteCalls: Array<{ lane: string }>
    function deps(over: Partial<ApplyTaskUpdateDeps> = {}): ApplyTaskUpdateDeps {
      return {
        taskStore,
        threadStore,
        briefGenerator: async () => 'a generated brief',
        closeRemote: {
          isEnabled: () => true,
          closeIssue: async () => {
            closeRemoteCalls.push({ lane: 'done' })
            return { ok: true } as any
          },
          notify: () => {},
        },
        ...over,
      }
    }
    beforeEach(() => {
      closeRemoteCalls = []
    })

    it('mirrors a rename onto the owning 1:1 thread', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Old' })
      applyTaskUpdate(deps(), task.id, { title: 'New' })
      expect(threadStore.getThread(task.threadId!)?.title).toBe('New')
      expect(taskStore.getTask(task.id)?.title).toBe('New')
    })

    it('moves the card and reports the updated record', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Move me' })
      const record = applyTaskUpdate(deps(), task.id, { lane: 'doing' })
      expect(record.lane).toBe('doing')
      expect(taskStore.getTask(task.id)?.lane).toBe('doing')
    })

    it('generates a brief when a card with content moves INTO an active lane', async () => {
      // Give the card content so it is brief-eligible, starting outside Doing.
      const created = taskStore.createTask({
        projectRoot: ROOT,
        title: 'Has content',
        description: 'something to summarize',
        externalKey: 'o/r#1',
      })
      taskStore.updateTask(created.id, { lane: 'review' }, { activity: false })

      applyTaskUpdate(deps(), created.id, { lane: 'doing' })
      // brief generation is fire-and-forget; let the microtask settle.
      await new Promise((r) => setImmediate(r))
      expect(taskStore.getTask(created.id)?.brief).toBe('a generated brief')
    })

    it('closes the remote ticket when a promoted tracker card moves INTO Done', async () => {
      const promoted = taskStore.createTask({
        projectRoot: ROOT,
        title: 'Tracker card',
        source: 'github',
        externalKey: 'o/r#7',
        externalUrl: 'https://github.com/o/r/issues/7',
      })
      applyTaskUpdate(deps(), promoted.id, { lane: 'done' })
      await new Promise((r) => setImmediate(r))
      expect(closeRemoteCalls).toHaveLength(1)
    })

    it('does not bump the sort clock for an app-driven patch (a lone suggestDone)', () => {
      const task = createManualTask({ taskStore, threadStore }, { projectRoot: ROOT, title: 'Steady' })
      const before = taskStore.getTask(task.id)!.updatedAt
      applyTaskUpdate(deps(), task.id, { suggestDone: true })
      expect(taskStore.getTask(task.id)?.updatedAt).toBe(before)
    })
  })
})
