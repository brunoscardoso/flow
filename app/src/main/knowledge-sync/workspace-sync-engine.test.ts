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
  QUIT_SYNC_TIMEOUT_MS,
  TURN_SYNC_DELAY_MS,
  WORKSPACE_SYNC_SENTENCES,
  createWorkspaceSyncEngine,
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

  delays(): number[] {
    return [...this.tasks.values()].map((task) => task.ms)
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

function harness(
  options: { rows?: Map<string, number>; nameOf?: (slug: string) => Promise<string | null> } = {},
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
  const engine = createWorkspaceSyncEngine({
    nameOf: options.nameOf ?? (async () => null),
    runCli: async (cwd, args, runOptions) => {
      const key = keyOf(args)
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
  return { engine, timers, calls, statuses, names, notices, rows, temps, disposed, answer, last: () => statuses[statuses.length - 1] }
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
    expect(h.timers.tasks.size).toBe(0)
  })

  it('many distinct turns are counted, not listed', () => {
    expect(turnsMessage(['a', 'b', 'c', 'd'])).toBe('Flow: 4 turns')
  })

  it('a turn timer re-checks before it acts: a Workspace forgotten meanwhile (deleted) → no CLI call', async () => {
    const h = harness()
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    expect(h.timers.tasks.size).toBe(1)
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
    expect(h.timers.tasks.size).toBe(0)
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
    expect(h.timers.tasks.size).toBe(0)
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
    expect(h.last()).toMatchObject({ state: 'error', detail: WORKSPACE_SYNC_SENTENCES.unrelatedHistory('Acme') })
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
    expect(h.timers.tasks.size).toBe(0)
  })

  it('a refusal is an error with a plain sentence — never the CLI words — and one notification', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, refused('personal-files', { paths: ['projects/api/STATE.md'] }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'error', detail: 'Some of the changes in the Workspace are personal files that are never shared, so nothing was sent.' })
    expect(JSON.stringify(h.last())).not.toMatch(/secret|STATE\.md|planflow|--/)
    expect(h.notices).toHaveLength(1)
    expect(h.timers.tasks.size).toBe(0)
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

  it('no-access → its own state and sentence, ONE notification, and nothing retries until "Sync now"', async () => {
    const h = harness()
    h.answer(SYNC_ARGV, result('no-access', { detail: 'remote: Repository not found. https://github.com/acme/knowledge.git', ahead: 1 }))
    await h.engine.open(SLUG)
    expect(h.last()).toMatchObject({ state: 'no-access', detail: "Flow can't reach Acme's shared repository with your access." })
    expect(JSON.stringify(h.last())).not.toMatch(/github\.com|Repository not found/)
    expect(h.notices).toEqual(["Flow can't reach Acme's shared repository with your access."])
    // No back-off, no timer: a turn, an open and time all leave it alone.
    expect(h.timers.tasks.size).toBe(0)
    h.engine.commitAfterTurn(SLUG, 'turn in api')
    expect(h.timers.tasks.size).toBe(0)
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
    expect(h.timers.tasks.size).toBe(0)
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
