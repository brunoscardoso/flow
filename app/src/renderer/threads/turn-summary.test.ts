import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import {
  FAILED_STATUSES,
  planTurns,
  turnSummary,
  turnSummaryLabel,
  type TurnRole,
  type TurnUnit,
} from './turn-summary'

// ── Fixtures ────────────────────────────────────────────────────────────────

type Entry =
  | { kind: 'tool'; toolCall: ToolCallRecord }
  | { kind: 'assistant'; id: string }
  | { kind: 'user'; id: string }
  | { kind: 'permission'; id: string }
  | { kind: 'question'; id: string }

let seq = 0
const toolCall = (
  toolName: string,
  input: Record<string, unknown> | null,
  status: ToolCallStatus = 'success',
  messageId: string | null = null,
): ToolCallRecord => ({
  id: `tc-${(seq += 1)}`,
  threadId: 't1',
  messageId,
  toolName,
  inputJson: input === null ? null : JSON.stringify(input),
  outputJson: null,
  status,
  startedAt: '2026-09-08T00:00:00.000Z',
  completedAt: null,
})

const tool = (
  messageId: string | null,
  toolName = 'Bash',
  input: Record<string, unknown> | null = { command: 'ls' },
  status: ToolCallStatus = 'success',
): Entry => ({ kind: 'tool', toolCall: toolCall(toolName, input, status, messageId) })

const assistant = (id: string): Entry => ({ kind: 'assistant', id })
const user = (): Entry => ({ kind: 'user', id: `u-${(seq += 1)}` })
const permission = (): Entry => ({ kind: 'permission', id: `p-${(seq += 1)}` })
const question = (): Entry => ({ kind: 'question', id: `q-${(seq += 1)}` })

/**
 * The classifier the pane will inject: assistant messages open turns, tool
 * entries key by their record's messageId, everything else breaks the turn.
 */
const classify = (entry: Entry): TurnRole => {
  if (entry.kind === 'assistant') return { kind: 'assistant', messageId: entry.id }
  if (entry.kind === 'tool') return { kind: 'tool', messageId: entry.toolCall.messageId }
  return { kind: 'break' }
}

const flatten = (units: Array<TurnUnit<Entry>>): Entry[] =>
  units.flatMap((unit) => (unit.turn ? [unit.head, ...unit.tools] : [unit.entry]))

// ── planTurns ────────────────────────────────────────────────────────────────

