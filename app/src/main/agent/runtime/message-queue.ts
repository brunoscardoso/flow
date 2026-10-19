// The SDK input queue (multi_runtime_support, Phase 2).
//
// A push/end-driven `AsyncIterable<SDKUserMessage>` handed to the Claude SDK's
// `query({ prompt })`: the coordinator pushes each user turn and the SDK pulls
// them as it is ready. Extracted here as the SHARED home so `ClaudeRuntime`
// (this phase) and `agent-manager` (its copy is adopted at wire-up, Task 2.3)
// use one implementation. Behaviour is byte-identical to agent-manager's
// original private class — the LOG-8 early-return settle and the stale-resume
// `takePending()` replay are preserved.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private ended = false

  push(message: SDKUserMessage): void {
    if (this.ended) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: message, done: false })
      return
    }
    this.buffered.push(message)
  }

  end(): void {
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  /** Remove and return every buffered-but-unconsumed message — used to replay
   *  input onto a fresh session after a stale resume forces a restart. */
  takePending(): SDKUserMessage[] {
    return this.buffered.splice(0)
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const nextBuffered = this.buffered.shift()
        if (nextBuffered !== undefined) {
          return Promise.resolve({ value: nextBuffered, done: false })
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        // LOG-8: settle a parked next() like end() does — leaving it pending
        // would strand the SDK's pull forever after an early return().
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
