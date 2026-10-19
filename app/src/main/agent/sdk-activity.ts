/**
 * What an SDK message says the session is DOING — the liveness signal a
 * headless pass has and had been throwing away.
 *
 * A caged learn pass drives the SDK through `ClaudeRuntime`, whose translator
 * is handed an `emit` for normalized events. The caged translator wanted one
 * thing — the final structured text — and ignored `emit` entirely, so
 * `onEvent` could never fire and every `onActivity` consumer downstream was
 * wired to a callback nothing called. The watchdog that used those events to
 * decide a pass had died therefore heard only file reads: real runs spent
 * three minutes composing an answer and were killed one step from finishing.
 *
 * This reads the raw SDK message instead of the normalized event, because the
 * caged path has no translator to normalize with and inventing one to carry a
 * heartbeat would be a second mapping to keep honest.
 *
 * `stream` IS THE IMPORTANT ONE and the one worth the least on screen. Partial
 * messages arrive per chunk while the model writes — the only proof of life
 * that exists during the composing phase, which is exactly the phase that was
 * being mistaken for death. It is a heartbeat, not news: feed the watchdog
 * with it, do not print it.
 */

export type SdkActivity = { kind: string; detail?: string }

type Block = { type?: unknown; name?: unknown }

function blocksOf(message: Record<string, unknown>): Block[] {
  const inner = message['message']
  if (typeof inner !== 'object' || inner === null) return []
  const content = (inner as Record<string, unknown>)['content']
  return Array.isArray(content) ? (content as Block[]) : []
}

export function describeSdkActivity(message: unknown): SdkActivity | null {
  if (typeof message !== 'object' || message === null) return null
  const record = message as Record<string, unknown>
  const type = record['type']

  if (type === 'stream_event') return { kind: 'stream' }

  if (type === 'assistant') {
    const blocks = blocksOf(record)
    // ONE MESSAGE, ONE HEADLINE. A turn can carry a thought, some prose and
    // three tool calls at once; reporting all of them would make the log a
    // transcript. Thinking outranks writing outranks calling, because that is
    // the order in which they explain a long gap.
    if (blocks.some((block) => block.type === 'thinking')) return { kind: 'thinking' }
    if (blocks.some((block) => block.type === 'text')) return { kind: 'writing' }
    const call = blocks.find((block) => block.type === 'tool_use')
    if (call !== undefined) {
      return typeof call.name === 'string' ? { kind: 'tool', detail: call.name } : { kind: 'tool' }
    }
    return { kind: 'assistant' }
  }

  if (type === 'user') {
    const blocks = blocksOf(record)
    if (blocks.some((block) => block.type === 'tool_result')) return { kind: 'tool result' }
    return { kind: 'user' }
  }

  if (type === 'system') {
    const subtype = record['subtype']
    return typeof subtype === 'string' ? { kind: 'session', detail: subtype } : { kind: 'session' }
  }

  if (type === 'result') {
    const subtype = record['subtype']
    return typeof subtype === 'string' ? { kind: 'result', detail: subtype } : { kind: 'result' }
  }

  return null
}
