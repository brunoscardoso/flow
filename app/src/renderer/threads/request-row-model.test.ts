/**
 * The work row's view model (plan_chat-cleanup, FR-1–FR-5): what the closed,
 * opened and live row say. The view (`request-row.ts`) is not imported — the
 * app suite runs under a node environment with no DOM.
 */
import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import type { RequestSummary } from './request-summary'
import {
  HEADLESS_STEP_TEXT,
  liveRequestSummary,
  plainInline,
  requestRowView,
  stepCountSegments,
  stepHeadline,
} from './request-row-model'

const record = (id: string, status: ToolCallStatus = 'success', file?: string): ToolCallRecord => ({
  id,
  threadId: 'th',
  messageId: null,
  toolName: file === undefined ? 'Bash' : 'Edit',
  inputJson: file === undefined ? '{"command":"ls"}' : JSON.stringify({ file_path: file }),
  outputJson: null,
  status,
  startedAt: '2026-10-08T10:00:00.000Z',
  completedAt: '2026-10-08T10:00:01.000Z',
})

const summary = (over: Partial<RequestSummary> = {}): RequestSummary => ({
  elapsedMs: 6 * 60_000,
  tools: 25,
  failed: 1,
  filesEdited: 2,
  model: 'claude-opus-4-8',
  ...over,
})

describe('stepHeadline', () => {
  it('takes the first line, trimmed', () => {
    expect(stepHeadline('  Let me read the backend files.  \nThen the frontend.')).toBe(
      'Let me read the backend files.',
    )
  })

  it('skips blank lines before the first sentence', () => {
    expect(stepHeadline('\n\n   \nRead the DAO.')).toBe('Read the DAO.')
  })

  it('strips emphasis, code spans and links to their words', () => {
    expect(stepHeadline('**Backend** is clear. Now read `views.py` and [the docs](https://x.y).')).toBe(
      'Backend is clear. Now read views.py and the docs.',
    )
    expect(stepHeadline('An *important* _note_ here')).toBe('An important note here')
  })

  it('keeps underscores inside a word', () => {
    expect(stepHeadline('Check list_for_user and sort_by')).toBe('Check list_for_user and sort_by')
  })

  it('drops heading, quote and list markers', () => {
    expect(stepHeadline('## Plan created')).toBe('Plan created')
    expect(stepHeadline('> quoted')).toBe('quoted')
    expect(stepHeadline('- first item')).toBe('first item')
    expect(stepHeadline('1. first item')).toBe('first item')
  })

  it('skips a fenced code block whole', () => {
    expect(stepHeadline('```ts\nconst a = 1\n```\nRan the check.')).toBe('Ran the check.')
  })

  it('reads Tools for a head-less step or text with nothing to say', () => {
    expect(stepHeadline(null)).toBe(HEADLESS_STEP_TEXT)
    expect(stepHeadline('   \n  ')).toBe(HEADLESS_STEP_TEXT)
    expect(stepHeadline('```\nonly code\n```')).toBe(HEADLESS_STEP_TEXT)
  })
})

describe('plainInline', () => {
  it('collapses inner whitespace', () => {
    expect(plainInline('a   b\tc')).toBe('a b c')
  })
})

describe('stepCountSegments', () => {
  it('is empty for a step that ran nothing', () => {
    expect(stepCountSegments(0, 0)).toEqual([])
  })

  it('flags only the failed count', () => {
    expect(stepCountSegments(4, 1)).toEqual([
      { text: '4 tools', failed: false },
      { text: '1 failed', failed: true },
    ])
    expect(stepCountSegments(1, 0)).toEqual([{ text: '1 tool', failed: false }])
  })
})

describe('requestRowView — closed', () => {
  it('splits the line into the lead and the facts, with the model once', () => {
    const view = requestRowView(summary(), [], false)
    expect(view.lead).toBe('Worked 6 min')
    expect(view.facts).toEqual([
      { text: '25 tools', failed: false },
      { text: '1 failed', failed: true },
      { text: '2 files edited', failed: false },
    ])
    expect(view.label).toBe('Worked 6 min · 25 tools · 1 failed · 2 files edited')
    expect(view.model).toBe('Opus 4.8')
    expect(view.modelId).toBe('claude-opus-4-8')
    expect(view.newestStep).toBeNull()
  })

  it('shows no model when no message recorded one (never "Auto")', () => {
    expect(requestRowView(summary({ model: null }), [], false).model).toBeNull()
  })

  it('numbers the steps and counts each one through the tool facts', () => {
    const view = requestRowView(
      summary(),
      [
        { text: 'Read the discovery.\nMore.', records: [record('a'), record('b')] },
        { text: null, records: [record('c')] },
        { text: 'Wrote the plan.', records: [record('d'), record('e', 'error'), record('f', 'denied')] },
        { text: 'Only talked.', records: [] },
      ],
      false,
    )
    expect(view.steps.map((step) => [step.number, step.text, step.tools, step.failed])).toEqual([
      [1, 'Read the discovery.', 2, 0],
      [2, 'Tools', 1, 0],
      [3, 'Wrote the plan.', 3, 2],
      [4, 'Only talked.', 0, 0],
    ])
    expect(view.steps[2].count).toEqual([
      { text: '3 tools', failed: false },
      { text: '2 failed', failed: true },
    ])
    expect(view.steps[3].count).toEqual([])
  })

  it('an interrupted tool is not a failure', () => {
    const view = requestRowView(summary(), [{ text: 'x', records: [record('a', 'interrupted')] }], false)
    expect(view.steps[0].failed).toBe(0)
  })
})

describe('requestRowView — live', () => {
  it('puts the elapsed time in the lead and shows the newest step', () => {
    const view = requestRowView(
      summary({ elapsedMs: 3 * 60_000, tools: 19, failed: 0, filesEdited: 0 }),
      [
        { text: 'Reading the backend.', records: [record('a')] },
        { text: '**Reading** the frontend hooks…\nand more', records: [] },
        { text: null, records: [record('b')] },
      ],
      true,
    )
    expect(view.live).toBe(true)
    expect(view.lead).toBe('Working · 3 min')
    expect(view.facts).toEqual([{ text: '19 tools', failed: false }])
    expect(view.newestStep).toBe('Reading the frontend hooks…')
  })

  it('has no newest step before any step has spoken', () => {
    const view = requestRowView(summary({ elapsedMs: null }), [{ text: null, records: [record('a')] }], true)
    expect(view.lead).toBe('Working')
    expect(view.newestStep).toBeNull()
  })
})

describe('liveRequestSummary', () => {
  it('counts the watched records and times from the start', () => {
    const facts = liveRequestSummary(
      [record('a'), record('b', 'error'), record('c', 'success', '/x.ts'), record('d', 'success', '/x.ts')],
      { startedAt: 1_000, now: 181_000, model: 'claude-opus-4-8' },
    )
    expect(facts).toEqual({
      elapsedMs: 180_000,
      tools: 4,
      failed: 1,
      filesEdited: 1,
      model: 'claude-opus-4-8',
    })
  })

  it('has no elapsed time without a start, and never a negative one', () => {
    expect(liveRequestSummary([], { startedAt: null, now: 5, model: null }).elapsedMs).toBeNull()
    expect(liveRequestSummary([], { startedAt: 10, now: 5, model: null }).elapsedMs).toBe(0)
  })
})
