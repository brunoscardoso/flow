/**
 * THE WORKSPACE SYNC ENGINE — over a fake CLI that is a TABLE keyed by argv
 * (minus the commit message, recorded apart) and THROWS on anything it was not
 * told about (allowed-pattern #24): every test asserts the question the engine
 * asked, not just the answer it got.
 */

import type { WorkspaceSyncStatus } from '../../shared/workspaces-contract'
import { createWorkspacePauseNotifier } from './pause-notice'
import { OPEN_SYNC_COOLDOWN_MS, RETRY_BASE_MS, type EngineTimers } from './sync-timing'
import {
  COMMIT_ONLY_TIMEOUT_MS,
  ONE_RETRY_MS,
  PROMOTE_COOLDOWN_MS,
  PROMOTE_INTERVAL_MS,
  PROMOTE_TIMEOUT_MS,
  QUIT_SYNC_TIMEOUT_MS,
  TURN_SYNC_DELAY_MS,
  WORKSPACE_SYNC_SENTENCES,
  createWorkspaceSyncEngine,
  reviewOf,
  turnsMessage,
  type WorkspaceSyncCliRun,
} from './workspace-sync-engine'

const SLUG = 'acme'
const HOME = '/home/dev'
const DECISION = 'projects/api/brain/decisions/queue.md'

class FakeTimers implements EngineTimers {
  now = 0
  private seq = 0
  readonly tasks = new Map<number, { at: number; ms: number; fn: () => void }>()

  setTimeout(callback: () => void, ms: number): unknown {
    this.seq += 1
    this.tasks.set(this.seq, { at: this.now + ms, ms, fn: callback })
    return this.seq
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  /** Sync timers only: the promotion interval is armed for as long as a Workspace is open (its own tests below). */
  delays(): number[] {
    return [...this.tasks.values()].filter((task) => task.ms !== PROMOTE_INTERVAL_MS).map((task) => task.ms)
  }

  /** How many sync timers are armed (the promotion interval aside). */
  syncTimers(): number {
    return this.delays().length
  }

  async advance(ms: number): Promise<void> {
    this.now += ms
    for (const [id, task] of [...this.tasks.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (task.at <= this.now && this.tasks.has(id)) {
        this.tasks.delete(id)
        task.fn()
        await settled()
      }
    }
    await settled()
  }
}

async function settled(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ── The CLI's answers ──

function result(state: string, extra: Record<string, unknown> = {}): WorkspaceSyncCliRun {
  const payload = {
    action: 'sync',
    workspace: { name: 'Acme', slug: SLUG, path: '/flow/workspaces/acme' },
    branch: 'main',
    remote: 'https://github.com/acme/knowledge.git',
    state,
    committed: null,
    pulled: 0,
    pushed: state === 'synced',
    ahead: 0,
    merge: null,
    resolutions: [],
    asks: [],
    reviews: [],
    decided: [],
    skipped: [],
    indexes: { rebuilt: [], failed: [] },
    ...extra,
  }
  return { ok: true, stdout: `${JSON.stringify(payload)}\n` }
}

function refused(reason: string, extra: Record<string, unknown> = {}): WorkspaceSyncCliRun {
  return {
    ok: false,
    stdout: `${JSON.stringify({ action: 'sync', refused: reason, detail: `raw cli words at /secret/path`, ...extra })}\n`,
    stderr: `workspace refused: ${reason} — raw`,
    error: 'exit 1',
  }
}

const ASK = {
  id: 'ask-1',
  kind: 'decision',
  topic: 'api/queue',
  path: DECISION,
  existingPath: DECISION,
  existing: '# Queue\n\nSQS.\n',
  incoming: '# Queue\n\nKafka.\n',
  merged: null,
  truncated: false,
  options: ['ours', 'theirs', 'file'],
}

const REVIEW = {
  id: 'review-1',
  kind: 'conflict',
  path: 'projects/api/notes.md',
  base: 'a\n',
  existing: 'b\n',
  incoming: 'c\n',
  conflicted: '<<<<<<< ours\nc\n=======\nb\n>>>>>>> theirs\n',
  truncated: false,
  options: ['ours', 'theirs', 'merged', 'file'],
}

const SYNC_ARGV = `workspace sync --workspace ${SLUG} --json`
const COMMIT_ONLY_ARGV = `workspace sync --workspace ${SLUG} --commit-only --json`

/** argv without the commit message — the message is recorded apart. */
function keyOf(args: readonly string[]): string {
  return args.filter((arg) => !arg.startsWith('--message=')).join(' ')
}

/** `workspace promote`'s answer with these totals. */
function promoted(totals: Partial<Record<'checked' | 'solid' | 'stale' | 'abandoned' | 'unknown', number>> = {}): WorkspaceSyncCliRun {
  const payload = {
    action: 'promote',
    workspace: { name: 'Acme', slug: SLUG },
    projects: [],
    totals: { checked: 0, solid: 0, stale: 0, abandoned: 0, unknown: 0, ...totals },
  }
  return { ok: true, stdout: `${JSON.stringify(payload)}\n` }
}

function harness(
  options: {
    rows?: Map<string, number>
    nameOf?: (slug: string) => Promise<string | null>
    /** The capable agent; default answers nothing. */
    mergeIntent?: (input: { title: string; ours: string; theirs: string; base: string | null }) => Promise<string | null>
    /** The fast agent that sorts; default answers nothing (the agent is unavailable: a pause stays a pause). */
    decideFast?: (input: { prompt: string }) => Promise<string | null>
    /** The shared record's `merge-decision list` answer; default an empty record. */
    reasons?: WorkspaceSyncCliRun
  } = {},
) {
  const timers = new FakeTimers()
  const table = new Map<string, Array<WorkspaceSyncCliRun | (() => Promise<WorkspaceSyncCliRun>)>>()
  const calls: Array<{ key: string; message: string | null; cwd: string; timeoutMs: number }> = []
  const statuses: WorkspaceSyncStatus[] = []
  const names: Array<string | null> = []
  const notifier = createWorkspacePauseNotifier()
  const notices: string[] = []
  const rows = options.rows ?? new Map<string, number>()
  const temps: string[] = []
  const disposed: string[] = []
  /** Every `workspace promote` the engine started, and the answers it gets (no change by default). */
  const promotions: Array<{ key: string; timeoutMs: number }> = []
  const promoteAnswers: Array<WorkspaceSyncCliRun | (() => Promise<WorkspaceSyncCliRun>)> = []
  const agentCalls: string[] = []
  const fastPrompts: string[] = []
  /** `workspace merge-decision list` runs — kept apart from `calls`, which are the syncs. */
  const reasonReads: string[] = []
  const engine = createWorkspaceSyncEngine({
    runPromotionCli: async (_cwd, args, runOptions) => {
      promotions.push({ key: args.join(' '), timeoutMs: runOptions.timeoutMs })
      const next = promoteAnswers.shift() ?? promoted()
      return typeof next === 'function' ? next() : next
    },
    mergeIntent: async (input) => {
      agentCalls.push(input.title)
      return options.mergeIntent === undefined ? null : options.mergeIntent(input)
    },
    decideFast: async (input) => {
      fastPrompts.push(input.prompt)
      return options.decideFast === undefined ? null : options.decideFast(input)
    },
    nameOf: options.nameOf ?? (async () => null),
    runCli: async (cwd, args, runOptions) => {
      const key = keyOf(args)
      if (args[1] === 'merge-decision') {
        reasonReads.push(key)
        return options.reasons ?? { ok: true, stdout: `${JSON.stringify({ action: 'merge-decision', op: 'list', decisions: [], unreadable: 0 })}\n` }
      }
      const message = args.find((arg) => arg.startsWith('--message='))?.slice('--message='.length) ?? null
      calls.push({ key, message, cwd, timeoutMs: runOptions.timeoutMs })
      const queue = table.get(key)
      const next = queue?.shift()
      if (next === undefined) throw new Error(`unexpected CLI call: ${key}`)
      return typeof next === 'function' ? next() : next
    },
    cwd: HOME,
    lastSynced: {
      get: (slug) => rows.get(slug) ?? null,
      set: (slug, at) => {
        rows.set(slug, at)
      },
    },
    writeTempText: async (text) => {
      const path = `/tmp/decision-${temps.length}.md`
      temps.push(text)
      return { path, dispose: async () => void disposed.push(path) }
    },
    now: () => 1_000_000 + timers.now,
    timers,
    onStatus: (slug, name, status) => {
      statuses.push(status)
      names.push(name)
      const notice = notifier.observe(slug, status, 'now', name)
      if (notice !== null) notices.push(notice.body)
    },
    log: () => undefined,
  })
  const answer = (key: string, ...replies: Array<WorkspaceSyncCliRun | (() => Promise<WorkspaceSyncCliRun>)>): void => {
    table.set(key, [...(table.get(key) ?? []), ...replies])
  }
  return {
    engine,
    timers,
    calls,
    statuses,
    names,
    notices,
    rows,
    temps,
    disposed,
    answer,
    promotions,
    promoteAnswers,
    agentCalls,
    fastPrompts,
    reasonReads,
    last: () => statuses[statuses.length - 1],
  }
}

describe('workspace sync engine — the CLI door', () => {
  it('open runs `workspace sync --workspace <slug>` in the home folder, bounded, and reports synced', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced', { committed: { sha: 'abc', message: 'm', files: 2 } }))
    await h.engine.open(SLUG)
    expect(h.calls).toEqual([{ key: SYNC_ARGV, message: 'Flow: changes since the last sync', cwd: HOME, timeoutMs: 300_000 }])
    expect(h.statuses.map((status) => status.state)).toEqual(['syncing', 'synced'])
    expect(h.last()).toMatchObject({ state: 'synced', detail: null, asks: [], reviews: [] })
    expect(h.last()?.lastSyncedAt).toBe(new Date(1_000_000).toISOString())
  })

  it('a second open inside the cooldown asks the CLI nothing; after it, it syncs again', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced'), result('nothing-to-do'))
    await h.engine.open(SLUG)
    await h.engine.open(SLUG)
    expect(h.calls).toHaveLength(1)
    await h.timers.advance(OPEN_SYNC_COOLDOWN_MS)
    await h.engine.open(SLUG)
    expect(h.calls).toHaveLength(2)
  })

  it('an invalid slug is never handed to the CLI', async () => {
    const h = harness()
    await h.engine.open('../etc')
    h.engine.commitAfterTurn('--all', 'x')
    expect(await h.engine.syncNow('Acme Corp')).toMatchObject({ state: 'idle' })
    expect(await h.engine.resolve({ slug: '../etc', path: 'a.md', take: 'ours' })).toMatchObject({ ok: false, reason: 'unknown-workspace' })
    expect(h.calls).toEqual([])
  })
})

describe('workspace sync engine — a Workspace whose name is not known', () => {
  it('never shows its folder slug: the sentence says "the Workspace", and the listener gets no name', async () => {
    const h = harness({ nameOf: async () => null })
    h.answer(SYNC_ARGV, refused('personal-files'))
    await h.engine.open(SLUG)
    // Positive first: the refusal reached a sentence.
    expect(h.last()?.detail).toBe('Some of the changes in the Workspace are personal files that are never shared, so nothing was sent.')
    expect(h.statuses.some((status) => (status.detail ?? '').includes(SLUG))).toBe(false)
    expect(h.names.every((name) => name === null)).toBe(true)
  })

  it('a sentence that begins with the name begins with a capital', async () => {
    const h = harness({ nameOf: async () => null })
    h.answer(SYNC_ARGV, refused('detached-head'))
    await h.engine.open(SLUG)
    expect(h.last()?.detail).toBe("The Workspace's knowledge isn't on a branch, so Flow can't sync it.")
  })
})

describe('workspace sync engine — turns', () => {
  it('N turns → ONE sync, carrying every turn in its message', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced'))
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    h.engine.commitAfterTurn(SLUG, '/execute-plan in web')
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    // Armed once: later turns join it.
    expect(h.timers.delays()).toEqual([TURN_SYNC_DELAY_MS])
    expect(h.calls).toEqual([])
    await h.timers.advance(TURN_SYNC_DELAY_MS)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.message).toBe('Flow: turn in api; /execute-plan in web')
    // Nothing left armed after the sync.
    expect(h.timers.syncTimers()).toBe(0)
  })