describe('planTurns', () => {
  it('folds an assistant message plus its mixed tool calls into one turn', () => {
    const head = assistant('m1')
    const entries = [
      head,
      tool('m1', 'Read', { file_path: 'src/a.ts' }),
      tool('m1', 'Bash', { command: 'npm test' }),
      tool('m1', 'Edit', { file_path: 'src/a.ts' }),
    ]
    const units = planTurns(entries, classify)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ turn: true, messageId: 'm1', head })
    if (units[0].turn) expect(units[0].tools).toHaveLength(3)
  })

  it('lets a null-messageId call join the turn in progress by contiguity', () => {
    // Q-4: the field is nullable, and a null id that STARTED a turn would
    // fragment one turn into singletons — the noise the fold exists to remove.
    const entries = [assistant('m1'), tool('m1'), tool(null), tool(null), tool('m1')]
    const units = planTurns(entries, classify)
    expect(units).toHaveLength(1)
    if (units[0].turn) expect(units[0].tools).toHaveLength(4)
  })

  it('never opens a turn from a null-messageId call with nothing in progress', () => {
    const units = planTurns([tool(null), tool(null)], classify)
    expect(units).toEqual([
      { turn: false, entry: expect.anything() },
      { turn: false, entry: expect.anything() },
    ])
  })

  it('starts a second turn at the next assistant message', () => {
    const entries = [assistant('m1'), tool('m1'), assistant('m2'), tool('m2'), tool('m2')]
    const units = planTurns(entries, classify)
    expect(units.map((u) => (u.turn ? u.messageId : 'single'))).toEqual(['m1', 'm2'])
    expect(units.map((u) => (u.turn ? u.tools.length : -1))).toEqual([1, 2])
  })

  it('keeps two consecutive assistant messages as two turns, one of them empty', () => {
    const units = planTurns([assistant('m1'), assistant('m2'), tool('m2')], classify)
    expect(units).toHaveLength(2)
    expect(units.map((u) => (u.turn ? u.tools.length : -1))).toEqual([0, 1])
  })

  it('breaks the turn on a permission card and never swallows it', () => {
    // FR-6: an approval must stay visible at every density. A run "interrupted"
    // by a permission card renders the card as itself, outside any fold.
    const card = permission()
    const units = planTurns([assistant('m1'), tool('m1'), card, tool('m1')], classify)
    expect(units).toHaveLength(3)
    expect(units[0]).toMatchObject({ turn: true, messageId: 'm1' })
    expect(units[1]).toEqual({ turn: false, entry: card })
    expect(units[2]).toEqual({ turn: false, entry: expect.anything() })
  })

  it('breaks the turn on a user message and on a question card', () => {
    const q = question()
    const u = user()
    const units = planTurns([assistant('m1'), tool('m1'), q, u, assistant('m2')], classify)
    expect(units.map((unit) => unit.turn)).toEqual([true, false, false, true])
    expect(units[1]).toEqual({ turn: false, entry: q })
    expect(units[2]).toEqual({ turn: false, entry: u })
  })

  it('passes a tool naming a different message through as a single', () => {
    const units = planTurns([assistant('m1'), tool('m1'), tool('m9')], classify)
    expect(units.map((u) => u.turn)).toEqual([true, false])
    if (units[0].turn) expect(units[0].tools).toHaveLength(1)
  })

  it('preserves order and round-trips every entry exactly once', () => {
    const entries = [
      tool(null),
      assistant('m1'),
      tool('m1'),
      tool(null),
      permission(),
      assistant('m2'),
      tool('m2'),
      user(),
    ]
    expect(flatten(planTurns(entries, classify))).toEqual(entries)
  })

  it('returns nothing for an empty feed', () => {
    expect(planTurns([], classify)).toEqual([])
  })
})

// ── turnSummary ──────────────────────────────────────────────────────────────

describe('turnSummary', () => {
  it('counts tools, failures and distinct edited files', () => {
    const summary = turnSummary([
      toolCall('Read', { file_path: 'src/a.ts' }),
      toolCall('Edit', { file_path: 'src/a.ts' }),
      toolCall('Write', { file_path: 'src/b.ts' }),
      toolCall('Bash', { command: 'npm test' }, 'error'),
    ])
    expect(summary).toEqual({ tools: 4, failed: 1, filesEdited: 2, status: 'error' })
  })

  it('counts a file edited three times as ONE file edited', () => {
    const summary = turnSummary([
      toolCall('Edit', { file_path: 'src/a.ts' }),
      toolCall('Edit', { file_path: 'src/a.ts' }),
      toolCall('NotebookEdit', { file_path: 'src/a.ts' }),
    ])
    expect(summary.filesEdited).toBe(1)
    expect(summary.tools).toBe(3)
  })

  it('does not count a READ file as edited, nor an edit with no file_path', () => {
    const summary = turnSummary([
      toolCall('Read', { file_path: 'src/only-read.ts' }),
      toolCall('Grep', { pattern: 'x' }),
      toolCall('Edit', null),
    ])
    expect(summary.filesEdited).toBe(0)
  })

  it('counts error and denied as failures', () => {
    const summary = turnSummary([
      toolCall('Bash', { command: 'a' }, 'error'),
      toolCall('Bash', { command: 'b' }, 'denied'),
      toolCall('Bash', { command: 'c' }),
    ])
    expect(summary.failed).toBe(2)
    expect(FAILED_STATUSES.has('error')).toBe(true)
    expect(FAILED_STATUSES.has('denied')).toBe(true)
  })

  it('never counts interrupted as a failure', () => {
    // #1217: `interrupted` is "stopped by you", not "this crashed".
    const summary = turnSummary([
      toolCall('Bash', { command: 'a' }, 'interrupted'),
      toolCall('Bash', { command: 'b' }, 'interrupted'),
    ])
    expect(summary.failed).toBe(0)
    expect(FAILED_STATUSES.has('interrupted')).toBe(false)
    expect(summary.status).toBe('interrupted')
  })

  it('reuses groupStatus precedence rather than re-deriving it', () => {
    expect(turnSummary([toolCall('Bash', null, 'error'), toolCall('Bash', null, 'running')]).status)
      .toBe('running')
    expect(turnSummary([toolCall('Bash', null, 'interrupted'), toolCall('Bash', null, 'error')]).status)
      .toBe('error')
    expect(turnSummary([toolCall('Bash', null), toolCall('Bash', null)]).status).toBe('success')
  })

  it('summarizes an empty turn as all zeroes', () => {
    expect(turnSummary([])).toEqual({ tools: 0, failed: 0, filesEdited: 0, status: 'success' })
  })
})

