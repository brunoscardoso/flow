// task-lane-sync — the Kanban card follows its agent's status.
//
// A card owns one thread (1:1). When that thread stops to ask the user something
// — a permission gate or an AskUserQuestion — its status goes `needs-decision`,
// and the board should SHOW that the ticket is waiting: it moves to the Blocked
// lane. When the user answers, the thread leaves `needs-decision` and the card
// slides back to the lane it came from.
//
// The whole reaction is one function, store-injected and DOM/IPC-free, wired to
// AgentManager's decoupled `onThreadStatus` callback in index.ts (the manager
// never knows tasks exist — same shape as onTurnStart/onTurnComplete). The
// `updateTask` write it makes already broadcasts `tasks:updated`, so the board
// repaints through its existing subscription; nothing here touches the renderer.

import type { ThreadStatus } from '../../shared/ipc-contract'
import type { TaskRecord } from '../store/task-store'

/** The slice of TaskStore the reaction needs — kept minimal so it unit-tests
 *  without a database or Electron. */
export interface TaskLaneSyncDeps {
  getTaskByThreadId(threadId: string): TaskRecord | null
  updateTask(
    id: string,
    patch: { lane?: TaskRecord['lane']; agentBlockedFrom?: TaskRecord['lane'] | null },
    options?: { activity?: boolean },
  ): TaskRecord
}

/**
 * Move the owning card into / out of Blocked as its thread starts and stops
 * waiting on the user. Idempotent and safe to call on every status transition.
 *
 * The rules, and why each guard is here:
 *  - → `needs-decision`: the agent is now waiting. Move the card to Blocked and
 *    remember where it came from — UNLESS it is already in Blocked, or already
 *    marked as agent-parked. A card a HUMAN dragged to Blocked has
 *    `agentBlockedFrom === null` and `lane === 'blocked'`, so it is left exactly
 *    as the person left it (discovery FR5).
 *  - leaving `needs-decision`: the ask was answered. Restore ONLY a card the
 *    agent itself parked (`agentBlockedFrom !== null`) — never a human's — and
 *    clear the marker. A card with no marker is not ours to move.
 *
 * A thread with no owning task is a bare conversation: nothing to do.
 *
 * Not activity: moving the card is the app reacting to the agent, not the user
 * touching the board, so it must not bump updated_at and yank the card to the
 * top of its lane (the same carve-out turn-start/suggestDone already make).
 */
export function onThreadStatus(
  threadId: string,
  status: ThreadStatus,
  deps: TaskLaneSyncDeps,
): void {
  const task = deps.getTaskByThreadId(threadId)
  if (!task) return

  if (status === 'needs-decision') {
    // Already parked (by us or a person) — nothing to move, and re-recording the
    // "from" lane would overwrite the real origin with 'blocked'.
    if (task.lane === 'blocked' || task.agentBlockedFrom !== null) return
    deps.updateTask(
      task.id,
      { lane: 'blocked', agentBlockedFrom: task.lane },
      { activity: false },
    )
    return
  }

  // Any non-waiting status (working / idle / done / failed): the ask is over.
  // Restore only a card the agent parked; a human-parked card (null marker) is
  // theirs to move.
  if (task.agentBlockedFrom !== null) {
    deps.updateTask(
      task.id,
      { lane: task.agentBlockedFrom, agentBlockedFrom: null },
      { activity: false },
    )
  }
}
