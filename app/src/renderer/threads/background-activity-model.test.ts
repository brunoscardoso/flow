// Pure model tests for the background-activity list (#1931). No DOM — these pin
// what counts as background work (a sub-agent spawn — 'Agent' as the live SDK
// names it, 'Task' as legacy rows do — nothing else), how a row is named, and
// the footer button's count/running state.

import type { BackgroundTaskInfo, ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import {
  activityKind,
  activityRows,
  activityStripState,
  resolveTaskToolCallId,
  statusTone,
  subagentOpenTarget,
  subagentRunState,
  subagentSpawnChip,
  toActivityRow,
  trackerTaskFor,
} from './background-activity-model'

function call(overrides: Partial<ToolCallRecord> & { id: string; toolName: string }): ToolCallRecord {
  return {
    threadId: 't1',
    messageId: null,
    inputJson: null,
    outputJson: null,
    status: 'success' as ToolCallStatus,
    startedAt: '2026-09-30T00:00:00.000Z',
    completedAt: '2026-09-30T00:00:01.000Z',
    ...overrides,
  }
}

describe('activityKind', () => {
  it("maps 'Agent' — the name SDK 0.3.204 actually emits — to subagent", () => {
    expect(activityKind('Agent')).toBe('subagent')
  })

  it("keeps mapping legacy 'Task' rows already persisted in user DBs", () => {
    expect(activityKind('Task')).toBe('subagent')
  })

  it('is null for Bash and every foreground tool (#1931 — sub-agents only)', () => {
    for (const name of ['Bash', 'Edit', 'Read', 'Grep', 'Write', 'Glob', 'WebFetch']) {
      expect(activityKind(name)).toBeNull()
    }
  })
})

describe('toActivityRow', () => {
  it('drops a non-background tool call', () => {
    expect(toActivityRow(call({ id: 'a', toolName: 'Edit' }))).toBeNull()
  })

  it('names a sub-agent by its description, keeps the type as detail', () => {
    const row = toActivityRow(
      call({
        id: 'a',
        toolName: 'Agent',
        inputJson: JSON.stringify({ description: 'Review: bugs', subagent_type: 'code-reviewer' }),
      }),
    )
    expect(row).toMatchObject({ kind: 'subagent', label: 'Review: bugs', detail: 'code-reviewer' })
  })

  it('falls back to the sub-agent type, then a default, when no description', () => {
    expect(
      toActivityRow(call({ id: 'a', toolName: 'Agent', inputJson: JSON.stringify({ subagent_type: 'general-purpose' }) }))
        ?.label,
    ).toBe('general-purpose')
    expect(toActivityRow(call({ id: 'b', toolName: 'Agent', inputJson: '{}' }))?.label).toBe('Sub-agent')
  })

  it('drops a Bash/terminal run (#1931 — sub-agents only)', () => {
    expect(
      toActivityRow(
        call({
          id: 'a',
          toolName: 'Bash',
          inputJson: JSON.stringify({ description: 'Run tests', command: 'npm test' }),
        }),
      ),
    ).toBeNull()
  })

  it('reads running from pending and running status', () => {
    expect(toActivityRow(call({ id: 'a', toolName: 'Agent', status: 'running' }))?.running).toBe(true)
    expect(toActivityRow(call({ id: 'b', toolName: 'Agent', status: 'pending' }))?.running).toBe(true)
    expect(toActivityRow(call({ id: 'c', toolName: 'Agent', status: 'success' }))?.running).toBe(false)
  })

  it('survives malformed input json', () => {
    const row = toActivityRow(call({ id: 'a', toolName: 'Agent', inputJson: '{not json' }))
    expect(row?.label).toBe('Sub-agent')
  })
})

describe('activityRows', () => {
  it('keeps only sub-agent calls, in the given order', () => {
    const rows = activityRows([
      call({ id: 'a', toolName: 'Agent', inputJson: JSON.stringify({ description: 'first' }) }),
      call({ id: 'b', toolName: 'Edit' }),
      call({ id: 'c', toolName: 'Bash', inputJson: JSON.stringify({ command: 'second' }) }),
      call({ id: 'd', toolName: 'Agent', inputJson: JSON.stringify({ description: 'second' }) }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['a', 'd'])
  })

  it("keeps a legacy 'Task' row alongside live 'Agent' rows (back-compat)", () => {
    const rows = activityRows([
      call({ id: 'new', toolName: 'Agent', inputJson: JSON.stringify({ description: 'live' }) }),
      call({ id: 'old', toolName: 'Task', inputJson: JSON.stringify({ description: 'legacy' }) }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
  })
})

describe('activityStripState', () => {
  it('hides when there is nothing running, queued or failed', () => {
    expect(activityStripState({ running: 0, queued: 0, failed: 0 }).show).toBe(false)
  })

  it('says the live counts, failed marked for the error colour', () => {
    const state = activityStripState({ running: 4, queued: 1, failed: 1 })
    expect(state.show).toBe(true)
    expect(state.label).toBe('4 running · 1 queued · 1 failed')
    expect(state.segments).toEqual([
      { text: '4 running', failed: false },
      { text: '1 queued', failed: false },
      { text: '1 failed', failed: true },
    ])
    expect(state.title).toBe('Background work: 4 running, 1 queued, 1 failed')
  })

  it('omits zero counts', () => {
    expect(activityStripState({ running: 2, queued: 0, failed: 0 }).label).toBe('2 running')
  })

  it('stays up for a failure alone — the person can retry it from the panel', () => {
    // POSITIVE FIRST (allowed-pattern #28): no failure, no pill.
    expect(activityStripState({ running: 0, queued: 0, failed: 0 }).show).toBe(false)
    const state = activityStripState({ running: 0, queued: 0, failed: 1 })
    expect(state.show).toBe(true)
    expect(state.label).toBe('1 failed')
  })

  it('leaves every finished spawn reachable as a chip in the transcript', () => {
    // The strip is the door that closes; this is the one that stays open, and
    // both press through the same open flow. Without this the change would be
    // a removal rather than a move.
    const finished = subagentSpawnChip(
      'Agent',
      JSON.stringify({ description: 'Map backend notification system', subagent_type: 'Explore' }),
      'success',
    )
    expect(finished).toEqual({
      label: 'Map backend notification system',
      detail: 'Explore',
      state: 'finished',
    })
  })
})

// ── Live task → persisted row resolution (#1931 D-4/D-5) ─────────────────────
// Real vocabulary throughout: the persisted spawn is 'Agent' (SDK 0.3.204),
// the live task is 'local_agent'.

function liveTask(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: 'task-1',
    taskType: 'local_agent',
    description: 'Deep research pass',
    agentType: 'general-purpose',
    startedAt: '2026-10-07T12:00:00.000Z',
    ...overrides,
  }
}

function agentSpawn(
  id: string,
  input: { description?: string; subagent_type?: string },
  status: ToolCallStatus = 'running',
): ToolCallRecord {
  return call({ id, toolName: 'Agent', status, inputJson: JSON.stringify(input) })
}

describe('resolveTaskToolCallId', () => {
  it('joins deterministically on the resolved spawn record id (toolCallId)', () => {
    const records = [
      agentSpawn('rec-a', { description: 'Something else', subagent_type: 'general-purpose' }),
      agentSpawn('rec-b', { description: 'Deep research pass', subagent_type: 'general-purpose' }),
    ]
    expect(resolveTaskToolCallId(liveTask({ toolCallId: 'rec-a' }), records)).toBe('rec-a')
  })

  it('returns null for a deterministic claim that cannot be verified — never falls to heuristics', () => {
    // A claimed id missing from the list is exactly when a guess is most
    // dangerous: the heuristic could pick a DIFFERENT row than the claim names.
    const records = [agentSpawn('rec-b', { description: 'Deep research pass' })]
    expect(resolveTaskToolCallId(liveTask({ toolCallId: 'rec-gone' }), records)).toBeNull()
  })

  it('rejects a claimed id that points at a non-sub-agent row', () => {
    const records = [call({ id: 'rec-bash', toolName: 'Bash', status: 'running' })]
    expect(resolveTaskToolCallId(liveTask({ toolCallId: 'rec-bash' }), records)).toBeNull()
  })

  it('falls back to a heuristic description match on an Agent row', () => {
    const records = [
      agentSpawn('rec-x', { description: 'Lint sweep', subagent_type: 'code-reviewer' }),
      agentSpawn('rec-y', { description: 'Deep research pass', subagent_type: 'general-purpose' }),
    ]
    expect(resolveTaskToolCallId(liveTask(), records)).toBe('rec-y')
  })

  it('narrows equal descriptions by sub-agent type', () => {
    const records = [
      agentSpawn('rec-x', { description: 'Deep research pass', subagent_type: 'code-reviewer' }),
      agentSpawn('rec-y', { description: 'Deep research pass', subagent_type: 'general-purpose' }),
    ]
    expect(resolveTaskToolCallId(liveTask({ agentType: 'general-purpose' }), records)).toBe('rec-y')
  })

  it('prefers the single still-running candidate when descriptions collide', () => {
    const records = [
      agentSpawn('rec-done', { description: 'Deep research pass' }, 'success'),
      agentSpawn('rec-live', { description: 'Deep research pass' }, 'running'),
    ]
    expect(resolveTaskToolCallId(liveTask({ agentType: undefined }), records)).toBe('rec-live')
  })

  it('returns null when candidates stay ambiguous — never the wrong chat', () => {
    const records = [
      agentSpawn('rec-1', { description: 'Deep research pass', subagent_type: 'general-purpose' }),
      agentSpawn('rec-2', { description: 'Deep research pass', subagent_type: 'general-purpose' }),
    ]
    expect(resolveTaskToolCallId(liveTask(), records)).toBeNull()
  })

  it('returns null with no candidates, or no description to match on', () => {
    expect(resolveTaskToolCallId(liveTask(), [])).toBeNull()
    expect(
      resolveTaskToolCallId(
        liveTask({ description: '   ' }),
        [agentSpawn('rec-a', { description: 'Deep research pass' })],
      ),
    ).toBeNull()
  })

  it('never joins a non-sub-agent task, even on an exact description match', () => {
    // A shell task's description can EQUAL an Agent spawn's — the sidebar
    // routes shell/monitor rows through the same open path, and the heuristic
    // must not hand them a chat that belongs to different work.
    const records = [
      agentSpawn('rec-y', { description: 'Deep research pass', subagent_type: 'general-purpose' }),
    ]
    const shellTask = liveTask({ taskType: 'shell', agentType: undefined })
    expect(resolveTaskToolCallId(shellTask, records)).toBeNull()
    // …and the gate holds even against a deterministic claim.
    expect(resolveTaskToolCallId(liveTask({ taskType: 'monitor', toolCallId: 'rec-y' }), records)).toBeNull()
  })

  it("matches legacy 'Task' spawns too — same vocabulary as the list itself", () => {
    const records = [
      call({
        id: 'rec-legacy',
        toolName: 'Task',
        status: 'running',
        inputJson: JSON.stringify({ description: 'Deep research pass' }),
      }),
    ]
    expect(resolveTaskToolCallId(liveTask({ agentType: undefined }), records)).toBe('rec-legacy')
  })
})

describe('subagentOpenTarget', () => {
  it('routes a resolved task to the child-thread chat (D-4)', () => {
    const records = [agentSpawn('rec-y', { description: 'Deep research pass' })]
    expect(subagentOpenTarget(liveTask({ agentType: undefined }), records)).toEqual({
      kind: 'thread',
      toolCallId: 'rec-y',
    })
  })

  it('routes an unresolvable task to the live-progress fallback (D-5)', () => {
    expect(subagentOpenTarget(liveTask(), [])).toEqual({ kind: 'progress' })
  })

  it("routes a 'shell' task whose description equals an Agent spawn's to progress, never the chat", () => {
    const records = [agentSpawn('rec-y', { description: 'Deep research pass' })]
    const shellTask = liveTask({ taskType: 'shell', agentType: undefined })
    expect(subagentOpenTarget(shellTask, records)).toEqual({ kind: 'progress' })
  })
})

describe('statusTone', () => {
  it('reads pending and running as running', () => {
    expect(statusTone('pending')).toBe('running')
    expect(statusTone('running')).toBe('running')
  })

  it('reads error, interrupted and denied as error', () => {
    expect(statusTone('error')).toBe('error')
    expect(statusTone('interrupted')).toBe('error')
    expect(statusTone('denied')).toBe('error')
  })

  it('reads success as done', () => {
    expect(statusTone('success')).toBe('done')
  })
})

describe('subagentSpawnChip', () => {
  const input = JSON.stringify({ description: 'Deep research pass', subagent_type: 'general-purpose' })

  it('is null while the spawn still runs — live progress keeps the full card', () => {
    expect(subagentSpawnChip('Agent', input, 'pending')).toBeNull()
    expect(subagentSpawnChip('Agent', input, 'running')).toBeNull()
  })

  it('is null for every non-sub-agent tool, whatever its status', () => {
    for (const name of ['Bash', 'Edit', 'Read', 'Write']) {
      expect(subagentSpawnChip(name, input, 'success')).toBeNull()
    }
  })

  it("collapses a finished spawn with the activity rows' own naming", () => {
    expect(subagentSpawnChip('Agent', input, 'success')).toEqual({
      label: 'Deep research pass',
      detail: 'general-purpose',
      state: 'finished',
    })
  })

  it("keeps the legacy 'Task' vocabulary", () => {
    expect(subagentSpawnChip('Task', input, 'success')).toMatchObject({ state: 'finished' })
  })

  it('reads error, denied and interrupted as failed', () => {
    for (const status of ['error', 'denied', 'interrupted'] as const) {
      expect(subagentSpawnChip('Agent', input, status)).toMatchObject({ state: 'failed' })
    }
  })

  it('falls back description → subagent_type → Sub-agent, like the rows', () => {
    const typed = JSON.stringify({ subagent_type: 'code-reviewer' })
    expect(subagentSpawnChip('Agent', typed, 'success')).toMatchObject({
      label: 'code-reviewer',
      detail: 'code-reviewer',
    })
    expect(subagentSpawnChip('Agent', null, 'success')).toMatchObject({ label: 'Sub-agent', detail: '' })
    expect(subagentSpawnChip('Agent', '{not json', 'success')).toMatchObject({ label: 'Sub-agent' })
  })
})

describe('subagentRunState — THE lifecycle merge rule (#1931 follow-up)', () => {
  const trackerTask = (overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
    id: 'task-1',
    taskType: 'local_agent',
    description: 'Research',
    toolCallId: 'tc-1',
    startedAt: '2026-10-07T10:00:00.000Z',
    ...overrides,
  })

  it('tracker-running over a SETTLED record → running, source tracker (the fixed caveat)', () => {
    // A backgrounded sub-agent's tool call settles early; the task lives on.
    expect(subagentRunState({ id: 'tc-1', status: 'success' }, [trackerTask()])).toEqual({
      running: true,
      source: 'tracker',
    })
  })

  it('no tracker entry + record running → running, source record', () => {
    expect(subagentRunState({ id: 'tc-1', status: 'running' }, [])).toEqual({
      running: true,
      source: 'record',
    })
    expect(subagentRunState({ id: 'tc-1', status: 'pending' }, [])).toEqual({
      running: true,
      source: 'record',
    })
  })

  it('no tracker entry + record settled → finished, source record (restarts)', () => {
    for (const status of ['success', 'error', 'denied', 'interrupted'] as const) {
      expect(subagentRunState({ id: 'tc-1', status }, [])).toEqual({
        running: false,
        source: 'record',
      })
    }
  })

  it('a tracker entry for a DIFFERENT tool call changes nothing — the record decides', () => {
    const other = [trackerTask({ toolCallId: 'tc-other' })]
    expect(subagentRunState({ id: 'tc-1', status: 'success' }, other)).toEqual({
      running: false,
      source: 'record',
    })
    expect(subagentRunState({ id: 'tc-1', status: 'running' }, other)).toEqual({
      running: true,
      source: 'record',
    })
  })

  it('a NON-sub-agent task can never claim a spawn (trackerTaskFor gates on task type)', () => {
    const shell = [trackerTask({ taskType: 'shell' })]
    expect(trackerTaskFor('tc-1', shell)).toBeUndefined()
    expect(subagentRunState({ id: 'tc-1', status: 'success' }, shell)).toEqual({
      running: false,
      source: 'record',
    })
  })

  it('a null record still joins the tracker via the explicit toolCallId', () => {
    expect(subagentRunState(null, [trackerTask()], 'tc-1')).toEqual({
      running: true,
      source: 'tracker',
    })
  })

  it('a null record with no tracker entry reads as not running (fold-safe default)', () => {
    expect(subagentRunState(null, [], 'tc-1')).toEqual({ running: false, source: 'record' })
    expect(subagentRunState(null, [])).toEqual({ running: false, source: 'record' })
  })
})
