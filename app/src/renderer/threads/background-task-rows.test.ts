// background-task-rows — the sidebar's view of work a thread is still owed
// after its turn ended.

import type { BackgroundTaskInfo } from '../../shared/ipc-contract'
import {
  backgroundActivityLabel,
  formatElapsed,
  taskElapsedMs,
  taskLabel,
  taskTooltip,
  threadIsLive,
} from './background-task-rows'

const NOW = new Date('2026-09-08T10:00:00.000Z')

function task(over: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: 't1',
    taskType: 'local_agent',
    description: 'security review pass',
    startedAt: NOW.toISOString(),
    ...over,
  }
}

describe('threadIsLive', () => {
  it('is live while the turn is working, as it always was', () => {
    expect(threadIsLive('working', 0)).toBe(true)
  })

  it('is live when the turn has ENDED but agents are still running', () => {
    // The whole report: a thread that backgrounded four review passes finishes
    // its turn cleanly and goes `done`, which every surface reads as resting.
    expect(threadIsLive('done', 4)).toBe(true)
    expect(threadIsLive('idle', 1)).toBe(true)
  })

  it('is quiet when the turn rests and nothing is running', () => {
    expect(threadIsLive('done', 0)).toBe(false)
    expect(threadIsLive('idle', 0)).toBe(false)
  })

  it('does not make a thread waiting on a person look busy', () => {
    // needs-decision is its own, louder state — a thread that cannot move until
    // you answer must not be dressed as one that is working.
    expect(threadIsLive('needs-decision', 0)).toBe(false)
  })
})

describe('taskElapsedMs', () => {
  it('counts from the start until the runtime has reported a duration', () => {
    const at = new Date(NOW.getTime() + 9_000)
    expect(taskElapsedMs(task(), at)).toBe(9_000)
  })

  it('prefers the runtime’s reported duration once it arrives', () => {
    // It is measured where the task runs; our start time is when we heard of it.
    expect(taskElapsedMs(task({ elapsedMs: 21_000 }), NOW, NOW)).toBe(21_000)
  })

  it('keeps ticking between progress reports', () => {
    // A timer that only moved when a report landed would sit frozen at 4s for a
    // minute and read as a hung agent.
    const at = new Date(NOW.getTime() + 5_000)
    expect(taskElapsedMs(task({ elapsedMs: 21_000 }), at, NOW)).toBe(26_000)
  })

  it('never goes backwards when the clocks disagree', () => {
    const earlier = new Date(NOW.getTime() - 10_000)
    expect(taskElapsedMs(task({ startedAt: NOW.toISOString() }), earlier)).toBe(0)
  })
})

describe('formatElapsed', () => {
  it('shows seconds for the first minute — the part a person watches', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(21_000)).toBe('21s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('shows minutes past a minute', () => {
    expect(formatElapsed(60_000)).toBe('1m')
    expect(formatElapsed(9 * 60_000)).toBe('9m')
  })

  it('shows hours and minutes past an hour, never seconds', () => {
    expect(formatElapsed(3_600_000)).toBe('1h')
    expect(formatElapsed(3_600_000 + 12 * 60_000)).toBe('1h 12m')
  })

  it('never renders a negative duration', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})

describe('taskLabel', () => {
  it('names a task by its DESCRIPTION, which is what distinguishes siblings', () => {
    // The first cut preferred agentType, so eight parallel `general-purpose`
    // agents rendered as eight identical rows — a list that reads as duplicated
    // and answers nothing.
    expect(taskLabel(task({ agentType: 'general-purpose' }))).toBe('security review pass')
  })

  it('gives two same-type tasks two different labels', () => {
    const a = task({ id: 'a', agentType: 'general-purpose', description: 'Review: logic and bugs' })
    const b = task({ id: 'b', agentType: 'general-purpose', description: 'Review: performance' })
    expect(taskLabel(a)).not.toBe(taskLabel(b))
  })

  it('falls back to the agent type when the runtime described nothing', () => {
    expect(taskLabel(task({ description: '  ', agentType: 'security-reviewer' }))).toBe(
      'security-reviewer',
    )
  })

  it('falls back to the task type rather than rendering an empty row', () => {
    expect(taskLabel(task({ description: '   ' }))).toBe('local_agent')
  })
})

describe('taskTooltip', () => {
  it('carries what the label could not fit', () => {
    const text = taskTooltip(task({ agentType: 'security-reviewer', lastTool: 'Grep' }))
    expect(text).toContain('security review pass')
    expect(text).toContain('Agent: security-reviewer')
    expect(text).toContain('Last tool: Grep')
  })

  it('leaves out what the task never reported, with no dangling separators', () => {
    expect(taskTooltip(task())).toBe('security review pass\nType: local_agent')
  })
})

describe('backgroundActivityLabel', () => {
  it('names the work when there is one piece of it', () => {
    // Same rule as the row: the description is the name that distinguishes.
    expect(backgroundActivityLabel([task({ agentType: 'general-purpose' })])).toBe(
      'Running in the background: security review pass',
    )
  })

  it('counts when there are several — four names do not fit a line', () => {
    expect(backgroundActivityLabel([task(), task({ id: 't2' }), task({ id: 't3' })])).toBe(
      '3 agents running in the background',
    )
  })

  it('says nothing when nothing is running', () => {
    expect(backgroundActivityLabel([])).toBe('')
  })

  it('never claims the agent is working — the turn is over and you can type', () => {
    // The composer is free in this state. "Working…" would describe a pane that
    // is waiting on the model, which is precisely what it is not.
    for (const tasks of [[task()], [task(), task({ id: 't2' })]]) {
      expect(backgroundActivityLabel(tasks)).not.toContain('Working')
      expect(backgroundActivityLabel(tasks)).not.toContain('Thinking')
    }
  })
})
