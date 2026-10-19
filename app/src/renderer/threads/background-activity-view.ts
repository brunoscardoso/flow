/**
 * A single background run, in the editor area — beside Code, Changes and the
 * board, the same shape as those (#1931).
 *
 * The footer popover lists a thread's sub-agents and terminal commands; pressing
 * one dispatches `flow:open-background-activity`, and this opens it as its own
 * tab on the right. Each run gets its own tab, keyed on the tool call's id
 * (`view:activity:<id>`), so several can be open at once and reopening one
 * re-reveals rather than duplicates (the editor's `openView` is idempotent per
 * id). The list carries no output (allowed-pattern #18); the tab fetches its own
 * with `toolCalls:get` — and, while the run is still going, re-fetches whenever
 * that tool call changes, so an open tab tails a running command.
 */
import type { EditorApi } from '../editor'
import type { ToolCallRecord } from '../../shared/ipc-contract'
import { parseInput, statusTone, str, type BackgroundActivityKind } from './background-activity-model'
import { CLOSE_SUBAGENT_VIEWS_EVENT } from './subagent-open'
import { renderMarkdown } from './markdown-renderer'
import { ToolCard } from './tool-card'
import { buildSubchatFeed, type SubchatItem } from './subagent-subchat-model'

const TAB_PREFIX = 'view:activity:'
/** The persisted identity of a run's tab in a conversation's tab set. */
const ACTIVITY_VIEW_KIND = 'background-activity'
const MAX_TAB_LABEL = 28
/** Coalesce a streaming turn's ~20 batches/second into one re-render window. */
const REFRESH_DEBOUNCE_MS = 300

/** What the footer popover hands over when a row is pressed. */
export interface OpenBackgroundActivityDetail {
  threadId: string
  toolCallId: string
  kind: BackgroundActivityKind
  label: string
}

interface OpenActivity extends OpenBackgroundActivityDetail {
  host: HTMLElement
  body: HTMLElement
  /** True once the run reached a terminal status — nothing more to tail, so
   *  later broadcasts skip it (a finished command never changes again). */
  settled: boolean
}

export function initBackgroundActivity(editorApi: EditorApi): void {
  const open = new Map<string, OpenActivity>()

  document.addEventListener('flow:open-background-activity', (event) => {
    const detail = (event as CustomEvent<Partial<OpenBackgroundActivityDetail> | undefined>).detail
    if (!detail?.threadId || !detail.toolCallId || !detail.kind) return
    void openActivityTab(editorApi, open, {
      threadId: detail.threadId,
      toolCallId: detail.toolCallId,
      kind: detail.kind,
      label: detail.label ?? 'Activity',
    })
  })

  // The main pane switched to a sub-agent child thread (#1931 D-5): every
  // right-side run tab closes — the chat supersedes them, and a disposed view
  // also leaves the conversation's persisted tab set, so it does not come back.
  document.addEventListener(CLOSE_SUBAGENT_VIEWS_EVENT, () => {
    for (const id of [...open.keys()]) {
      if (editorApi.hasTab(id)) editorApi.disposeView(id)
      open.delete(id)
    }
  })

  // A conversation's tab set coming back with a run's tab in it.
  editorApi.registerViewRestorer(ACTIVITY_VIEW_KIND, (state) => {
    const { threadId, toolCallId, kind, label } = state
    if (typeof threadId !== 'string' || typeof toolCallId !== 'string') return null
    if (kind !== 'subagent' && kind !== 'terminal') return null
    void openActivityTab(
      editorApi,
      open,
      { threadId, toolCallId, kind, label: typeof label === 'string' ? label : 'Activity' },
      false,
    )
    return TAB_PREFIX + toolCallId
  })

  // Keep an OPEN, STILL-RUNNING tab current while its run goes. A `threads:
  // updated` batch arrives ~every 50ms during a streaming turn, so this must not
  // re-render on each one (forbidden-pattern #14): the changed threads are
  // accumulated and flushed once per debounce window, and only tabs that are
  // open, affected, and not yet settled re-fetch (allowed-patterns #17/#19).
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    const threads = new Set(pending)
    pending.clear()
    for (const [id, activity] of open) {
      if (activity.settled) continue
      if (!threads.has(activity.threadId)) continue
      if (!editorApi.hasTab(id)) continue
      void renderDetail(activity)
    }
  }
  window.flow.threads.onUpdated((events) => {
    let touched = false
    for (const event of events) {
      // #1931: a sub-agent writes MESSAGES too, not just tool calls — refresh on
      // both so an open sub-chat tails the sub-agent's prose as well as its tools.
      if (event.entity !== 'tool_call' && event.entity !== 'message') continue
      pending.add(event.threadId)
      touched = true
    }
    if (!touched) return
    if (timer === null) timer = setTimeout(flush, REFRESH_DEBOUNCE_MS)
  })
}

