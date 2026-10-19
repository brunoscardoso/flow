// What a notification's action button dispatches — pure, so the one rule (an
// action's `detail` rides on its event) is testable without a DOM.

import type { FlowNotification } from '../../shared/ipc-contract'

type NotificationAction = NonNullable<FlowNotification['action']>

export interface ActionEventSpec {
  type: string
  detail?: Record<string, string>
}

/** The events one press dispatches, in order. */
export function notificationActionEvents(action: NotificationAction): ActionEventSpec[] {
  const events: ActionEventSpec[] = [
    action.detail === undefined ? { type: action.event } : { type: action.event, detail: { ...action.detail } },
  ]
  if (action.openLearning === true) events.push({ type: 'flow:open-learning-panel' })
  return events
}