  it('many distinct turns are counted, not listed', () => {
    expect(turnsMessage(['a', 'b', 'c', 'd'])).toBe('Flow: 4 turns')
  })

  it('a turn timer re-checks before it acts: a Workspace forgotten meanwhile (deleted) → no CLI call', async () => {
    const h = harness()
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    expect(h.timers.syncTimers()).toBe(1)
    h.engine.forget(SLUG)
    await h.timers.advance(TURN_SYNC_DELAY_MS)
    expect(h.calls).toEqual([])
  })
})

describe('workspace sync engine — a pause waits for a person', () => {
  it('ask → paused with the payload, ONE notification in plain words, and no retry of any kind', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK], ahead: 1 }))
    await h.engine.open(SLUG)
    const paused = h.last()
    expect(paused).toMatchObject({ state: 'paused', detail: WORKSPACE_SYNC_SENTENCES.askDecision('Acme'), reviews: [] })
    expect(paused?.asks).toEqual([ASK])
    expect(h.notices).toEqual(['Two people changed the same decision in Acme. Flow needs you to choose which one to keep.'])
    // Nothing armed; a turn, an open and time all leave it alone.
    expect(h.timers.syncTimers()).toBe(0)
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    await h.engine.open(SLUG)
    await h.timers.advance(RETRY_BASE_MS * 100)
    expect(h.calls).toHaveLength(1)
    expect(h.notices).toHaveLength(1)
  })

  it('"Sync now" on a pause that is still the same pause does not notify again', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }), result('ask', { asks: [ASK] }))
    await h.engine.open(SLUG)
    await h.engine.syncNow(SLUG)
    expect(h.calls).toHaveLength(2)
    expect(h.notices).toHaveLength(1)
  })

  it('review → paused on a merged version, with its own sentence', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('review', { reviews: [REVIEW] }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'paused', detail: WORKSPACE_SYNC_SENTENCES.review('Acme') })
    expect(h.last()?.reviews).toEqual([REVIEW])
  })

  it('resolve → `--resolve <path> --take <take>` → re-sync; once nothing is waiting the pause clears', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }))
    await h.engine.open(SLUG)
    expect(h.last()?.state).toBe('paused')
    // A turn while paused arms nothing; the run that settles the pause carries it.
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    expect(h.timers.syncTimers()).toBe(0)
    h.answer(`workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=theirs --json`, result('synced', { decided: ['ask-1'], pushed: true }))
    const answer = await h.engine.resolve({ slug: SLUG, path: DECISION, take: 'theirs' })
    expect(answer).toMatchObject({ ok: true, status: { state: 'synced', asks: [], reviews: [] } })
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV, `workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=theirs --json`])
    // The turn the pause held is carried by the run that settled it.
    expect(h.calls[1]?.message).toBe('Flow: turn in api')
  })

  it('a decision leaving other items waiting stays paused on what is left', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK], reviews: [REVIEW] }))
    await h.engine.open(SLUG)
    h.answer(`workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=ours --json`, result('review', { reviews: [REVIEW], decided: ['ask-1'] }))
    const answer = await h.engine.resolve({ slug: SLUG, path: DECISION, take: 'ours' })
    expect(answer).toMatchObject({ ok: true, status: { state: 'paused', asks: [] } })
    expect(answer.status.reviews).toEqual([REVIEW])
  })

  it('a merged TEXT goes to the CLI as a private temp file, removed afterwards', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('review', { reviews: [REVIEW] }))
    await h.engine.open(SLUG)
    h.answer(`workspace sync --workspace ${SLUG} --resolve=${REVIEW.path} --id=review-1 --take=file:/tmp/decision-0.md --json`, result('synced'))
    const answer = await h.engine.resolve({ slug: SLUG, path: REVIEW.path, take: 'text', text: 'b and c\n' })
    expect(answer.ok).toBe(true)
    expect(h.temps).toEqual(['b and c\n'])
    expect(h.disposed).toEqual(['/tmp/decision-0.md'])
  })

  it('refuses a path nothing is waiting on, and a take the item does not accept — without asking the CLI', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }))
    await h.engine.open(SLUG)
    expect(await h.engine.resolve({ slug: SLUG, path: 'projects/api/other.md', take: 'ours' })).toMatchObject({ ok: false, reason: 'not-waiting' })
    expect(await h.engine.resolve({ slug: SLUG, path: DECISION, take: 'merged' })).toMatchObject({ ok: false, reason: 'invalid-take' })
    expect(h.calls).toHaveLength(1)
    expect(h.last()?.state).toBe('paused')
  })

  it('a decision the question has gone from (nothing-to-resolve) re-syncs to say where things stand', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }), result('synced'))
    await h.engine.open(SLUG)
    h.answer(`workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=ours --json`, refused('nothing-to-resolve'))
    const answer = await h.engine.resolve({ slug: SLUG, path: DECISION, take: 'ours' })
    expect(answer).toMatchObject({ ok: false, reason: 'not-waiting', status: { state: 'synced' } })
  })
})