async function openActivityTab(
  editorApi: EditorApi,
  open: Map<string, OpenActivity>,
  request: Pick<OpenActivity, 'threadId' | 'toolCallId' | 'kind' | 'label'>,
  reveal = true,
): Promise<void> {
  const id = TAB_PREFIX + request.toolCallId
  let activity = open.get(id)
  if (!activity) {
    const host = document.createElement('div')
    host.className = 'fl-bgactivity-tab'
    const body = document.createElement('div')
    body.className = 'fl-bgactivity-tab-body'
    host.append(body)
    activity = { ...request, host, body, settled: false }
    open.set(id, activity)
    injectStyles()
  }

  // Reveal the editor first, like every other view tab: opening into a hidden
  // host shows nothing and reads as a dead command. A tab-set restore is not a
  // press, and reveals nothing.
  if (reveal) document.dispatchEvent(new CustomEvent('flow:show-editor'))
  editorApi.openView({
    id,
    label: tabLabel(request.label),
    icon: request.kind === 'terminal' ? 'terminal' : 'sparkles',
    element: activity.host,
    // A run belongs to the conversation it ran in — and to its tab set.
    persist: {
      kind: ACTIVITY_VIEW_KIND,
      state: () => ({
        threadId: request.threadId,
        toolCallId: request.toolCallId,
        kind: request.kind,
        label: request.label,
      }),
    },
  })
  await renderDetail(activity)
}

async function renderDetail(activity: OpenActivity): Promise<void> {
  // Optional on the contract so an older preload degrades to a note rather than
  // throwing at the tab that asked for it.
  const getter = window.flow.toolCalls.get
  if (getter === undefined) {
    activity.body.replaceChildren(note('Activity detail is unavailable in this build.'))
    return
  }
  let record: ToolCallRecord | null
  try {
    record = await getter({
      threadId: activity.threadId,
      toolCallId: activity.toolCallId,
    })
  } catch (error) {
    console.error('flow: background activity detail fetch failed', {
      toolCallId: activity.toolCallId,
      error,
    })
    return
  }

  activity.body.replaceChildren()
  if (record === null) {
    activity.body.append(note('This activity is no longer available.'))
    return
  }

  // A terminal run or a settled sub-agent never changes again; mark it so the
  // broadcast loop stops re-fetching it.
  const running = statusTone(record.status) === 'running'
  activity.settled = !running

  activity.body.append(headerRow(activity, record))

  const input = parseInput(record.inputJson)
  if (activity.kind === 'terminal') {
    const command = str(input.command)
    if (command.length > 0) activity.body.append(section('Command', command))
    // `toolCalls:get` returns whole records, never withheld ones — so empty
    // output on a running call means "not produced yet", not "produced nothing".
    const output = outputText(record.outputJson)
    const outputBody =
      output.length > 0 ? output : running ? '(still running — no output yet)' : '(no output)'
    activity.body.append(section('Output', outputBody))
    return
  }

  // Sub-agent (#1931): agent type + prompt, then the SUB-CHAT — the sub-agent's
  // own messages and tool calls, in order — then its final result.
  const agentType = str(input.subagent_type)
  if (agentType.length > 0) activity.body.append(metaLine('Agent', agentType))
  const prompt = str(input.prompt)
  if (prompt.length > 0) activity.body.append(section('Prompt', prompt))

  let feed: SubchatItem[] = []
  const transcriptFn = window.flow.threads.subagentTranscript
  if (transcriptFn !== undefined) {
    try {
      const transcript = await transcriptFn({
        threadId: activity.threadId,
        toolCallId: activity.toolCallId,
      })
      feed = buildSubchatFeed(transcript.messages, transcript.toolCalls)
    } catch (error) {
      console.error('flow: sub-agent transcript fetch failed', {
        toolCallId: activity.toolCallId,
        error,
      })
    }
  }

  const execLabel = document.createElement('div')
  execLabel.className = 'fl-bgactivity-tab-label'
  execLabel.textContent = 'Execution'
  activity.body.append(execLabel)

  if (feed.length === 0) {
    activity.body.append(
      note(
        transcriptFn === undefined
          ? 'Sub-agent transcript is unavailable in this build.'
          : running
            ? 'Running — no activity captured yet.'
            : 'No sub-agent activity was captured.',
      ),
    )
  } else {
    const chat = document.createElement('div')
    chat.className = 'fl-bgactivity-subchat'
    chat.style.cssText = 'display:flex;flex-direction:column;gap:var(--fl-space-sm, 8px);'
    for (const item of feed) {
      if (item.kind === 'tool') {
        const card = new ToolCard(item.toolCall)
        chat.append(card.element)
      } else if (item.message.role === 'assistant' && item.message.content.trim().length > 0) {
        const msg = document.createElement('div')
        msg.className = 'fl-bgactivity-subchat-msg'
        msg.append(renderMarkdown(item.message.content))
        chat.append(msg)
      }
      // A sub-agent 'user' message is its tool RESULTS — already shown by the
      // tool cards above — so the raw block is not rendered again.
    }
    activity.body.append(chat)
  }

  // The sub-agent's final returned result (the parent Task tool call's output).
  const output = outputText(record.outputJson)
  if (output.length > 0) activity.body.append(section('Result', output))
}

