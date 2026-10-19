/**
 * The work row's view model, kept DOM-free (plan_chat-cleanup, FR-1–FR-5,
 * NFR-1).
 *
 * `request-summary.ts` decides WHAT a request is — its steps, its answer, its
 * facts. This module decides what the ONE row standing for it says, in its
 * three states:
 *
 *   - closed — `Worked 6 min · 25 tools · 1 failed · 2 files edited`, the
 *     model right-aligned;
 *   - opened — the same line over numbered steps: each step's first line, its
 *     tool count, a failed count in the error tint;
 *   - live — `Working · 3 min · 19 tools`, the newest step on a second line.
 *
 * The row itself (`request-row.ts`) builds elements, and the app's jest runs
 * under a node environment, so every decision the row shows lives here where
 * a test can reach it — the same split `turn-row-model.ts` keeps.
 */
import type { ToolCallRecord } from '../../shared/ipc-contract'
import { modelLabel } from './model-label'
import { requestRowLabel, requestRowSegments, type RequestRowSegment, type RequestSummary } from './request-summary'
import { turnSummary } from './turn-summary'

/** What the row knows about one step: its head text (null for a step whose
 *  tools ran before any message) and the tools after it. */
export interface RequestRowStepInput {
  text: string | null
  records: readonly ToolCallRecord[]
}

/** One line of the opened step list. */
export interface RequestRowStepView {
  /** 1-based, the number the list shows. */
  number: number
  /** The step's first line as plain text, or `Tools` for a head-less step. */
  text: string
  tools: number
  failed: number
  /** `4 tools`, then `1 failed` flagged — empty for a step that ran nothing. */
  count: RequestRowSegment[]
}

/** Everything the work row draws. */
export interface RequestRowView {
  live: boolean
  /** The lead words in ink: `Worked 6 min`, or `Working · 3 min` while live. */
  lead: string
  /** The facts after the lead, in the muted ink; the failure one flagged. */
  facts: RequestRowSegment[]
  /** The whole line as one sentence, for the tooltip and the accessible name. */
  label: string
  /** The model's short name, or null when no message recorded one. */
  model: string | null
  /** The model id as stored, for the tooltip. */
  modelId: string | null
  steps: RequestRowStepView[]
  /** While live: the newest step's first line. Null otherwise, or when no
   *  step has spoken yet. */
  newestStep: string | null
}

/** The line a head-less step shows. */
export const HEADLESS_STEP_TEXT = 'Tools'

const SEPARATOR = ' ' + String.fromCharCode(183) + ' '
const FENCE = /^(```|~~~)/

const plural = (count: number, noun: string): string =>
  count + ' ' + noun + (count === 1 ? '' : 's')

/**
 * Markdown on one line, as plain text: headings, quote and list markers,
 * links, images, emphasis and code spans lose their syntax and keep their
 * words. Underscores inside a word (`snake_case`) are not emphasis and stay.
 */
export function plainInline(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A step's sentence on the row: the first line of its text that says
 * something, as plain text. A fenced code block is skipped whole — its first
 * line is a language tag, not a sentence. Null text (a head-less step), or
 * text with nothing to say, reads `Tools`.
 */
export function stepHeadline(text: string | null): string {
  if (text === null) return HEADLESS_STEP_TEXT
  // Scanned line by line with indexOf rather than split: a live step's text
  // grows with every stream batch, and only its first lines are ever read.
  let inFence = false
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const raw = end === -1 ? text.slice(start) : text.slice(start, end)
    start = end === -1 ? text.length + 1 : end + 1
    const trimmed = raw.trim()
    if (FENCE.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence || trimmed === '') continue
    const plain = plainInline(trimmed)
    if (plain !== '') return plain
  }
  return HEADLESS_STEP_TEXT
}

/** A step's count as segments: `4 tools` and, when any failed, `1 failed`. */
export function stepCountSegments(tools: number, failed: number): RequestRowSegment[] {
  if (tools === 0) return []
  const out: RequestRowSegment[] = [{ text: plural(tools, 'tool'), failed: false }]
  if (failed > 0) out.push({ text: failed + ' failed', failed: true })
  return out
}

/**
 * The facts of a request that is still running, from what the pane has
 * watched: the tool records so far (counts through `turnSummary`, the one
 * place tool facts are derived), the time the request started, and the model
 * the session reported.
 */
export function liveRequestSummary(
  records: readonly ToolCallRecord[],
  options: { startedAt: number | null; now: number; model: string | null },
): RequestSummary {
  const counts = turnSummary(records)
  return {
    elapsedMs: options.startedAt === null ? null : Math.max(0, options.now - options.startedAt),
    tools: counts.tools,
    failed: counts.failed,
    filesEdited: counts.filesEdited,
    model: options.model,
  }
}

/**
 * The whole row, from the request's facts and its steps.
 *
 * The line is `requestRowSegments` split once into the lead (what the agent
 * did, in ink) and the facts (in the muted ink). While live, the elapsed time
 * joins the lead — `Working · 3 min` — as the approved design draws it.
 */
export function requestRowView(
  summary: RequestSummary,
  steps: readonly RequestRowStepInput[],
  live: boolean,
): RequestRowView {
  const segments = requestRowSegments(summary, live)
  const leadCount = live && summary.elapsedMs !== null ? 2 : 1
  const lead = segments
    .slice(0, leadCount)
    .map((segment) => segment.text)
    .join(SEPARATOR)

  const stepViews = steps.map((step, index): RequestRowStepView => {
    const counts = turnSummary(step.records)
    return {
      number: index + 1,
      text: stepHeadline(step.text),
      tools: counts.tools,
      failed: counts.failed,
      count: stepCountSegments(counts.tools, counts.failed),
    }
  })

  let newestStep: string | null = null
  if (live) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index].text !== null) {
        newestStep = stepViews[index].text
        break
      }
    }
  }

  return {
    live,
    lead,
    facts: segments.slice(leadCount),
    label: requestRowLabel(summary, live),
    model: summary.model === null ? null : modelLabel(summary.model),
    modelId: summary.model,
    steps: stepViews,
    newestStep,
  }
}