describe('workspace sync engine — deciding by item id', () => {
  it('the decision names the item by its id, so the CLI decides exactly what the person saw', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }))
    await h.engine.open(SLUG)
    h.answer(`workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=ours --json`, result('synced'))
    expect(await h.engine.resolve({ slug: SLUG, id: 'ask-1', path: DECISION, take: 'ours' })).toMatchObject({ ok: true })
    expect(h.calls[1]?.key).toContain('--id=ask-1')
  })

  it('stale-decision: the content changed since the person looked → re-read, and show the card again', async () => {
    const changed = { ...ASK, id: 'ask-2', incoming: '# Queue\n\nRabbitMQ.\n' }
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }), result('ask', { asks: [changed] }))
    await h.engine.open(SLUG)
    h.answer(
      `workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=ours --json`,
      refused('stale-decision', { path: DECISION, id: 'ask-1', current: 'ask-2', waiting: [{ id: 'ask-2', path: DECISION }] }),
    )
    const answer = await h.engine.resolve({ slug: SLUG, id: 'ask-1', path: DECISION, take: 'ours' })
    expect(answer).toMatchObject({ ok: false, reason: 'stale', detail: WORKSPACE_SYNC_SENTENCES.stale })
    // Re-read: the card has the CURRENT question to show.
    expect(answer.status).toMatchObject({ state: 'paused' })
    expect(answer.status.asks.map((ask) => ask.id)).toEqual(['ask-2'])
    expect(h.calls.map((call) => call.key)).toEqual([
      SYNC_ARGV,
      `workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-1 --take=ours --json`,
      SYNC_ARGV,
    ])
  })
})

describe('workspace sync engine — the shared repository cannot be trusted as it is', () => {
  it('incoming-unsafe: an error in plain words — no paths — and one notification', async () => {
    const h = harness({ nameOf: async () => 'Acme' })
    h.answer(
      SYNC_ARGV,
      refused('incoming-unsafe', { paths: [{ path: 'projects/api/.git/hooks/x', why: 'repo-settings' }], pushed: false }),
      refused('incoming-unsafe', { paths: [{ path: 'projects/api/.git/hooks/x', why: 'repo-settings' }], pushed: false }),
    )
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({
      state: 'error',
      detail: "The shared repository for Acme now contains files Flow won't bring onto this computer.",
    })
    expect(JSON.stringify(h.last())).not.toContain('hooks')
    await h.engine.syncNow(SLUG)
    expect(h.notices).toHaveLength(1)
  })

  it('remote-rewritten: an error that says what happened and who can fix it, and one notification', async () => {
    const h = harness({ nameOf: async () => 'Acme' })
    h.answer(SYNC_ARGV, refused('remote-rewritten', { previous: 'abc', current: 'def', pushed: false, committed: null }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({
      state: 'error',
      detail: 'Someone rewrote the shared history of Acme. Flow stopped so nothing is lost; ask whoever manages it.',
    })
    expect(h.notices).toHaveLength(1)
  })

  it('unrelated-history: the shared repository holds a different Workspace — said in plain words', async () => {
    const h = harness({ nameOf: async () => 'Acme' })
    h.answer(SYNC_ARGV, refused('unrelated-history', { pushed: false }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'error', cause: 'unrelated-history', detail: WORKSPACE_SYNC_SENTENCES.unrelatedHistory('Acme') })
    expect(h.last()?.detail).not.toMatch(/git|merge-base|unrelated/)
  })
})

describe('workspace sync engine — offline, behind, refusals', () => {
  it('offline → waits and retries on the cooldown back-off', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('offline', { detail: 'fatal: could not resolve host github.com', ahead: 1 }), result('synced'))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'offline', detail: WORKSPACE_SYNC_SENTENCES.offline('Acme') })
    expect(JSON.stringify(h.last())).not.toContain('github.com')
    expect(h.timers.delays()).toEqual([RETRY_BASE_MS])
    expect(h.notices).toEqual([])
    await h.timers.advance(RETRY_BASE_MS)
    expect(h.calls).toHaveLength(2)
    expect(h.last()?.state).toBe('synced')
  })

  it('behind → retried ONCE, not again', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('behind'), result('behind'))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'idle', detail: WORKSPACE_SYNC_SENTENCES.behind('Acme') })
    expect(h.timers.delays()).toEqual([ONE_RETRY_MS])
    await h.timers.advance(ONE_RETRY_MS)
    expect(h.calls).toHaveLength(2)
    expect(h.timers.syncTimers()).toBe(0)
  })

  it('a refusal is an error with a plain sentence — never the CLI words — and one notification', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, refused('personal-files', { paths: ['projects/api/STATE.md'] }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'error', detail: 'Some of the changes in the Workspace are personal files that are never shared, so nothing was sent.' })
    expect(JSON.stringify(h.last())).not.toMatch(/secret|STATE\.md|planflow|--/)
    expect(h.notices).toHaveLength(1)
    expect(h.timers.syncTimers()).toBe(0)
  })

  it('a refusal names the Workspace by its name, not its slug — a refusal carries no name of its own', async () => {
    const asked: string[] = []
    const h = harness({ nameOf: async (slug) => (asked.push(slug), 'Acme Team') })
    h.answer(SYNC_ARGV, refused('not-a-git-repo'))
    await h.engine.open(SLUG)
    expect(asked).toEqual([SLUG])
    expect(h.last()).toMatchObject({ state: 'error', detail: WORKSPACE_SYNC_SENTENCES.notARepo('Acme Team') })
    expect(h.notices).toEqual([WORKSPACE_SYNC_SENTENCES.notARepo('Acme Team')])
  })

  it('an answer that is not JSON at all is an error, not a crash', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, { ok: false, stdout: '', error: 'timed out' })
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'error', detail: "Flow couldn't sync the Workspace just now. Try again in a moment." })
  })

  it.each([
    [{ kind: 'author-not-allowed', email: 'me@personal.example' }, "Acme's shared repository doesn't accept changes from me@personal.example. Your changes are kept on this computer."],
    [{ kind: 'author-not-allowed', email: null }, "Acme's shared repository refused your changes because of the email address on them. Your changes are kept on this computer."],
    [{ kind: 'pull-request-required' }, "Acme's shared repository only accepts changes through a pull request, so Flow can't send yours. Ask whoever manages it to let Flow update it directly. Your changes are kept on this computer."],
    [{ kind: 'declined' }, "Acme's shared repository declined your changes because of a rule set by whoever manages it. Your changes are kept on this computer."],
    [{ kind: 'access' }, "Flow can't reach Acme's shared repository with your access."],
    [{ kind: 'something-newer' }, "Flow can't reach Acme's shared repository with your access."],
  ])('no-access names the refusal %o, never the remote\'s own text', async (rejection, sentence) => {
    const h = harness()
    h.answer(SYNC_ARGV, result('no-access', { rejection, detail: 'VS403702 TF402455 https://dev.azure.com/acme/P/_git/ws', ahead: 1 }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'no-access', detail: sentence })
    expect(JSON.stringify(h.last())).not.toMatch(/dev\.azure\.com|VS403702|TF402455/)
  })

  it.each([
    [{ kind: 'pull-request-required' }, 'pull-request-required'],
    [{ kind: 'declined' }, 'declined'],
    [{ kind: 'author-not-allowed', email: null }, 'author-not-allowed'],
    [{ kind: 'something-newer' }, 'access'],
  ])('no-access carries its cause %o → %s, so a branch check can tell what is to blame', async (rejection, cause) => {
    const h = harness()
    h.answer(SYNC_ARGV, result('no-access', { rejection, ahead: 1 }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'no-access', cause })
  })

  it('a cause belongs to the sync that named it: the next good sync carries none', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('no-access', { rejection: { kind: 'pull-request-required' }, ahead: 1 }), result('synced'))
    await h.engine.open(SLUG)
    expect(h.last()?.cause).toBe('pull-request-required')
    await h.engine.syncNow(SLUG)
    // POSITIVE FIRST: the second sync ran and synced.
    expect(h.last()?.state).toBe('synced')
    expect(h.last()).not.toHaveProperty('cause')
  })

  it('no-access → its own state and sentence, ONE notification, and nothing retries until "Sync now"', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('no-access', { detail: 'remote: Repository not found. https://github.com/acme/knowledge.git', ahead: 1 }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'no-access', detail: "Flow can't reach Acme's shared repository with your access." })
    expect(JSON.stringify(h.last())).not.toMatch(/github\.com|Repository not found/)
    expect(h.notices).toEqual(["Flow can't reach Acme's shared repository with your access."])
    // No back-off, no timer: a turn, an open and time all leave it alone.
    expect(h.timers.syncTimers()).toBe(0)
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    expect(h.timers.syncTimers()).toBe(0)
    await h.engine.open(SLUG)
    await h.timers.advance(RETRY_BASE_MS * 100)
    expect(h.calls).toHaveLength(1)
    // "Sync now" tries again — still refused: the same state, no second notification.
    h.answer(SYNC_ARGV, result('no-access'), result('synced'))
    expect(await h.engine.syncNow(SLUG)).toMatchObject({ state: 'no-access' })
    expect(h.calls).toHaveLength(2)
    expect(h.notices).toHaveLength(1)
    // That run carried the turn held meanwhile (the CLI commits before it reaches the remote).
    expect(h.calls[1]?.message).toBe('Flow: turn in api')
    // Access granted: "Sync now" clears it.
    expect(await h.engine.syncNow(SLUG)).toMatchObject({ state: 'synced', detail: null })
    expect(h.calls).toHaveLength(3)
  })

  it('local-only says the knowledge stays here', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('local-only'))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'local-only', detail: WORKSPACE_SYNC_SENTENCES.localOnly('Acme') })
  })
})

