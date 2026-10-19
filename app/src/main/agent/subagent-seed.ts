/**
 * Seed a continuation CHILD thread's first turn with its sub-agent's context
 * (#1931).
 *
 * A promoted sub-agent child (schema v37: `parentThreadId` + `originToolCallId`)
 * starts a FRESH SDK session — the model has none of the sub-agent's work in
 * context, even though that work is re-homed into the child as its visible
 * history. This preamble (first turn only, via AgentManager's `seedProvider`,
 * never stored as the user's message) hands the fresh agent what it needs to
 * continue coherently: the task the sub-agent was given, and where it left off.
 * Returns null for an ordinary thread, so it composes cleanly behind the task
 * seed.
 */
import type { ThreadStore } from '../store/thread-store'

/** Cap the original-task brief so a giant sub-agent prompt can't blow the seed. */
const BRIEF_LIMIT = 1500
/** Cap the "where it left off" tail — the end of the last assistant message. */
const TAIL_LIMIT = 2000

export function makeSubagentSeedProvider(
  threadStore: ThreadStore,
): (threadId: string) => string | null {
  return (threadId) => {
    const thread = threadStore.getThread(threadId)
    if (!thread?.parentThreadId || !thread.originToolCallId) return null

    // The sub-agent's SPAWN (its task) is the Task tool-call on the PARENT; its
    // inner execution was re-homed into this child as the child's own history.
    const spawn = threadStore.getToolCall(thread.parentThreadId, thread.originToolCallId)
    const task = subagentTaskBrief(spawn?.inputJson ?? null)

    // The child's final assistant message is where the sub-agent left off.
    const messages = threadStore.listMessages(threadId)
    let tail = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message !== undefined && message.role === 'assistant') {
        tail = message.content.trim()
        break
      }
    }

    const parts = [
      'You are continuing a sub-agent execution that ran as part of a larger ' +
        'task. Its full transcript is already in this conversation above. Pick ' +
        'up from where it left off and respond to the user.',
    ]
    if (task.length > 0) parts.push(`The sub-agent's original task:\n${task}`)
    if (tail.length > 0) parts.push(`Where it left off:\n${tail.slice(-TAIL_LIMIT)}`)
    return parts.join('\n\n')
  }
}

/**
 * The sub-agent's task from the parent Task tool-call input — its description
 * and prompt, capped. Returns '' when the input is missing or malformed.
 */
function subagentTaskBrief(inputJson: string | null): string {
  if (inputJson === null) return ''
  try {
    const parsed = JSON.parse(inputJson) as {
      description?: unknown
      prompt?: unknown
    }
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
    const combined = [description, prompt].filter((part) => part.length > 0).join('\n\n')
    return combined.slice(0, BRIEF_LIMIT)
  } catch {
    return ''
  }
}