function headerRow(activity: OpenActivity, record: ToolCallRecord): HTMLElement {
  const row = document.createElement('div')
  row.className = 'fl-bgactivity-tab-header'

  const title = document.createElement('div')
  title.className = 'fl-bgactivity-tab-title'
  title.textContent = activity.label

  const badge = document.createElement('span')
  badge.className = `fl-bgactivity-tab-status fl-bgactivity-tab-status--${statusTone(record.status)}`
  badge.textContent = record.status

  row.append(title, badge)
  return row
}

function section(heading: string, body: string): HTMLElement {
  const wrap = document.createElement('section')
  wrap.className = 'fl-bgactivity-tab-section'

  const label = document.createElement('div')
  label.className = 'fl-bgactivity-tab-label'
  label.textContent = heading

  const pre = document.createElement('pre')
  pre.className = 'fl-bgactivity-tab-pre'
  pre.textContent = body

  wrap.append(label, pre)
  return wrap
}

function metaLine(key: string, value: string): HTMLElement {
  const line = document.createElement('div')
  line.className = 'fl-bgactivity-tab-meta'
  line.textContent = `${key}: ${value}`
  return line
}

function note(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'fl-bgactivity-tab-note'
  p.textContent = text
  return p
}

function tabLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed.length <= MAX_TAB_LABEL) return trimmed
  return `${trimmed.slice(0, MAX_TAB_LABEL - 1)}…`
}

/**
 * A tool call's stored output as readable text.
 *
 * The blob is JSON, but its shape varies by tool: a bare string, `{ text }`, or
 * an array of content parts. Pull the text out when it is there; otherwise
 * pretty-print, so nothing is ever a blank pane when there IS output.
 */
function outputText(json: string | null): string {
  if (json === null) return ''
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return json
  }
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => (typeof part === 'object' && part !== null ? str((part as Record<string, unknown>).text) : ''))
      .filter((part) => part.length > 0)
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof value === 'object' && value !== null) {
    const text = str((value as Record<string, unknown>).text)
    if (text.length > 0) return text
  }
  return JSON.stringify(value, null, 2)
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
.fl-bgactivity-tab { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--fl-color-surface, #141414); }
.fl-bgactivity-tab-body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--fl-space-lg, 16px); display: flex; flex-direction: column; gap: var(--fl-space-md, 12px); }
.fl-bgactivity-tab-header { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); }
.fl-bgactivity-tab-title { flex: 1; min-width: 0; font-size: var(--fl-text-ui-size, 13px); font-weight: var(--fl-text-ui-weight-medium, 600); color: var(--fl-color-text, #ddd); }
.fl-bgactivity-tab-status { flex: none; padding: 1px 8px; border-radius: 999px; font-size: var(--fl-text-caption-size, 12px); text-transform: capitalize; background: var(--fl-color-surface-raised, #1f1f1f); color: var(--fl-color-text-secondary, #aaa); }
.fl-bgactivity-tab-status--running { color: var(--fl-color-accent, #4a9eff); }
.fl-bgactivity-tab-status--done { color: var(--fl-color-success, #4ec9b0); }
.fl-bgactivity-tab-status--error { color: var(--fl-color-error, #f14c4c); }
.fl-bgactivity-tab-meta { font-size: var(--fl-text-caption-size, 12px); color: var(--fl-color-text-secondary, #aaa); }
.fl-bgactivity-tab-section { display: flex; flex-direction: column; gap: var(--fl-space-xs, 4px); min-width: 0; }
.fl-bgactivity-tab-label { font-size: var(--fl-text-caption-size, 12px); font-weight: var(--fl-text-ui-weight-medium, 600); color: var(--fl-color-text-secondary, #aaa); text-transform: uppercase; letter-spacing: .04em; }
.fl-bgactivity-tab-pre { margin: 0; padding: var(--fl-space-sm, 8px) var(--fl-space-md, 12px); border: var(--fl-border-width, 1px) solid var(--fl-color-border, #2a2a2a); border-radius: var(--fl-radius-sm, 4px); background: var(--fl-color-surface-raised, #1f1f1f); color: var(--fl-color-text, #ddd); font-family: var(--fl-font-mono, monospace); font-size: var(--fl-text-caption-size, 12px); line-height: var(--fl-line-height-dense, 1.4); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
.fl-bgactivity-tab-note { margin: 0; font-size: var(--fl-text-ui-size, 13px); color: var(--fl-color-text-secondary, #aaa); }
`
  document.head.appendChild(style)
}
