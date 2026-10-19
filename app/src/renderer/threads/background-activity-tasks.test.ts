import type { BackgroundTaskInfo, ToolCallRecord } from '../../shared/ipc-contract'
import { activityRows, mergeActivityRows, taskActivityRows } from './background-activity-model'

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: 't1',
    // 'local_agent' is what SDK 0.3.204's background_tasks_changed events carry.
    taskType: 'local_agent',
    description: 'Research',
    agentType: 'Explore',
    lastTool: 'Grep',
    startedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  }
}

function taskToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tc1',
    threadId: 'th',
    messageId: null,
    toolName: 'Agent',
    inputJson: JSON.stringify({ description: 'Research' }),
    outputJson: null,
    status: 'running',
    startedAt: '2026-10-06T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

describe('taskActivityRows (#1931)', () => {
  it('keeps only sub-agents and marks them running, carrying the task', () => {
    const rows = taskActivityRows(
      [task({ id: 't1', description: 'Research' }), task({ id: 't2', taskType: 'shell' })],
      'th',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 't1',
      source: 'task',
      kind: 'subagent',
      label: 'Research',
      running: true,
      status: 'running',
    })
    expect(rows[0].task?.id).toBe('t1')
  })

  it("keeps a legacy 'subagent' task type (back-compat)", () => {
    const rows = taskActivityRows([task({ id: 't9', taskType: 'subagent' })], 'th')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 't9', kind: 'subagent', running: true })
  })

  it('falls back to agent type then a default label', () => {
    expect(taskActivityRows([task({ description: '', agentType: 'Plan' })], 'th')[0].label).toBe('Plan')
    expect(taskActivityRows([task({ description: '', agentType: undefined })], 'th')[0].label).toBe(
      'Sub-agent',
    )
  })
})

describe('mergeActivityRows (#1931)', () => {
  it('appends live tasks, dropping any that match a persisted row by label', () => {
    const persisted = activityRows([taskToolCall({ id: 'tc1' })]) // label "Research"
    const live = taskActivityRows(
      [task({ id: 't1', description: 'Research' }), task({ id: 't2', description: 'Other' })],
      'th',
    )
    const merged = mergeActivityRows(persisted, live)
    expect(merged.map((row) => row.label)).toEqual(['Research', 'Other'])
    // The surviving "Research" is the persisted one (opens the sub-chat).
    expect(merged.find((row) => row.label === 'Research')?.source).toBe('toolcall')
    expect(merged.find((row) => row.label === 'Other')?.source).toBe('task')
  })

  it('a live task claiming a persisted spawn folds in by id — one row, RUNNING over an early-settled record', () => {
    // The backgrounded caveat: the tool call settled 'success' while the task
    // still runs. The tracker is the authority (subagentRunState), so the one
    // surviving row — the persisted one, which opens the sub-chat — reads as
    // running, and no second row appears.
    const persisted = activityRows([taskToolCall({ id: 'tc1', status: 'success' })])
    const live = taskActivityRows([task({ id: 't1', toolCallId: 'tc1' })], 'th')
    const merged = mergeActivityRows(persisted, live)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'tc1',
      source: 'toolcall',
      running: true,
      status: 'running',
    })
  })

  it('a live task claiming a DIFFERENT id neither folds nor revives a settled row', () => {
    const persisted = activityRows([taskToolCall({ id: 'tc1', status: 'success' })])
    const live = taskActivityRows(
      [task({ id: 't1', toolCallId: 'tc-other', description: 'Elsewhere' })],
      'th',
    )
    const merged = mergeActivityRows(persisted, live)
    expect(merged.map((row) => row.id)).toEqual(['tc1', 't1'])
    expect(merged[0]).toMatchObject({ running: false, status: 'success' })
  })

  it('a RETAINED finished task claiming a persisted row folds away without reviving it', () => {
    // The store keeps a task after it drops off the live set (running: false).
    // It still joins by id — one spawn, one row — but a dead task is no
    // authority: the persisted status stands.
    const persisted = activityRows([taskToolCall({ id: 'tc1', status: 'success' })])
    const retained = taskActivityRows([task({ id: 't1', toolCallId: 'tc1' })], 'th').map((row) => ({
      ...row,
      running: false,
      status: 'success' as const,
    }))
    const merged = mergeActivityRows(persisted, retained)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: 'tc1', running: false, status: 'success' })
  })
})
