import type { SubtaskRecord, ThreadMessage, ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import { activityRows, activityStripState, type BackgroundActivityRow } from './background-activity-model'
import {
  backgroundWorkView,
  commandRun,
  formatWorkDuration,
  OTHER_WORK,
  previewOf,
  QUEUED_NOTE,
  retryPrompt,
  subtaskChains,
  transcriptSteps,
  YOUR_SUBTASKS,
  type BackgroundWorkView,
  type SourceMessage,
  type WorkItem,
} from './background-work-model'

const T0 = Date.parse('2026-10-22T10:00:00.000Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

function spawn(
  id: string,
  description: string,
  options: { status?: ToolCallStatus; start?: number; end?: number | null } = {},
): ToolCallRecord {
  return {
    id,
    threadId: 't1',
    messageId: null,
    toolName: 'Agent',
    inputJson: JSON.stringify({ description, subagent_type: 'general-purpose' }),
    outputJson: null,
    status: options.status ?? 'running',
    startedAt: at(options.start ?? 0),
    completedAt: options.end === undefined || options.end === null ? null : at(options.end),
  }
}

function subtask(ticket: string, overrides: Partial<SubtaskRecord> = {}): SubtaskRecord {
  return {
    ticket,
    threadId: 't1',
    fromMessageId: null,
    title: `Task ${ticket}`,
    task: 'do it',
    state: 'running',
    attempt: 1,
    retryOf: null,
    toolCallId: null,
    sdkTaskId: null,
    createdAt: at(0),
    startedAt: at(0),
    endedAt: null,
    error: null,
    filesWritten: [],
    overlapFiles: [],
    ...overrides,
  }
}

const msg = (id: string, content: string, seconds: number): SourceMessage => ({ id, content, createdAt: at(seconds) })

function view(
  rows: BackgroundActivityRow[],
  subtasks: SubtaskRecord[],
  userMessages: SourceMessage[] = [],
  now = T0 + 200_000,
): BackgroundWorkView {
  return backgroundWorkView({ rows, subtasks, userMessages, now })
}

const items = (v: BackgroundWorkView, state: string): WorkItem[] =>
  v.sections.find((section) => section.state === state)?.groups.flatMap((group) => group.items) ?? []

describe('backgroundWorkView — sections and origins', () => {
  it('puts your subtasks first, then skill work grouped by run', () => {
    const messages = [msg('u1', '/execute-plan @plan.md', 0), msg('u2', 'also the sign in is broken again', 50)]
    const rows = activityRows([
      spawn('a1', 'Phase 3 · Subtask record', { start: 10 }),
      spawn('a2', 'Phase 2 · Send mid-run', { status: 'success', start: 5, end: 9 }),
      spawn('a3', 'Find and fix sign-in', { start: 60 }),
    ])
    const v = view(rows, [subtask('st-1', { title: 'Find and fix sign-in', toolCallId: 'a3', fromMessageId: 'u2', startedAt: at(60) })], messages)
    const running = v.sections.find((section) => section.state === 'running')
    expect(running?.title).toBe('Running · 2')
    expect(running?.groups.map((group) => group.title)).toEqual([YOUR_SUBTASKS, 'Execute plan · 2 phases'])
    // The subtask's spawn is drawn once — as the subtask.
    const subtaskItem = running?.groups[0]?.items[0]
    expect(subtaskItem).toMatchObject({
      origin: 'subtask',
      title: 'Find and fix sign-in',
      subline: 'from “also the sign in is broken again”',
      canStop: true,
      canSteer: true,
      canRetry: false,
      toolCallId: 'a3',
    })
    expect(subtaskItem?.row?.id).toBe('a3')
    const skill = running?.groups[1]?.items[0]
    expect(skill).toMatchObject({ origin: 'skill', subline: 'part of the plan run', canStop: false, canSteer: false })
    // Done is a closed section of its own.
    const done = v.sections.find((section) => section.state === 'done')
    expect(done).toMatchObject({ title: 'Done · 1', collapsed: true })
  })

  it('groups skill work with no command as other background work', () => {
    const rows = activityRows([spawn('a1', 'Map the code', { start: 10 })])
    const v = view(rows, [], [msg('u1', 'look at the sidebar', 0)])
    expect(v.sections[0]?.groups[0]?.title).toBe(OTHER_WORK)
    expect(v.sections[0]?.groups[0]?.items[0]?.subline).toBeNull()
  })

  it('never shows the sub-agent type as the label', () => {
    const rows = activityRows([spawn('a1', 'Map the code', { start: 10 })])
    const item = view(rows, [])[`sections`][0]?.groups[0]?.items[0]
    expect(item?.title).toBe('Map the code')
    expect(JSON.stringify(item?.subline)).not.toContain('general-purpose')
  })

  it('says queued subtasks wait for a slot and offers no actions on them', () => {
    const v = view([], [subtask('st-q', { state: 'queued', startedAt: null })])
    expect(items(v, 'queued')[0]).toMatchObject({ subline: QUEUED_NOTE, canStop: false, canSteer: false, meta: '' })
    expect(v.counts).toEqual({ running: 0, queued: 1, failed: 0 })
  })

  it('reads stopped work as done, with the word stopped', () => {
    const v = view([], [subtask('st-s', { state: 'stopped', endedAt: at(30) })])
    expect(items(v, 'done')[0]).toMatchObject({ tone: 'stopped', meta: 'stopped · 30s' })
  })
})

describe('backgroundWorkView — the current request', () => {
  it('counts a failure of the current request and offers Retry', () => {
    const v = view([], [subtask('st-f', { state: 'failed', error: '2 of 18 tests failed\nmore', endedAt: at(240), createdAt: at(10) })], [
      msg('u1', 'build the sidebar', 5),
    ])
    expect(v.counts.failed).toBe(1)
    const failed = items(v, 'failed')[0]
    expect(failed).toMatchObject({ canRetry: true, subline: '2 of 18 tests failed', meta: 'attempt 1 · 4m' })
    expect(activityStripState(v.counts).label).toBe('1 failed')
  })

  it('moves a failure from an earlier request to Done', () => {
    const v = view([], [subtask('st-f', { state: 'failed', endedAt: at(30), createdAt: at(10) })], [
      msg('u1', 'first', 5),
      msg('u2', 'next request', 100),
    ])
    // POSITIVE FIRST: it is listed …
    expect(items(v, 'done')).toHaveLength(1)
    // … just not as a failure of this request.
    expect(v.counts.failed).toBe(0)
  })

  it('counts running work from any request — it is live', () => {
    const v = view(activityRows([spawn('a1', 'Old run', { start: 10 })]), [], [msg('u1', 'one', 0), msg('u2', 'two', 100)])
    expect(v.counts.running).toBe(1)
  })
})

describe('backgroundWorkView — attempts and runs', () => {
  it('folds a retry chain into one row that says the attempt', () => {
    const first = subtask('st-1', { state: 'failed', error: '2 of 18 tests failed', startedAt: at(0), endedAt: at(240) })
    const second = subtask('st-2', { state: 'failed', attempt: 2, retryOf: 'st-1', error: '1 of 18 tests failed', startedAt: at(250), endedAt: at(370) })
    const v = view([], [first, second], [msg('u1', 'go', 0)])
    const failed = items(v, 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ ticket: 'st-2', meta: 'attempt 2 · 2m' })
    expect(failed[0]?.attempts.map((attempt) => attempt.text)).toEqual([
      'Attempt 1 — 2 of 18 tests failed',
      'Attempt 2 — 1 of 18 tests failed',
    ])
    expect(v.counts.failed).toBe(1)
  })

  it('a running retry reads attempt 2 and leaves Failed', () => {
    const v = view([], [
      subtask('st-1', { state: 'failed', endedAt: at(30) }),
      subtask('st-2', { attempt: 2, retryOf: 'st-1', startedAt: at(40) }),
    ])
    expect(v.counts).toEqual({ running: 1, queued: 0, failed: 0 })
    expect(items(v, 'running')[0]?.meta.startsWith('attempt 2')).toBe(true)
  })

  it('shows same-title skill rows as runs, never as attempts', () => {
    const rows = activityRows([
      spawn('a1', 'Match the web UI', { status: 'success', start: 1, end: 5 }),
      spawn('a2', 'Match the web UI', { start: 10 }),
    ])
    const v = view(rows, [], [msg('u1', '/execute-plan x', 0)])
    const running = items(v, 'running')
    expect(running).toHaveLength(1)
    expect(running[0]?.runs).toBe(2)
    expect(running[0]?.meta).toMatch(/^2 runs · /)
    expect(running[0]?.meta).not.toContain('attempt')
    expect(running[0]?.attempts).toEqual([])
  })

  it('builds chains oldest attempt first', () => {
    const chains = subtaskChains([
      subtask('c', { retryOf: 'b', attempt: 3 }),
      subtask('a'),
      subtask('b', { retryOf: 'a', attempt: 2 }),
      subtask('x'),
    ])
    expect(chains.map((chain) => chain.map((record) => record.ticket))).toEqual([['a', 'b', 'c'], ['x']])
  })
})

describe('backgroundWorkView — overlaps', () => {
  it('carries the shared files for the tag and the warning', () => {
    const v = view([], [subtask('st-1', { filesWritten: ['src/a.ts', 'src/b.ts'], overlapFiles: ['src/a.ts'] })])
    expect(items(v, 'running')[0]).toMatchObject({ overlapFiles: ['src/a.ts'], filesWritten: ['src/a.ts', 'src/b.ts'] })
  })
})

describe('helpers', () => {
  it('humanises a command run, and names the plan run plainly', () => {
    expect(commandRun('/execute-plan @flow/plans/x.md')).toEqual({ name: 'Execute plan', noun: 'plan' })
    expect(commandRun('/review-code')).toEqual({ name: 'Review code', noun: 'review code' })
    expect(commandRun('please /execute-plan')).toBeNull()
    expect(commandRun('fix it')).toBeNull()
  })

  it('formats durations', () => {
    expect(formatWorkDuration(192_000, true)).toBe('3m 12s')
    expect(formatWorkDuration(41_000, true)).toBe('0m 41s')
    expect(formatWorkDuration(240_000, false)).toBe('4m')
    expect(formatWorkDuration(41_000, false)).toBe('41s')
  })

  it('previews the first line', () => {
    expect(previewOf('short')).toBe('short')
    expect(previewOf('a'.repeat(60))).toBe('a'.repeat(48) + '…')
    expect(previewOf('one\ntwo')).toBe('one')
  })

  it('writes the retry request in plain words', () => {
    expect(retryPrompt('Build the\nsidebar', 'st-9')).toBe('Please retry the subtask “Build the sidebar” (ticket st-9).')
  })
})

describe('transcriptSteps', () => {
  const message = (id: string, content: string, seconds: number): ThreadMessage => ({
    id,
    threadId: 't1',
    role: 'assistant',
    content,
    createdAt: at(seconds),
    model: null,
  })
  const call = (id: string, seconds: number): ToolCallRecord => ({ ...spawn(id, 'x', { start: seconds }), toolName: 'Read' })

  it('numbers each speaking message and counts the tools after it', () => {
    const steps = transcriptSteps(
      [message('m1', 'Read the sign-in flow', 1), message('m2', '', 3), message('m3', '**Fix** the state check', 5)],
      [call('t1', 2), call('t2', 4), call('t3', 6)],
      true,
    )
    expect(steps).toEqual([
      { number: 1, text: 'Read the sign-in flow', tools: 2, running: false },
      { number: 2, text: 'Fix the state check', tools: 1, running: true },
    ])
  })

  it('opens a head-less step for tools before any message', () => {
    expect(transcriptSteps([], [call('t1', 1)], false)).toEqual([{ number: 1, text: 'Tools', tools: 1, running: false }])
  })
})