describe('workspace sync engine — quit and restarts', () => {
  it('quit COMMITS ONLY a Workspace with turns waiting — never a network sync — and nothing reports after', async () => {
    const h = harness()
    h.answer(COMMIT_ONLY_ARGV, result('committed', { committed: { sha: 'abc', message: 'Flow: turn in api', files: 1 }, ahead: 1 }))
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    await h.engine.quit()
    // POSITIVE: the one run happened, carrying the turn — and it was the commit-only one.
    expect(h.calls).toEqual([{ key: COMMIT_ONLY_ARGV, message: 'Flow: turn in api', cwd: HOME, timeoutMs: COMMIT_ONLY_TIMEOUT_MS }])
    expect(h.calls.some((call) => call.key === SYNC_ARGV)).toBe(false)
    expect(h.timers.syncTimers()).toBe(0)
    const seen = h.statuses.length
    h.engine.commitAfterTurn(SLUG, 'late')
    await h.timers.advance(TURN_SYNC_DELAY_MS)
    expect(h.calls).toHaveLength(1)
    expect(h.statuses).toHaveLength(seen)
  })

  it('quit stops waiting at its bound', async () => {
    const h = harness()
    let finish: (run: WorkspaceSyncCliRun) => void = () => undefined
    h.answer(COMMIT_ONLY_ARGV, () => new Promise<WorkspaceSyncCliRun>((resolve) => (finish = resolve)))
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    let done = false
    const quitting = h.engine.quit().then(() => {
      done = true
    })
    await settled()
    expect(h.calls).toHaveLength(1)
    expect(done).toBe(false)
    await h.timers.advance(QUIT_SYNC_TIMEOUT_MS)
    await quitting
    expect(done).toBe(true)
    finish(result('committed'))
  })

  it('quit runs nothing for a Workspace with nothing uncommitted — commits waiting to be sent go on the next open', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('offline', { ahead: 2 }))
    await h.engine.open(SLUG)
    await h.engine.quit()
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV])
  })

  it('quit still commits a paused or access-refused Workspace — a commit touches no merge and no network', async () => {
    const paused = harness()
    paused.answer(SYNC_ARGV, result('ask', { asks: [ASK], ahead: 2 }))
    paused.answer(COMMIT_ONLY_ARGV, result('committed'))
    await paused.engine.open(SLUG)
    paused.engine.commitAfterTurn(SLUG, 'turn in api')
    await paused.engine.quit()
    expect(paused.calls.map((call) => call.key)).toEqual([SYNC_ARGV, COMMIT_ONLY_ARGV])

    const refused = harness()
    refused.answer(SYNC_ARGV, result('no-access'))
    refused.answer(COMMIT_ONLY_ARGV, result('committed'))
    await refused.engine.open(SLUG)
    refused.engine.commitAfterTurn(SLUG, 'turn in web')
    await refused.engine.quit()
    expect(refused.calls.map((call) => call.key)).toEqual([SYNC_ARGV, COMMIT_ONLY_ARGV])
    expect(refused.calls[1]?.message).toBe('Flow: turn in web')
  })

  it('lastSyncedAt survives a new engine instance', async () => {
    const rows = new Map<string, number>()
    const first = harness({ rows })
    first.answer(SYNC_ARGV, result('synced'))
    await first.engine.open(SLUG)
    // POSITIVE FIRST: written down.
    expect(rows.get(SLUG)).toBe(1_000_000)
    const second = harness({ rows })
    expect(second.engine.status(SLUG)).toEqual({
      state: 'idle',
      lastSyncedAt: new Date(1_000_000).toISOString(),
      detail: null,
      asks: [],
      reviews: [],
    })
    expect(second.calls).toEqual([])
  })
})

// ── Promotion before sync (FR-7, change note 7) ──

const PROMOTE_ARGV = `workspace promote --workspace ${SLUG} --json`

describe('workspace sync engine — promotion', () => {
  it('open runs `workspace promote` BEFORE the sync, bounded, through its own runner', async () => {
    const h = harness()
    let callsWhenPromoted = -1
    h.promoteAnswers.push(async () => {
      callsWhenPromoted = h.calls.length
      return promoted()
    })
    h.answer(SYNC_ARGV, result('synced'))
    await h.engine.open(SLUG)
    expect(h.promotions).toEqual([{ key: PROMOTE_ARGV, timeoutMs: PROMOTE_TIMEOUT_MS }])
    // Positive first: the sync ran — and the promotion came before it.
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV])
    expect(callsWhenPromoted).toBe(0)
  })

  it('"Sync now" runs it too, whatever its cooldown; a failed promotion never stops the sync', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced'), result('synced'))
    await h.engine.open(SLUG)
    h.promoteAnswers.push({ ok: false, stdout: '', error: 'timed out' })
    expect(await h.engine.syncNow(SLUG)).toMatchObject({ state: 'synced' })
    expect(h.promotions).toHaveLength(2)
    expect(h.calls).toHaveLength(2)
  })

  it('a promotion that decided something is carried by a sync even inside the open cooldown', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced'), result('synced'))
    await h.engine.open(SLUG)
    expect(h.calls).toHaveLength(1)
    // The timer: ten minutes on, a PR merged outside Flow is promoted, and its status lines are synced.
    h.promoteAnswers.push(promoted({ checked: 2, solid: 1, stale: 1 }))
    await h.timers.advance(PROMOTE_INTERVAL_MS)
    expect(h.promotions).toHaveLength(2)
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.message).toBe('Flow: knowledge status checked')
    // A promotion that decided nothing costs no sync.
    await h.timers.advance(PROMOTE_INTERVAL_MS)
    expect(h.promotions).toHaveLength(3)
    expect(h.calls).toHaveLength(2)
  })

  it('the cooldown keeps open and the timer from running it twice', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced'), result('synced'))
    await h.engine.open(SLUG)
    await h.timers.advance(OPEN_SYNC_COOLDOWN_MS)
    await h.engine.open(SLUG)
    // Positive first: the second open did sync…
    expect(h.calls).toHaveLength(2)
    // …but did not promote again inside the cooldown.
    expect(h.promotions).toHaveLength(1)
    await h.timers.advance(PROMOTE_COOLDOWN_MS)
    await h.engine.syncNow(SLUG).catch(() => undefined)
    expect(h.promotions).toHaveLength(2)
  })

  it('never while the sync waits for a person: not on open, not on "Sync now", not on the timer', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('ask', { asks: [ASK] }), result('ask', { asks: [ASK] }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'paused' })
    // Positive first: the open before the pause did promote.
    expect(h.promotions).toHaveLength(1)
    await h.timers.advance(PROMOTE_INTERVAL_MS * 3)
    await h.engine.open(SLUG)
    await h.engine.syncNow(SLUG)
    expect(h.calls).toHaveLength(2) // "Sync now" itself still ran
    expect(h.promotions).toHaveLength(1)
  })

  it('one promotion in flight: a slow one is never joined by a second', async () => {
    const h = harness()
    let finish: (run: WorkspaceSyncCliRun) => void = () => undefined
    h.promoteAnswers.push(() => new Promise<WorkspaceSyncCliRun>((resolveRun) => (finish = resolveRun)))
    h.answer(SYNC_ARGV, result('synced'), result('synced'))
    const opening = h.engine.open(SLUG)
    await settled()
    const syncing = h.engine.syncNow(SLUG)
    await h.timers.advance(PROMOTE_INTERVAL_MS)
    // Positive first: the first promotion IS running…
    expect(h.promotions).toHaveLength(1)
    expect(h.calls).toHaveLength(0)
    finish(promoted())
    await opening
    await syncing
    await settled()
    // …and the open's sync, then "Sync now" (a person: its own promotion) ran after it, one at a time.
    expect(h.calls).toHaveLength(2)
    expect(h.promotions).toHaveLength(2) // the timer's turn found the cooldown
  })

  it('forget and quit stop the timer', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('synced'))
    await h.engine.open(SLUG)
    h.engine.forget(SLUG)
    await h.timers.advance(PROMOTE_INTERVAL_MS * 2)
    expect(h.promotions).toHaveLength(1)
    expect(h.timers.tasks.size).toBe(0)
  })
})

