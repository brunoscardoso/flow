/**
 * Tool-call card — Stark: 1px border, no shadow, collapsed to a single
 * 28px line (icon + tool name + one-line input summary + status glyph).
 * Clicking the line expands pretty-printed input/output JSON in mono.
 *
 * Created on `tool-start` stream events and updated in place on `tool-end`
 * (same ToolCallRecord id), and also used when rendering persisted history.
 */
import '../components'
import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import { brainSearchPresentation, toolIcon } from './tool-card-model'
import { subagentSpawnChip, type SubagentSpawnChip } from './background-activity-model'
import { basename, changeSummary, classifyTool, computeLineDiff, filePathOf } from './tool-card-presentation'

const SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
] as const

export class ToolCard {
  readonly element: HTMLElement
  #record: ToolCallRecord
  #line: HTMLDivElement
  #icon: HTMLElement
  #name: HTMLSpanElement
  #summary: HTMLSpanElement
  #statusGlyph: HTMLElement
  #detail: HTMLDivElement
  #inputLabel: HTMLDivElement
  #inputPre: HTMLPreElement
  /** Red/green code quote for an edit/write; hidden for every other tool. */
  #inputDiff: HTMLDivElement
  #outputSection: HTMLDivElement
  #outputPre: HTMLPreElement
  #expanded = false
  /** A withheld output is being fetched — one flight per card. */
  #loadingOutput = false
  /**
   * Non-null once this card is a FINISHED sub-agent spawn (#1931 follow-up):
   * the card is then a compact one-line chip whose click opens the promoted
   * child-thread chat (the SAME `flow:open-subagent-thread` path the activity
   * popover dispatches — one code path, allowed-pattern #14) instead of
   * expanding JSON. While the spawn RUNS this stays null and the card keeps
   * its full presentation — live progress matters.
   */
  #subagentChip: SubagentSpawnChip | null = null

