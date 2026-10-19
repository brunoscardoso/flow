import { notificationActionEvents } from './notification-action'

describe('notificationActionEvents', () => {
  it('carries the action’s detail on its event, so the button can name what it opens', () => {
    expect(notificationActionEvents({ label: 'Review the changes', event: 'flow:open-workspace-sync', detail: { slug: 'acme' } })).toEqual([
      { type: 'flow:open-workspace-sync', detail: { slug: 'acme' } },
    ])
  })

  it('an action with no detail dispatches a plain event; openLearning adds the learning panel', () => {
    expect(notificationActionEvents({ label: 'Open', event: 'flow:x', openLearning: true })).toEqual([
      { type: 'flow:x' },
      { type: 'flow:open-learning-panel' },
    ])
  })
})