// ── The agent decides a pause, applied in ONE batch (Phase 4, change note 7) ──

const NOTE_REVIEW = { ...REVIEW, options: ['ours', 'theirs', 'file'] }
const BATCH_ARGV = (hold: string): string =>
  `workspace sync --workspace ${SLUG} --decisions=/tmp/decision-0.md${hold === '' ? '' : ` --hold=${hold}`} --no-push --json`

/** The labels a fast-model batch gave its items, in order. */
function labelsIn(prompt: string): string[] {
  return [...prompt.matchAll(/<item label="([^"]+)"/g)].map((match) => match[1])
}

describe('workspace sync engine — the agent decides a pause', () => {
  it('ONE batch call with every decision, items left for a person held aside, nothing pushed — and no per-item resolve', async () => {
    const h = harness({
      nameOf: async () => 'Acme',
      decideFast: async ({ prompt }) => labelsIn(prompt).map((label) => `${label} theirs the teammate's holds it`).join('\n'),
    })
    // A note the agent may decide, and a decision document it may only suggest on.
    h.answer(SYNC_ARGV, result('review', { asks: [ASK], reviews: [NOTE_REVIEW] }))
    h.answer(
      BATCH_ARGV('ask-1'),
      result('merged-local', {
        awaitingReview: true,
        mergedItems: [
          { id: 'review-1', path: REVIEW.path, kind: 'conflict', take: 'theirs' },
          { id: 'ask-1', path: DECISION, kind: 'decision', take: 'theirs', held: true },
        ],
        heldAside: [{ id: 'ask-1', path: DECISION, kind: 'decision', heldAt: '2026-11-25T00:00:00.000Z' }],
      }),
    )
    await h.engine.open(SLUG)
    // Positive first: the agent was asked, and the CLI got ONE batch.
    expect(h.fastPrompts).toHaveLength(1)
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV, BATCH_ARGV('ask-1')])
    expect(h.calls.some((call) => call.key.includes('--resolve'))).toBe(false)
    // The batch decides only what the agent may decide; the held item carries no decision of its own.
    expect(JSON.parse(h.temps[0] as string)).toEqual({ decisions: [{ id: 'review-1', take: 'theirs' }] })
    expect(h.disposed).toEqual(['/tmp/decision-0.md'])
    // Merged here, waiting for review: nothing retries on its own, so nothing publishes it.
    expect(h.last()).toMatchObject({ state: 'review', detail: WORKSPACE_SYNC_SENTENCES.mergedForReview('Acme', 2), asks: [], reviews: [] })
    expect(h.timers.syncTimers()).toBe(0)
    // A turn during the review is only committed here.
    h.answer(COMMIT_ONLY_ARGV, result('committed', { heldAside: [{ id: 'ask-1', path: DECISION, kind: 'decision', heldAt: '2026-11-25T00:00:00.000Z' }] }))
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    await h.timers.advance(TURN_SYNC_DELAY_MS * 2)
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV, BATCH_ARGV('ask-1'), COMMIT_ONLY_ARGV])
    expect(h.last()).toMatchObject({ state: 'review' })
  })

  it('a merged text goes in the batch as content', async () => {
    const plan = { ...NOTE_REVIEW, id: 'review-plan', path: 'projects/api/plans/plan_q_v1.md' }
    const h = harness({
      decideFast: async ({ prompt }) => `${labelsIn(prompt)[0]} merge both changed it`,
      mergeIntent: async () => MERGED_TEXT,
    })
    h.answer(SYNC_ARGV, result('review', { reviews: [plan] }))
    h.answer(BATCH_ARGV(''), result('merged-local', { mergedItems: [{ id: 'review-plan', path: plan.path, kind: 'conflict', take: 'file' }], heldAside: [] }))
    await h.engine.open(SLUG)
    expect(JSON.parse(h.temps[0] as string)).toEqual({ decisions: [{ id: 'review-plan', take: 'file', content: MERGED_TEXT }] })
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV, BATCH_ARGV('')])
  })

  it('the agent unavailable → the pause, and its per-item choices, exactly as before — no batch', async () => {
    const h = harness({ nameOf: async () => 'Acme' })
    h.answer(SYNC_ARGV, result('review', { reviews: [NOTE_REVIEW] }))
    await h.engine.open(SLUG)
    expect(h.fastPrompts).toHaveLength(1)
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV])
    expect(h.last()).toMatchObject({ state: 'paused', reviews: [expect.objectContaining({ id: 'review-1' })] })
    expect(h.notices).toEqual([WORKSPACE_SYNC_SENTENCES.review('Acme')])
  })

  it('a batch the CLI refuses (a side changed meanwhile) leaves the pause as the CLI first put it', async () => {
    const h = harness({ decideFast: async ({ prompt }) => `${labelsIn(prompt)[0]} theirs ok` })
    h.answer(SYNC_ARGV, result('review', { reviews: [NOTE_REVIEW] }))
    h.answer(BATCH_ARGV(''), refused('stale-decision', { stale: ['review-1'] }))
    await h.engine.open(SLUG)
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV, BATCH_ARGV('')])
    expect(h.last()).toMatchObject({ state: 'paused', reviews: [expect.objectContaining({ id: 'review-1' })] })
  })

  it('reads the recorded reasons ONCE and hands those of the item\'s kind and project to the agent', async () => {
    const decision = (kind: string, project: string, reason: string, ts: string) => ({
      type: 'decision', id: reason, kind, project, path: 'p', take: 'theirs', summary: 'took theirs', reason, outcome: 'agreed', author: null, ts,
    })
    const h = harness({
      decideFast: async () => null,
      reasons: {
        ok: true,
        stdout: `${JSON.stringify({
          action: 'merge-decision',
          op: 'list',
          decisions: [
            decision('conflict', 'api', 'older reason', '2026-01-01'),
            decision('conflict', 'api', 'newer reason', '2026-02-01'),
            decision('conflict', 'web', 'other project', '2026-03-01'),
            decision('add-add', 'api', 'other kind', '2026-03-01'),
          ],
        })}\n`,
      },
    })
    h.answer(SYNC_ARGV, result('review', { reviews: [NOTE_REVIEW, { ...NOTE_REVIEW, id: 'review-2', path: 'projects/api/other.md' }] }))
    await h.engine.open(SLUG)
    expect(h.reasonReads).toEqual([`workspace merge-decision list --workspace ${SLUG} --json`])
    const prompt = h.fastPrompts[0] as string
    expect(prompt.indexOf('newer reason')).toBeLessThan(prompt.indexOf('older reason'))
    expect(prompt).not.toContain('other project')
    expect(prompt).not.toContain('other kind')
  })

  it('reviewOf groups what the CLI applied, lists what waits for a person, and what is held', () => {
    const review = reviewOf(
      Date.UTC(2026, 10, 25),
      [ASK as never, NOTE_REVIEW as never, { ...NOTE_REVIEW, id: 'review-2' } as never],
      {
        decisions: [
          { id: 'review-1', take: 'theirs', group: 'took-theirs', reason: 'r' },
          { id: 'review-2', take: 'ours', group: 'identical', reason: 'same' },
        ],
        needsYou: [{ id: 'ask-1', reason: 'decision-document', suggestion: { verdict: 'theirs', reason: 's' } }],
      },
      {
        mergedItems: [
          { id: 'review-1', path: REVIEW.path, take: 'theirs', held: false },
          { id: 'review-2', path: REVIEW.path, take: 'ours', held: false },
          { id: 'ask-1', path: DECISION, take: 'theirs', held: true },
        ],
        heldAside: [{ id: 'ask-1', path: DECISION, kind: 'decision', heldAt: 'then' }],
      },
    )
    expect(review).toEqual({
      mergedAt: '2026-11-25T00:00:00.000Z',
      groups: [
        { key: 'took-theirs', count: 1, items: [{ id: 'review-1', path: REVIEW.path, kind: 'conflict', take: 'theirs', reason: 'r', state: 'pending' }] },
        { key: 'identical', count: 1, items: [{ id: 'review-2', path: REVIEW.path, kind: 'conflict', take: 'ours', reason: 'same', state: 'pending' }] },
      ],
      needsYou: [
        { id: 'ask-1', path: DECISION, kind: 'decision', reason: 'decision-document', suggestion: { verdict: 'theirs', reason: 's' }, state: 'needs-you' },
      ],
      held: [{ id: 'ask-1', path: DECISION, kind: 'decision', heldAt: 'then', state: 'needs-you' }],
    })
  })
})