// ── turnSummaryLabel ─────────────────────────────────────────────────────────

describe('turnSummaryLabel', () => {
  const DOT = String.fromCharCode(183)

  it('states every non-zero fact, middle-dot separated', () => {
    expect(turnSummaryLabel({ tools: 12, failed: 2, filesEdited: 3, status: 'error' })).toBe(
      `Ran 12 tools ${DOT} 2 failed ${DOT} 3 files edited`,
    )
  })

  it('omits the failed segment when nothing failed', () => {
    // A clean turn must never read `· 0 failed` — a fact nobody asked for,
    // taking the space the counts that matter need.
    expect(turnSummaryLabel({ tools: 5, failed: 0, filesEdited: 1, status: 'success' })).toBe(
      `Ran 5 tools ${DOT} 1 file edited`,
    )
  })

  it('omits the files segment when nothing was edited', () => {
    expect(turnSummaryLabel({ tools: 5, failed: 1, filesEdited: 0, status: 'error' })).toBe(
      `Ran 5 tools ${DOT} 1 failed`,
    )
  })

  it('omits both when a turn only read', () => {
    expect(turnSummaryLabel({ tools: 3, failed: 0, filesEdited: 0, status: 'success' })).toBe(
      'Ran 3 tools',
    )
  })

  it('is empty for a turn with no tool calls, so the caller renders no row', () => {
    expect(turnSummaryLabel({ tools: 0, failed: 0, filesEdited: 0, status: 'success' })).toBe('')
  })

  it('handles singular and plural', () => {
    expect(turnSummaryLabel({ tools: 1, failed: 0, filesEdited: 1, status: 'success' })).toBe(
      `Ran 1 tool ${DOT} 1 file edited`,
    )
    expect(turnSummaryLabel({ tools: 2, failed: 1, filesEdited: 2, status: 'error' })).toBe(
      `Ran 2 tools ${DOT} 1 failed ${DOT} 2 files edited`,
    )
  })

  it('reads end-to-end from a planned turn', () => {
    const entries = [
      assistant('m1'),
      tool('m1', 'Edit', { file_path: 'src/a.ts' }),
      tool(null, 'Edit', { file_path: 'src/a.ts' }),
      tool('m1', 'Write', { file_path: 'src/b.ts' }),
      tool('m1', 'Bash', { command: 'npm test' }, 'error'),
    ]
    const units = planTurns(entries, classify)
    const unit = units[0]
    if (!unit.turn) throw new Error('expected a turn')
    const records = unit.tools.map((entry) => {
      if (entry.kind !== 'tool') throw new Error('expected a tool entry')
      return entry.toolCall
    })
    expect(turnSummaryLabel(turnSummary(records))).toBe(
      `Ran 4 tools ${DOT} 1 failed ${DOT} 2 files edited`,
    )
  })
})
