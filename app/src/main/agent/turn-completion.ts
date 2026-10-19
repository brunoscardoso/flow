// Turn-completion decision (#464). The SDK emits a `result` message when an agent
// turn ends — but a Task SUB-AGENT's turn also ends with its own `result`, and that
// arrives while the PARENT turn is still running (its `Task` tool call is open,
// awaiting the sub-agent's output). Treating that nested result as the parent's end
// flips the thread to `done` while the agent is still working — the "stuck in
// completed but is in progress" bug. The parent turn is only truly over once every
// parent tool call (including the Task) has been finalized. Pure → unit-testable.

/**
 * Whether an SDK `result` is the TRUE end of the thread's turn: true only when no
 * parent-turn tool calls remain open. A result arriving with open tool calls is a
 * nested (sub-agent) turn finishing and must NOT mark the thread done.
 */
export function isTurnResultTerminal(openParentToolCalls: number): boolean {
  return openParentToolCalls === 0
}