const MERGED_TEXT = '# Queue\n\nSQS for jobs, Kafka for events.\n'

// ── The review: nothing unagreed is shared (Phase 5) ──

const HELD_ASK = { id: 'ask-1', path: DECISION, kind: 'decision', heldAt: '2026-11-25T00:00:00.000Z' }
const NOTE_2 = { ...NOTE_REVIEW, id: 'review-2', path: 'projects/api/other.md' }
const SHARE_ARGV = `workspace sync --workspace ${SLUG} --agreed --json`
const HOLD_BACK_ARGV = (ids: string): string => `workspace sync --workspace ${SLUG} --commit-only --hold-back=${ids} --json`
const SETTLE_ARGV = (id: string, take: string): string => `workspace sync --workspace ${SLUG} --commit-only --settle-held=${id} --take=${take} --json`

/** A harness whose fast agent answers each call with the next verdict (the last one repeats). */
function reviewHarness(verdicts: string[] = ['theirs']) {
  let call = 0
  const h = harness({
    nameOf: async () => 'Acme',
    decideFast: async ({ prompt }) => {
      const verdict = verdicts[Math.min(call, verdicts.length - 1)]
      call += 1
      return labelsIn(prompt).map((label) => `${label} ${verdict} the agent's reason`).join('\n')
    },
  })
  return h
}

/** Open a Workspace whose pause the agent settles: two notes taken from the Workspace, a decision left to the person. */
async function inReview(h: ReturnType<typeof harness>): Promise<void> {
  h.answer(SYNC_ARGV, result('review', { asks: [ASK], reviews: [NOTE_REVIEW, NOTE_2] }))
  h.answer(
    BATCH_ARGV('ask-1'),
    result('merged-local', {
      awaitingReview: true,
      mergedItems: [
        { id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict', take: 'theirs' },
        { id: 'review-2', path: NOTE_2.path, kind: 'conflict', take: 'theirs' },
        { id: 'ask-1', path: DECISION, kind: 'decision', take: 'theirs', held: true },
      ],
      heldAside: [HELD_ASK],
    }),
  )
  await h.engine.open(SLUG)
  expect(h.last()).toMatchObject({ state: 'review' })
}

/** The items of a fast-model batch, as [label, file] pairs. */
function itemsIn(prompt: string): Array<[string, string]> {
  return [...prompt.matchAll(/<item label="([^"]+)" kind="[^"]+" file="([^"]+)"/g)].map((match) => [match[1] as string, match[2] as string])
}

/** The agent merges the first note into one text and takes the Workspace's version of the second; later calls keep mine. */
function twoGroupHarness() {
  let call = 0
  return harness({
    nameOf: async () => 'Acme',
    mergeIntent: async () => MERGED_TEXT,
    decideFast: async ({ prompt }) => {
      call += 1
      return itemsIn(prompt)
        .map(([label, file]) => `${label} ${call > 1 ? 'ours' : file === NOTE_REVIEW.path ? 'merge' : 'theirs'} the agent's reason`)
        .join('\n')
    },
  })
}

