import type { BackgroundTaskInfo } from '../../shared/ipc-contract'
import { foldProgress, initialProgress, markDone } from './subagent-progress-model'

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: 't1',
    taskType: 'local_agent',
    description: 'Research',
    agentType: 'Explore',
    lastTool: 'Grep',
    elapsedMs: 1000,
    startedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  }
}

describe('subagent-progress-model (#1931)', () => {
  it('seeds from the first snapshot', () => {
    expect(initialProgress(task(), 'Research')).toMatchObject({
      taskId: 't1',
      title: 'Research',
      agentType: 'Explore',
      status: 'running',
      log: ['Grep'],
    })
  })

  it('accumulates distinct lastTool values into the log', () => {
    let p = initialProgress(task({ lastTool: 'Grep' }), 'R')
    p = foldProgress(p, task({ lastTool: 'Read' }))
    p = foldProgress(p, task({ lastTool: 'Read' })) // no change
    p = foldProgress(p, task({ lastTool: 'Edit' }))
    expect(p.log).toEqual(['Grep', 'Read', 'Edit'])
  })

  it('tracks elapsed and keeps running until marked done', () => {
    let p = initialProgress(task({ elapsedMs: 1000 }), 'R')
    p = foldProgress(p, task({ elapsedMs: 5000 }))
    expect(p.elapsedMs).toBe(5000)
    expect(p.status).toBe('running')
    expect(markDone(p).status).toBe('done')
  })

  it('handles a snapshot with no lastTool', () => {
    const p = initialProgress(task({ lastTool: undefined }), 'R')
    expect(p.log).toEqual([])
  })
})