  constructor(record: ToolCallRecord) {
    injectToolCardStyles()
    this.#record = record

    this.element = document.createElement('div')
    this.element.className = 'fl-tool-card'

    // ── Collapsed line ───────────────────────────────────────────────────
    const line = document.createElement('div')
    line.className = 'fl-tool-line'
    line.setAttribute('role', 'button')
    line.tabIndex = 0
    this.#line = line

    const icon = document.createElement('fl-icon')
    icon.setAttribute('size', '13')
    icon.className = 'fl-tool-icon'
    this.#icon = icon

    const name = document.createElement('span')
    name.className = 'fl-tool-name'
    this.#name = name

    this.#summary = document.createElement('span')
    this.#summary.className = 'fl-tool-summary'

    this.#statusGlyph = document.createElement('span')
    this.#statusGlyph.className = 'fl-tool-status'

    line.appendChild(icon)
    line.appendChild(name)
    line.appendChild(this.#summary)
    line.appendChild(this.#statusGlyph)

    const toggle = (): void => {
      // A finished sub-agent spawn's line is a DOOR, not a disclosure: it
      // opens the child-thread chat in the main pane. The one open flow —
      // index.ts's `flow:open-subagent-thread` handler — does the promotion.
      if (this.#subagentChip !== null) {
        document.dispatchEvent(
          new CustomEvent('flow:open-subagent-thread', {
            detail: { parentThreadId: this.#record.threadId, toolCallId: this.#record.id },
          }),
        )
        return
      }
      this.setExpanded(!this.#expanded)
    }
    line.addEventListener('click', toggle)
    line.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    // ── Expandable detail ────────────────────────────────────────────────
    this.#detail = document.createElement('div')
    this.#detail.className = 'fl-tool-detail'
    this.#detail.hidden = true

    const inputSection = document.createElement('div')
    inputSection.className = 'fl-tool-section'
    this.#inputLabel = document.createElement('div')
    this.#inputLabel.className = 'fl-tool-section-label'
    this.#inputLabel.textContent = 'Input'
    this.#inputPre = document.createElement('pre')
    this.#inputDiff = document.createElement('div')
    this.#inputDiff.className = 'fl-tool-diff'
    this.#inputDiff.hidden = true
    inputSection.appendChild(this.#inputLabel)
    inputSection.appendChild(this.#inputPre)
    inputSection.appendChild(this.#inputDiff)

    this.#outputSection = document.createElement('div')
    this.#outputSection.className = 'fl-tool-section'
    const outputLabel = document.createElement('div')
    outputLabel.className = 'fl-tool-section-label'
    outputLabel.textContent = 'Output'
    this.#outputPre = document.createElement('pre')
    this.#outputSection.appendChild(outputLabel)
    this.#outputSection.appendChild(this.#outputPre)

    this.#detail.appendChild(inputSection)
    this.#detail.appendChild(this.#outputSection)

    this.element.appendChild(line)
    this.element.appendChild(this.#detail)

    this.update(record)
  }

  get record(): ToolCallRecord {
    return this.#record
  }

  /** Whether the detail is open — captured/restored across a history reconcile
   *  so a rebuild doesn't silently collapse a card the user opened (#179). */
  get expanded(): boolean {
    return this.#expanded
  }

  setExpanded(value: boolean): void {
    // A finished sub-agent spawn never opens its JSON detail — its body is the
    // child THREAD now, and the expand-restore (#179) must not reopen a card
    // that collapsed to a chip mid-reconcile.
    if (this.#subagentChip !== null && value) return
    this.#expanded = value
    this.#detail.hidden = !value
    this.element.classList.toggle('expanded', value)
    // FETCHED WHEN IT IS ACTUALLY WANTED. A list read withholds every output
    // but the newest (see `outputWithheld`), because shipping a long session's
    // worth of them costs seconds the reader spends staring at a cursor. The
    // one being opened is fetched now, once, and kept.
    if (value && (this.#record.outputWithheld === true || this.#record.inputWithheld === true)) {
      void this.#loadWhole()
    }
  }

  /** Pull this call whole — the output, and the input's bulk. Fail-soft: a card
   *  is not load-bearing, and a failure must say so rather than look empty. */
  async #loadWhole(): Promise<void> {
    if (this.#loadingOutput) return
    this.#loadingOutput = true
    if (this.#record.outputWithheld === true) {
      this.#outputSection.hidden = false
      this.#outputPre.textContent = 'Loading…'
    }
    const get = window.flow?.toolCalls?.get
    try {
      const whole =
        typeof get === 'function'
          ? await get({ threadId: this.#record.threadId, toolCallId: this.#record.id })
          : null
      if (whole === null) {
        // An older preload, a deleted thread, or a row that is genuinely gone.
        // Saying so is the point: "not sent" must never render as "no output".
        this.#outputPre.textContent = '(the output could not be loaded)'
        return
      }
      this.update({ ...whole, outputWithheld: false, inputWithheld: false })
      this.#detail.hidden = !this.#expanded
    } catch (error) {
      console.error('flow: failed to load a tool output', error)
      this.#outputPre.textContent = '(the output could not be loaded)'
    } finally {
      this.#loadingOutput = false
    }
  }

  /** Refresh the card in place (tool-end, history reconcile). */
  update(record: ToolCallRecord): void {
    this.#record = record
    // #1931 follow-up: a sub-agent spawn that reached a terminal status
    // collapses to a compact one-line chip — glyph + description + a subtle
    // finished/failed word — and its click opens the promoted child thread.
    // Detection and wording come from the activity model's one code path
    // (SUBAGENT_TOOL_NAMES via `subagentSpawnChip`), never re-typed here.
    const chip = subagentSpawnChip(record.toolName, record.inputJson, record.status)
    this.#subagentChip = chip
    this.element.classList.toggle('fl-tool-subagent-chip', chip !== null)
    if (chip === null) {
      delete this.element.dataset['subagentChip']
      this.#line.removeAttribute('aria-label')
      this.#line.title = ''
    } else {
      this.element.dataset['subagentChip'] = chip.state
      // The chip reached a terminal state mid-view (tool-end on a card the
      // reader had open): the detail closes with it — the one-line chip IS the
      // collapsed presentation.
      this.#expanded = false
      this.#detail.hidden = true
      this.element.classList.remove('expanded')
      this.#icon.setAttribute('name', toolIcon(record.toolName))
      this.#name.textContent = chip.label
      const stateLine = chip.detail.length > 0 ? `${chip.detail} · ${chip.state}` : chip.state
      this.#summary.textContent = stateLine
      this.#summary.title = stateLine
      const open = `Open the sub-agent's chat: ${chip.label}`
      this.#line.title = open
      this.#line.setAttribute('aria-label', open)
      this.#renderStatus(record.status)
      return
    }
    // Brain-search Bash calls render as a "Knowledge search" card — brain
    // icon + the query as the summary. Matched on input, so it holds from
    // the running state onward; the expanded detail stays the raw JSON.
    const brain = brainSearchPresentation(record.toolName, record.inputJson)
    const kind = classifyTool(record.toolName)
    const isChange = kind === 'edit' || kind === 'write'
    this.#icon.setAttribute('name', brain ? brain.icon : toolIcon(record.toolName))
    this.#name.textContent = brain ? brain.label : record.toolName
    this.#summary.textContent = brain ? singleLine(brain.summary) : isChange ? this.#changeLine(record) : inputSummary(record.inputJson)
    this.#summary.title = this.#summary.textContent
    // THE SUMMARY IS ALWAYS REAL — the short scalars survive a summarized input
    // (see `stubInput`), so the collapsed line reads the same either way. Only
    // the expanded body admits that it is not the whole thing.
    const inputWithheld = record.inputWithheld === true
    const quoted = !brain && isChange && this.#renderChangeQuote(record)
    this.#inputDiff.hidden = !quoted
    this.#inputPre.hidden = quoted
    this.#inputLabel.textContent = quoted ? (kind === 'write' ? 'New file' : 'Change') : 'Input'
    this.#inputPre.textContent = inputWithheld
      ? `${prettyJson(record.inputJson)}\n\n(the rest is loading when you open this)`
      : prettyJson(record.inputJson) || '(no input)'
    // WITHHELD IS NOT EMPTY. A card whose output was left out of the list read
    // says there is one and offers to open it; rendering it as "no output"
    // would be the app lying about the thing it stored.
    const withheld = record.outputWithheld === true && record.outputJson === null
    const output = prettyJson(record.outputJson)
    this.#outputSection.hidden = !withheld && output === ''
    this.#outputPre.textContent = withheld ? 'Open to load the output.' : output
    this.#renderStatus(record.status)
  }

  /** Collapsed line for an edit/write: file plus WHAT changed, degrading to
   *  today's path-only summary when the change can't be derived (withheld input).
   */
  #changeLine(record: ToolCallRecord): string {
    const change = changeSummary(record)
    const path = filePathOf(record)
    const file = path === null ? '' : basename(path)
    if (file !== '' && change !== '') return file + ' ' + String.fromCharCode(183) + ' ' + change
    if (change !== '') return change
    return inputSummary(record.inputJson)
  }

  /** Build the red/green code quote into inputDiff. Returns false when there
   *  is nothing to quote (withheld/empty input) so the caller keeps the JSON pre.
   */
  #renderChangeQuote(record: ToolCallRecord): boolean {
    const parsed = safeParse(record.inputJson ?? '')
    const input =
      parsed !== undefined && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    if (input === null) return false
    const stringOf = (key: string): string =>
      typeof input[key] === 'string' ? (input[key] as string) : ''
    const diff =
      classifyTool(record.toolName) === 'write'
        ? computeLineDiff('', stringOf('content'))
        : computeLineDiff(stringOf('old_string'), stringOf('new_string'))
    if (diff.removed.length === 0 && diff.added.length === 0) return false

    this.#inputDiff.textContent = ''
    for (const line of diff.removed) this.#inputDiff.appendChild(diffLineRow('-', line, 'removed'))
    for (const line of diff.added) this.#inputDiff.appendChild(diffLineRow('+', line, 'added'))
    if (diff.truncated) {
      const note = document.createElement('div')
      note.className = 'fl-tool-diff-note'
      note.textContent = String.fromCharCode(8230) + ' truncated'
      this.#inputDiff.appendChild(note)
    }
    return true
  }

  #renderStatus(status: ToolCallStatus): void {
    this.#statusGlyph.textContent = ''
    this.element.dataset['status'] = status
    this.#statusGlyph.appendChild(statusGlyph(status))
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** One diff row - a sign gutter + the line text (blank lines stay visible). */
function diffLineRow(sign: string, text: string, kind: 'added' | 'removed'): HTMLElement {
  const row = document.createElement('div')
  row.className = 'fl-tool-diff-line fl-tool-diff-' + kind
  const gutter = document.createElement('span')
  gutter.className = 'fl-tool-diff-sign'
  gutter.textContent = sign
  const body = document.createElement('span')
  body.className = 'fl-tool-diff-text'
  body.textContent = text === '' ? ' ' : text
  row.append(gutter, body)
  return row
}

/** The status glyph for a tool card's collapsed line — ONE code path, shared
 *  with the group card's aggregate glyph (allowed-pattern #14) so a card and a
 *  group can never disagree about what "running" or "failed" looks like. */
export function statusGlyph(status: ToolCallStatus): HTMLElement {
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('size', '13')
  if (status === 'pending' || status === 'running') {
    glyph.setAttribute('name', 'spinner')
    glyph.setAttribute('spin', '')
    glyph.style.color = 'var(--fl-color-accent)'
  } else if (status === 'success') {
    glyph.setAttribute('name', 'check')
    glyph.style.color = 'var(--fl-color-success)'
  } else if (status === 'denied') {
    glyph.setAttribute('name', 'warning')
    glyph.style.color = 'var(--fl-color-warning)'
  } else if (status === 'interrupted') {
    // #1217: neutral, not the failure glyph — the user asked for this stop.
    glyph.setAttribute('name', 'minus')
    glyph.style.color = 'var(--fl-color-text-secondary)'
  } else {
    glyph.setAttribute('name', 'error')
    glyph.style.color = 'var(--fl-color-error)'
  }
  glyph.setAttribute('title', status === 'interrupted' ? 'stopped by you' : status)
  return glyph
}

/** One-line human summary of the tool input (best-known key, else JSON). */
function inputSummary(inputJson: string | null): string {
  if (!inputJson) {
    return ''
  }
  const parsed = safeParse(inputJson)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    for (const key of SUMMARY_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') {
        return singleLine(value)
      }
    }
  }
  return singleLine(inputJson)
}

function prettyJson(json: string | null): string {
  if (!json) {
    return ''
  }
  const parsed = safeParse(json)
  return parsed === undefined ? json : JSON.stringify(parsed, null, 2)
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

function singleLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat
}

// ── Styles (light DOM) ─────────────────────────────────────────────────────

let toolCardStylesInjected = false

function injectToolCardStyles(): void {
  if (toolCardStylesInjected) {
    return
  }
  toolCardStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-tool-card {
      border: var(--fl-border-width) solid var(--fl-color-border);
      /* Matches the user bubble it stacks with — the chat column's containers
         share one corner, or the feed reads as parts from two designs. */
      border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface-raised);
      overflow: hidden;
    }
    .fl-tool-line {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      height: 28px;
      padding: 0 var(--fl-space-sm);
      cursor: pointer;
      user-select: none;
      overflow: hidden;
      white-space: nowrap;
    }
    .fl-tool-line:hover { background: var(--fl-color-surface); }
    .fl-tool-icon { color: var(--fl-color-text-secondary); }
    .fl-tool-name {
      flex: none;
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
    }
    .fl-tool-summary {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
    }
    .fl-tool-status { flex: none; display: inline-flex; align-items: center; }
    .fl-tool-detail {
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      padding: var(--fl-space-sm) var(--fl-space-md);
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
    }
    .fl-tool-section-label {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: var(--fl-space-xs);
    }
    .fl-tool-section pre {
      margin: 0;
      padding: var(--fl-space-sm);
      max-height: 240px;
      overflow: auto;
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      line-height: var(--fl-line-height-dense);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .fl-tool-diff {
      max-height: 240px;
      overflow: auto;
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      line-height: var(--fl-line-height-dense);
    }
    .fl-tool-diff-line {
      display: flex;
      gap: var(--fl-space-sm);
      padding: 0 var(--fl-space-sm);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .fl-tool-diff-sign {
      flex: none;
      width: 1ch;
      text-align: center;
      user-select: none;
      opacity: 0.8;
    }
    .fl-tool-diff-text { flex: 1; min-width: 0; }
    .fl-tool-diff-added {
      color: var(--fl-color-success);
      background: color-mix(in srgb, var(--fl-color-success) 12%, transparent);
    }
    .fl-tool-diff-removed {
      color: var(--fl-color-error);
      background: color-mix(in srgb, var(--fl-color-error) 12%, transparent);
    }
    .fl-tool-diff-note {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  `
  document.head.appendChild(style)
}