/** In review with two groups — "merged" (review-1) and "took the Workspace's version" (review-2) — and a decision left to the person. */
async function inTwoGroups(h: ReturnType<typeof harness>): Promise<void> {
  h.answer(SYNC_ARGV, result('review', { asks: [ASK], reviews: [NOTE_REVIEW, NOTE_2] }))
  h.answer(
    BATCH_ARGV('ask-1'),
    result('merged-local', {
      awaitingReview: true,
      mergedItems: [
        { id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict', take: 'file' },
        { id: 'review-2', path: NOTE_2.path, kind: 'conflict', take: 'theirs' },
        { id: 'ask-1', path: DECISION, kind: 'decision', take: 'theirs', held: true },
      ],
      heldAside: [HELD_ASK],
    }),
  )
  await h.engine.open(SLUG)
  expect(h.last()?.review?.groups.map((group) => group.key)).toEqual(['merged', 'took-theirs'])
}

/** The record lines the engine wrote, as their flags. */
function recordsOf(h: ReturnType<typeof harness>): string[] {
  return h.reasonReads.filter((key) => key.includes(' record '))
}

/** Every sync argv after the batch — none may publish while the review holds anything unagreed. */
function publishingRuns(h: ReturnType<typeof harness>): string[] {
  return h.calls.map((call) => call.key).filter((key) => !key.includes('--commit-only') && !key.includes('--no-push') && !key.includes('--agreed'))
}

describe('workspace sync engine — the review', () => {
  it('a review is its own state, with every item and its state, and ONE notice', async () => {
    const h = reviewHarness()
    await inReview(h)
    expect(h.last()).toMatchObject({
      state: 'review',
      detail: WORKSPACE_SYNC_SENTENCES.mergedForReview('Acme', 3),
      review: {
        groups: [
          {
            key: 'took-theirs',
            count: 2,
            items: [expect.objectContaining({ id: 'review-1', state: 'pending' }), expect.objectContaining({ id: 'review-2', state: 'pending' })],
          },
        ],
        needsYou: [expect.objectContaining({ id: 'ask-1', reason: 'decision-document', state: 'needs-you' })],
        held: [expect.objectContaining({ id: 'ask-1', state: 'needs-you' })],
      },
    })
    expect(h.notices).toEqual(['Flow merged 3 changes. Review them before they\'re shared.'])
    // A turn, an open and a "Sync now" later: still one notice.
    h.answer(COMMIT_ONLY_ARGV, result('committed', { heldAside: [HELD_ASK] }), result('committed', { heldAside: [HELD_ASK] }))
    h.engine.commitAfterTurn(SLUG, 'turn')
    await h.timers.advance(TURN_SYNC_DELAY_MS)
    await h.engine.syncNow(SLUG)
    expect(h.notices).toHaveLength(1)
  })

  it('while a review is open, "Sync now", a turn and an open only COMMIT here — no run that can publish', async () => {
    const h = reviewHarness()
    await inReview(h)
    h.answer(COMMIT_ONLY_ARGV, result('committed', { heldAside: [HELD_ASK] }), result('committed', { heldAside: [HELD_ASK] }))
    const before = h.calls.length
    const status = await h.engine.syncNow(SLUG)
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    await h.timers.advance(TURN_SYNC_DELAY_MS)
    await h.engine.open(SLUG)
    // Positive first (#28): the syncs DID run…
    expect(h.calls.slice(before).map((call) => call.key)).toEqual([COMMIT_ONLY_ARGV, COMMIT_ONLY_ARGV])
    expect(h.promotions).toHaveLength(1) // the first open's; none during the review
    // …and none of them could publish.
    expect(publishingRuns(h)).toEqual([SYNC_ARGV]) // only the first sync, before anything was merged
    expect(status.state).toBe('review')
    expect(h.timers.syncTimers()).toBe(0)
  })

  it('a run the engine did not plan (a pause decided while a review is open) carries --no-push', async () => {
    const h = reviewHarness(['theirs'])
    await inReview(h)
    // A new pause comes in during a share; the agent cannot settle it, so it waits for a person.
    h.answer(SHARE_ARGV, result('ask', { asks: [{ ...ASK, id: 'ask-9' }] }))
    h.answer(`workspace sync --workspace ${SLUG} --resolve=${DECISION} --id=ask-9 --take=ours --no-push --json`, result('merged-local', { mergedItems: [], heldAside: [HELD_ASK] }))
    await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    expect(h.last()).toMatchObject({ state: 'paused' })
    // The review still holds agreed, unshared changes: the person's decision may not publish them.
    const answer = await h.engine.resolve({ slug: SLUG, id: 'ask-9', path: DECISION, take: 'ours' })
    expect(answer.ok).toBe(true)
    expect(h.calls[h.calls.length - 1]?.key).toContain('--no-push')
    expect(h.last()).toMatchObject({ state: 'review' })
  })

  it('agreeing every decided item records each decision, one run at a time, then shares ONCE', async () => {
    const h = reviewHarness()
    await inReview(h)
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK] }))
    const answer = await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    // Positive first: shared…
    expect(answer).toMatchObject({ ok: true })
    expect(h.calls.filter((call) => call.key === SHARE_ARGV)).toHaveLength(1)
    expect(recordsOf(h)).toEqual([
      expect.stringContaining('--kind=conflict --project=api --path=projects/api/notes.md --take=theirs'),
      expect.stringContaining('--path=projects/api/other.md --take=theirs'),
    ])
    expect(recordsOf(h).every((key) => key.includes('--outcome=agreed'))).toBe(true)
    // …and what still needs the person stays, held aside — it never held the share.
    expect(h.last()).toMatchObject({ state: 'synced', review: { groups: [], needsYou: [expect.objectContaining({ id: 'ask-1', state: 'needs-you' })] } })

    // The person decides it: settled here, then shared on its own.
    h.answer(SETTLE_ARGV('ask-1', 'ours'), result('committed', { heldAside: [] }))
    h.answer(SHARE_ARGV, result('synced', { heldAside: [] }))
    const decided = await h.engine.reviewDecide({ slug: SLUG, id: 'ask-1', take: 'ours' })
    expect(decided).toMatchObject({ ok: true })
    expect(h.calls.map((call) => call.key).slice(-2)).toEqual([SETTLE_ARGV('ask-1', 'ours'), SHARE_ARGV])
    expect(recordsOf(h)[2]).toContain('--kind=decision')
    expect(h.last().review).toBeUndefined()
  })

  it('agreeing one group of two holds the other back in ONE local run, then shares the agreed group; agreeing the held group writes the agent\'s text and shares again', async () => {
    const h = twoGroupHarness()
    await inTwoGroups(h)
    const afterBatch = h.calls.length
    const heldMerged = { ...HELD_ASK, id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict' }
    h.answer(HOLD_BACK_ARGV('review-1'), result('committed', { heldAside: [HELD_ASK, heldMerged] }))
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK, heldMerged] }))
    const first = await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    // Positive first (#28): the agreed group WAS shared…
    expect(first).toMatchObject({ ok: true })
    // …after the untouched group was held back, in one run, and nothing else ran.
    expect(h.calls.slice(afterBatch).map((call) => call.key)).toEqual([HOLD_BACK_ARGV('review-1'), SHARE_ARGV])
    expect(recordsOf(h)).toEqual([expect.stringContaining('--path=projects/api/other.md --take=theirs')])
    // The held group waits here, still with the agent's decision and reason; "needs you" is untouched.
    expect(h.last()).toMatchObject({
      state: 'synced',
      review: {
        groups: [{ key: 'merged', count: 1, items: [expect.objectContaining({ id: 'review-1', take: 'file', state: 'held', reason: "the agent's reason" })] }],
        needsYou: [expect.objectContaining({ id: 'ask-1', state: 'needs-you' })],
      },
    })

    // Agreeing the held group writes the agent's MERGED text (the held store keeps this computer's own), then shares.
    h.answer(SETTLE_ARGV('review-1', 'file:/tmp/decision-1.md'), result('committed', { heldAside: [HELD_ASK] }))
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK] }))
    const second = await h.engine.reviewAgree({ slug: SLUG, group: 'merged' })
    expect(second).toMatchObject({ ok: true })
    expect(h.calls.slice(afterBatch).map((call) => call.key)).toEqual([HOLD_BACK_ARGV('review-1'), SHARE_ARGV, SETTLE_ARGV('review-1', 'file:/tmp/decision-1.md'), SHARE_ARGV])
    expect(h.temps[1]).toBe(MERGED_TEXT)
    expect(h.disposed).toContain('/tmp/decision-1.md')
    expect(recordsOf(h)[1]).toContain('--path=projects/api/notes.md --take=file')
    expect(h.last()).toMatchObject({ state: 'synced', review: { groups: [], needsYou: [expect.objectContaining({ id: 'ask-1' })] } })
    // Every run after the first sync was local, or a share a person agreed to: nothing pending was ever published.
    expect(publishingRuns(h)).toEqual([SYNC_ARGV])
  })

  it('a held-back "took the Workspace\'s version" decision, agreed later, keeps the Workspace\'s version', async () => {
    const h = twoGroupHarness()
    await inTwoGroups(h)
    const heldTheirs = { ...HELD_ASK, id: 'review-2', path: NOTE_2.path, kind: 'conflict' }
    h.answer(HOLD_BACK_ARGV('review-2'), result('committed', { heldAside: [HELD_ASK, heldTheirs] }))
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK, heldTheirs] }), result('synced', { heldAside: [HELD_ASK] }))
    await h.engine.reviewAgree({ slug: SLUG, group: 'merged' })
    h.answer(SETTLE_ARGV('review-2', 'theirs'), result('committed', { heldAside: [HELD_ASK] }))
    const answer = await h.engine.reviewAgree({ slug: SLUG, ids: ['review-2'] })
    expect(answer).toMatchObject({ ok: true })
    expect(h.calls.map((call) => call.key).slice(-2)).toEqual([SETTLE_ARGV('review-2', 'theirs'), SHARE_ARGV])
    expect(publishingRuns(h)).toEqual([SYNC_ARGV])
  })

  it('"Agree to all groups" shares in one go: nothing is held back, "needs you" stays', async () => {
    const h = twoGroupHarness()
    await inTwoGroups(h)
    const afterBatch = h.calls.length
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK] }))
    const answer = await h.engine.reviewAgree({ slug: SLUG, allGroups: true })
    expect(answer).toMatchObject({ ok: true })
    expect(h.calls.slice(afterBatch).map((call) => call.key)).toEqual([SHARE_ARGV])
    expect(h.calls.some((call) => call.key.includes('--hold-back'))).toBe(false)
    expect(recordsOf(h)).toHaveLength(2)
    expect(h.last()).toMatchObject({ state: 'synced', review: { groups: [], needsYou: [expect.objectContaining({ id: 'ask-1', state: 'needs-you' })] } })
  })

  it('when the untouched items cannot be held back, nothing is shared — and the answer says so', async () => {
    const h = twoGroupHarness()
    await inTwoGroups(h)
    h.answer(HOLD_BACK_ARGV('review-1'), refused('stale-decision'))
    const answer = await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    // Positive first: the hold-back WAS tried…
    expect(h.calls[h.calls.length - 1]?.key).toBe(HOLD_BACK_ARGV('review-1'))
    // …and nothing went out after it.
    expect(answer).toMatchObject({ ok: false, reason: 'not-shared', detail: WORKSPACE_SYNC_SENTENCES.pendingChanged('Acme') })
    expect(h.calls.some((call) => call.key.includes('--agreed'))).toBe(false)
    expect(h.last()).toMatchObject({ state: 'review', detail: WORKSPACE_SYNC_SENTENCES.pendingChanged('Acme') })
    expect(h.last().review?.groups.map((group) => group.items.map((item) => item.state))).toEqual([['pending'], ['agreed']])
  })

  it('a held-back decision can still be disagreed with: no second hold-back, the agent tries again', async () => {
    const h = twoGroupHarness()
    await inTwoGroups(h)
    const heldMerged = { ...HELD_ASK, id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict' }
    h.answer(HOLD_BACK_ARGV('review-1'), result('committed', { heldAside: [HELD_ASK, heldMerged] }))
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK, heldMerged] }))
    await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    const prompts = h.fastPrompts.length
    const answer = await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: 'keep mine' })
    expect(answer).toMatchObject({ ok: true })
    expect(h.fastPrompts.length).toBeGreaterThan(prompts)
    expect(h.calls.filter((call) => call.key.includes('--hold-back'))).toHaveLength(1)
    expect(h.last().review?.groups[0]?.items[0]).toMatchObject({ id: 'review-1', state: 'redone', disagreedReason: 'keep mine' })
  })

  it('"needs you" is never agreed in bulk — by id or in a group that holds one', async () => {
    const h = reviewHarness(['theirs', 'ours'])
    await inReview(h)
    const byId = await h.engine.reviewAgree({ slug: SLUG, ids: ['review-1', 'ask-1'] })
    expect(byId).toMatchObject({ ok: false, reason: 'needs-decision', detail: WORKSPACE_SYNC_SENTENCES.needsDecision })
    // A twice-disagreed item makes its group need the person too.
    h.answer(HOLD_BACK_ARGV('review-1'), result('committed', { heldAside: [HELD_ASK, { ...HELD_ASK, id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict' }] }))
    await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: 'keep mine' })
    await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: 'still mine' })
    const byGroup = await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    expect(byGroup).toMatchObject({ ok: false, reason: 'needs-decision' })
    // Nothing was marked by the refused requests.
    expect(h.last().review?.groups[0]?.items.find((item) => item.id === 'review-2')?.state).toBe('pending')
    expect(h.calls.some((call) => call.key.includes('--agreed'))).toBe(false)
  })

  it('a disagreement needs a reason', async () => {
    const h = reviewHarness()
    await inReview(h)
    const before = h.calls.length
    const answer = await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: '   ' })
    expect(answer).toMatchObject({ ok: false, reason: 'reason-required', detail: WORKSPACE_SYNC_SENTENCES.reasonRequired })
    expect(h.calls).toHaveLength(before)
    expect(recordsOf(h)).toEqual([])
  })

  it('disagree → held back and redone once with the reason → a second disagreement leaves it to the person, who decides', async () => {
    const h = reviewHarness(['theirs', 'ours'])
    await inReview(h)
    const heldReview = { ...HELD_ASK, id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict' }
    h.answer(HOLD_BACK_ARGV('review-1'), result('committed', { heldAside: [HELD_ASK, heldReview] }))
    const first = await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: 'this computer has the newer note' })
    expect(first).toMatchObject({ ok: true })
    // Held back first (the Workspace's version committed, this computer's text aside), the reason recorded…
    expect(h.calls[h.calls.length - 1]?.key).toBe(HOLD_BACK_ARGV('review-1'))
    expect(recordsOf(h)).toEqual([expect.stringContaining('--outcome=disagreed')])
    expect(recordsOf(h)[0]).toContain('--reason=this computer has the newer note')
    // …then the agent decided it again, with the reason in its prompt.
    expect(h.fastPrompts).toHaveLength(2)
    expect(h.fastPrompts[1]).toContain('this computer has the newer note')
    const redone = h.last().review?.groups[0]?.items.find((item) => item.id === 'review-1')
    expect(redone).toMatchObject({ state: 'redone', disagreedReason: 'this computer has the newer note', redo: { take: 'ours' } })

    // A second disagreement: no third try, the person decides.
    const second = await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: 'not like that either' })
    expect(second).toMatchObject({ ok: true })
    expect(h.fastPrompts).toHaveLength(2)
    expect(h.calls.filter((call) => call.key.includes('--hold-back'))).toHaveLength(1)
    expect(h.last().review?.groups[0]?.items.find((item) => item.id === 'review-1')?.state).toBe('needs-you')

    // The person writes the text: the held item is settled here, never shared yet (review-2 is untouched).
    h.answer(SETTLE_ARGV('review-1', 'file:/tmp/decision-1.md'), result('committed', { heldAside: [HELD_ASK] }))
    const decided = await h.engine.reviewDecide({ slug: SLUG, id: 'review-1', take: 'text', text: 'both\n' })
    expect(decided).toMatchObject({ ok: true })
    expect(h.temps[1]).toBe('both\n')
    expect(h.disposed).toContain('/tmp/decision-1.md')
    expect(h.last().review?.groups[0]?.items.find((item) => item.id === 'review-1')?.state).toBe('agreed')
    expect(publishingRuns(h)).toEqual([SYNC_ARGV])
  })

  it('agreeing a redo writes it here, then the share goes out', async () => {
    const h = reviewHarness(['theirs', 'ours'])
    await inReview(h)
    const heldReview = { ...HELD_ASK, id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict' }
    h.answer(HOLD_BACK_ARGV('review-1'), result('committed', { heldAside: [HELD_ASK, heldReview] }))
    await h.engine.reviewDisagree({ slug: SLUG, ids: ['review-1'], reason: 'mine is newer' })
    h.answer(SETTLE_ARGV('review-1', 'ours'), result('committed', { heldAside: [HELD_ASK] }))
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK] }))
    const answer = await h.engine.reviewAgree({ slug: SLUG, ids: ['review-1', 'review-2'] })
    expect(answer).toMatchObject({ ok: true })
    expect(h.calls.map((call) => call.key).slice(-2)).toEqual([SETTLE_ARGV('review-1', 'ours'), SHARE_ARGV])
    // The agreed redo is recorded with the person's reason.
    expect(recordsOf(h).find((key) => key.includes('--outcome=agreed') && key.includes('notes.md'))).toContain('--reason=mine is newer')
  })

  it('a share that did not go out is reported as not shared — the review stays open and says why; "Sync now" tries again', async () => {
    const h = reviewHarness()
    await inReview(h)
    h.answer(SHARE_ARGV, result('offline', { heldAside: [HELD_ASK] }))
    const answer = await h.engine.reviewAgree({ slug: SLUG, group: 'took-theirs' })
    expect(answer).toMatchObject({ ok: false, reason: 'not-shared', detail: WORKSPACE_SYNC_SENTENCES.offline('Acme') })
    expect(h.last()).toMatchObject({ state: 'review', detail: WORKSPACE_SYNC_SENTENCES.offline('Acme') })
    expect(h.last().review?.groups[0]?.items.map((item) => item.state)).toEqual(['agreed', 'agreed'])
    // Nothing retries on its own over a review.
    expect(h.timers.syncTimers()).toBe(0)
    // A refused share too.
    h.answer(SHARE_ARGV, refused('personal-files'))
    const refusedShare = await h.engine.syncNow(SLUG)
    expect(refusedShare).toMatchObject({ state: 'review', detail: WORKSPACE_SYNC_SENTENCES.personalFiles('Acme') })
    // "Sync now" shares again; the decisions are not recorded twice.
    h.answer(SHARE_ARGV, result('synced', { heldAside: [HELD_ASK] }))
    const shared = await h.engine.syncNow(SLUG)
    expect(shared.state).toBe('synced')
    expect(h.calls.filter((call) => call.key === SHARE_ARGV)).toHaveLength(3)
    expect(recordsOf(h)).toHaveLength(2)
  })

  it('after a restart the CLI\'s own record brings the review back — and it is still never shared unagreed', async () => {
    const h = harness({ nameOf: async () => 'Acme' })
    // The CLI refuses to publish an open review without --agreed and says merged-local.
    h.answer(
      SYNC_ARGV,
      result('merged-local', {
        awaitingReview: true,
        mergedItems: [{ id: 'review-1', path: NOTE_REVIEW.path, kind: 'conflict', take: 'file' }],
        heldAside: [HELD_ASK],
      }),
    )
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({
      state: 'review',
      review: {
        groups: [{ key: 'merged', count: 1, items: [expect.objectContaining({ id: 'review-1', state: 'pending' })] }],
        held: [expect.objectContaining({ id: 'ask-1', state: 'held' })],
      },
    })
    h.answer(COMMIT_ONLY_ARGV, result('committed', { heldAside: [HELD_ASK] }))
    await h.engine.syncNow(SLUG)
    expect(h.calls.map((call) => call.key)).toEqual([SYNC_ARGV, COMMIT_ONLY_ARGV])
    // A held item with no decision remembered is the person's to decide, never to agree.
    const agreed = await h.engine.reviewAgree({ slug: SLUG, ids: ['ask-1'] })
    expect(agreed).toMatchObject({ ok: false, reason: 'needs-decision' })
  })

  it('a request with no review open, or about an item not in it, says so', async () => {
    const h = reviewHarness()
    expect(await h.engine.reviewAgree({ slug: SLUG, group: 'merged' })).toMatchObject({ ok: false, reason: 'not-waiting' })
    await inReview(h)
    expect(await h.engine.reviewAgree({ slug: SLUG, ids: ['nope'] })).toMatchObject({ ok: false, reason: 'not-waiting' })
    expect(await h.engine.reviewDecide({ slug: SLUG, id: 'review-1', take: 'ours' })).toMatchObject({ ok: false, reason: 'not-allowed' })
    expect(await h.engine.reviewAgree({ slug: 'Not A Slug', group: 'merged' })).toMatchObject({ ok: false, reason: 'unknown-workspace' })
  })
})
