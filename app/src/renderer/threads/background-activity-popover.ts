/**
 * The "Background work" panel, opened above the composer from the footer pill
 * (plan_mid-run-subtasks FR-10 to FR-16).
 *
 * The pill toggles this; it opens ON the pill (`openAnchoredPopover`) and flips
 * ABOVE the input. It owns none of its own lifecycle (settle-once, Escape at
 * capture, close on outside click, toggle on re-click all come from the shell)
 * and keeps the shell's surface (`fl-fmenu`).
 *
 * What it draws is `backgroundWorkView` — sections by state (Running, Queued,
 * Failed, then Done, closed), the person's subtasks first and skill work by
 * run. A row opens INLINE: what the person asked, the overlap warning, the
 * steps (read through the sub-agent transcript only when the row opens —
 * never with the list, allowed-pattern #18), the files written, the error and
 * the attempts, and the way into the full conversation (#1931's open path).
 *
 * Actions, on the person's subtasks only:
 *   - Stop   asks main to stop that one subtask; a refusal's sentence is shown.
 *   - Steer  puts a target chip on the composer (`flow:steer-subtask`).
 *   - Retry  sends the agent a plain request through the composer's own
 *            composed-send path (`flow:send-prompt`); the agent starts the
 *            retry, and the row then reads "attempt 2".
 */
import {
  injectAnchoredMenuStyles,
  openAnchoredPopover,
  type AnchoredPopover,
} from './anchored-popover'
import { backgroundActivityStore, type BackgroundActivitySnapshot } from './background-activity-store'
import {
  backgroundWorkView,
  formatWorkDuration,
  retryPrompt,
  transcriptSteps,
  type WorkItem,
  type WorkSection,
  type WorkStep,
} from './background-work-model'
import { openSubagentTask } from './subagent-open'

export interface BackgroundActivityPopoverHandle {
  close(): void
}

/** Dispatched by Steer; the composer shows a target chip for the subtask. */
export const STEER_SUBTASK_EVENT = 'flow:steer-subtask'

/** Names and statuses only — a step reads no tool output (allowed-pattern #18). */
const STEP_OUTPUT_LIMIT = 1

interface PanelState {
  /** Rows opened inline, by item key. */
  expanded: Set<string>
  doneOpen: boolean
  /** Steps read for an opened row, by item key; 'loading' while in flight. */
  steps: Map<string, WorkStep[] | 'loading' | 'unavailable'>
  /** A sentence to show on a row (a refused Stop), by item key. */
  notices: Map<string, string>
  /** Stops in flight, by item key. */
  stopping: Set<string>
  threadId: string | null
  snapshot: BackgroundActivitySnapshot | null
}

export function openBackgroundActivityPopover(
  anchor: HTMLElement,
  onClose: () => void,
): BackgroundActivityPopoverHandle {
  injectAnchoredMenuStyles()
  injectStyles()

  let unsubscribe: (() => void) | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  const popover: AnchoredPopover = openAnchoredPopover({
    anchor,
    className: 'fl-fmenu',
    ariaLabel: 'Background work',
    onClose: () => {
      if (unsubscribe) unsubscribe()
      if (ticker !== null) clearInterval(ticker)
      onClose()
    },
  })
  popover.panel.classList.add('fl-bgwork')

  const title = document.createElement('div')
  title.className = 'fl-fmenu-title'
  title.textContent = 'Background work'

  const list = document.createElement('div')
  list.className = 'fl-bgwork-list'

  popover.panel.append(title, list)

  const state: PanelState = {
    expanded: new Set(),
    doneOpen: false,
    steps: new Map(),
    notices: new Map(),
    stopping: new Set(),
    threadId: null,
    snapshot: null,
  }

  const rerender = (): void => {
    if (state.snapshot !== null) render(list, state.snapshot, state, popover, rerender)
  }

  unsubscribe = backgroundActivityStore.subscribe({
    onScreen: () => popover.panel.isConnected,
    render: (snapshot) => {
      if (snapshot.threadId !== state.threadId) {
        state.expanded.clear()
        state.steps.clear()
        state.notices.clear()
        state.stopping.clear()
        state.threadId = snapshot.threadId
      }
      state.snapshot = snapshot
      rerender()
    },
  })

  // Running durations tick once a second, as text only — the list is not
  // rebuilt, so an opened row and the scroll position stay put. Only while
  // the panel is open (allowed-pattern #17).
  ticker = setInterval(() => {
    if (!popover.panel.isConnected) return
    const now = Date.now()
    for (const span of list.querySelectorAll<HTMLElement>('[data-started-at]')) {
      const started = Number(span.dataset.startedAt)
      if (!Number.isNaN(started)) span.textContent = formatWorkDuration(now - started, true)
    }
  }, 1000)

  return { close: () => popover.close() }
}

function render(
  list: HTMLElement,
  snapshot: BackgroundActivitySnapshot,
  state: PanelState,
  popover: AnchoredPopover,
  rerender: () => void,
): void {
  const scroll = popover.panel.scrollTop
  list.replaceChildren()
  const view = backgroundWorkView({ ...snapshot, now: Date.now() })

  if (view.sections.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'fl-fmenu-body'
    empty.textContent = 'Nothing running in the background.'
    list.append(empty)
    popover.reposition()
    return
  }

  for (const section of view.sections) {
    list.append(buildSection(section, snapshot.threadId, state, popover, rerender))
  }
  popover.reposition()
  popover.panel.scrollTop = scroll
}

function buildSection(
  section: WorkSection,
  threadId: string | null,
  state: PanelState,
  popover: AnchoredPopover,
  rerender: () => void,
): HTMLElement {
  const wrap = document.createElement('section')
  wrap.className = `fl-bgwork-section fl-bgwork-section--${section.state}`

  const collapsible = section.collapsed
  const open = !collapsible || state.doneOpen
  if (collapsible) {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'fl-bgwork-section-title fl-bgwork-section-toggle'
    toggle.setAttribute('aria-expanded', String(open))
    toggle.textContent = `${open ? '▾' : '▸'} ${section.title}`
    toggle.addEventListener('click', () => {
      state.doneOpen = !state.doneOpen
      rerender()
    })
    wrap.append(toggle)
  } else {
    const heading = document.createElement('div')
    heading.className = 'fl-bgwork-section-title'
    heading.textContent = section.title
    wrap.append(heading)
  }
  if (!open) return wrap

  for (const group of section.groups) {
    const groupTitle = document.createElement('div')
    groupTitle.className = 'fl-bgwork-group-title'
    groupTitle.textContent = group.title
    wrap.append(groupTitle)
    for (const item of group.items) wrap.append(buildItem(item, threadId, state, popover, rerender))
  }
  return wrap
}

function buildItem(
  item: WorkItem,
  threadId: string | null,
  state: PanelState,
  popover: AnchoredPopover,
  rerender: () => void,
): HTMLElement {
  const expanded = state.expanded.has(item.key)
  const row = document.createElement('div')
  row.className = `fl-bgwork-item fl-bgwork-item--${item.tone}`
  row.classList.toggle('is-open', expanded)

  const head = document.createElement('div')
  head.className = 'fl-bgwork-item-head'

  // The row's name is the toggle: one press opens it inline.
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'fl-bgwork-item-toggle'
  toggle.setAttribute('aria-expanded', String(expanded))

  const dot = document.createElement('span')
  dot.className = `fl-bgwork-dot fl-bgwork-dot--${item.tone}`
  dot.setAttribute('aria-hidden', 'true')

  const text = document.createElement('span')
  text.className = 'fl-bgwork-item-text'
  const name = document.createElement('span')
  name.className = 'fl-bgwork-item-title'
  name.textContent = item.title
  text.append(name)
  if (item.subline !== null) {
    const sub = document.createElement('span')
    sub.className = item.tone === 'error' ? 'fl-bgwork-item-sub fl-bgwork-item-sub--error' : 'fl-bgwork-item-sub'
    sub.textContent = item.subline
    text.append(sub)
  }
  toggle.append(dot, text)
  toggle.title = item.subline === null ? item.title : `${item.title}\n${item.subline}`
  toggle.addEventListener('click', () => {
    if (state.expanded.has(item.key)) {
      state.expanded.delete(item.key)
    } else {
      state.expanded.add(item.key)
      if (threadId !== null) void loadSteps(item, threadId, state, rerender)
    }
    rerender()
  })
  head.append(toggle)

  if (item.overlapFiles.length > 0) {
    const tag = document.createElement('span')
    tag.className = 'fl-bgwork-tag'
    tag.textContent = item.overlapFiles.length === 1 ? 'shared file' : `${String(item.overlapFiles.length)} shared files`
    tag.title = `Also changed by other work in this request: ${item.overlapFiles.map(baseName).join(', ')}`
    head.append(tag)
  }

  if (item.meta.length > 0 || item.startedAtMs !== null) {
    const meta = document.createElement('span')
    meta.className = 'fl-bgwork-item-meta'
    if (item.startedAtMs !== null && item.runs === 1 && item.attempts.length === 0 && item.tone === 'running') {
      // A running duration ticks in place (see the ticker).
      meta.dataset.startedAt = String(item.startedAtMs)
    }
    meta.textContent = item.meta
    head.append(meta)
  }

  if (threadId !== null) {
    if (item.canSteer && item.ticket !== null) {
      head.append(
        actionButton('Steer', `Send your next message to “${item.title}” only`, () => {
          document.dispatchEvent(
            new CustomEvent(STEER_SUBTASK_EVENT, {
              detail: { threadId, ticket: item.ticket, title: item.title },
            }),
          )
          popover.close()
        }),
      )
    }
    if (item.canStop && item.ticket !== null) {
      const stopping = state.stopping.has(item.key)
      const stop = actionButton(stopping ? 'Stopping…' : 'Stop', `Stop “${item.title}”`, () => {
        void stopSubtask(item, threadId, state, rerender)
      })
      stop.disabled = stopping
      head.append(stop)
    }
    if (item.canRetry && item.ticket !== null) {
      const ticket = item.ticket
      head.append(
        actionButton('Retry', `Ask the agent to retry “${item.title}”`, () => {
          document.dispatchEvent(
            new CustomEvent('flow:send-prompt', {
              detail: { threadId, text: retryPrompt(item.title, ticket) },
            }),
          )
          popover.close()
        }),
      )
    }
  }

  row.append(head)

  const notice = state.notices.get(item.key)
  if (notice !== undefined) {
    const line = document.createElement('div')
    line.className = 'fl-bgwork-notice'
    line.setAttribute('role', 'status')
    line.textContent = notice
    row.append(line)
  }

  if (expanded) row.append(buildDetail(item, threadId, state, popover))
  return row
}

function buildDetail(
  item: WorkItem,
  threadId: string | null,
  state: PanelState,
  popover: AnchoredPopover,
): HTMLElement {
  const detail = document.createElement('div')
  detail.className = 'fl-bgwork-detail'

  if (item.sourceText !== null) {
    detail.append(label('You asked'))
    const asked = document.createElement('div')
    asked.className = 'fl-bgwork-asked'
    asked.textContent = item.sourceText
    detail.append(asked)
  }

  for (const file of item.overlapFiles) {
    const warn = document.createElement('div')
    warn.className = 'fl-bgwork-warning'
    warn.append('This subtask and other work in this request both changed ')
    const code = document.createElement('code')
    code.textContent = baseName(file)
    code.title = file
    warn.append(code, '. The later change wins.')
    detail.append(warn)
  }

  if (item.error !== null) {
    const error = document.createElement('div')
    error.className = 'fl-bgwork-error'
    error.textContent = item.error
    detail.append(error)
  }

  if (item.attempts.length > 0) {
    detail.append(label('Attempts'))
    const attempts = document.createElement('ol')
    attempts.className = 'fl-bgwork-attempts'
    for (const attempt of item.attempts) {
      const li = document.createElement('li')
      li.className = `fl-bgwork-attempt fl-bgwork-attempt--${attempt.tone}`
      const words = document.createElement('span')
      words.textContent = attempt.text
      li.append(words)
      if (attempt.duration !== null) {
        const time = document.createElement('span')
        time.className = 'fl-bgwork-item-meta'
        time.textContent = attempt.duration
        li.append(time)
      }
      attempts.append(li)
    }
    detail.append(attempts)
  }

  if (item.toolCallId !== null) {
    detail.append(label('Steps'))
    const steps = state.steps.get(item.key)
    if (steps === undefined || steps === 'loading') {
      detail.append(muted('Reading the steps…'))
    } else if (steps === 'unavailable') {
      detail.append(muted('The steps could not be read.'))
    } else if (steps.length === 0) {
      detail.append(muted(item.tone === 'running' ? 'No steps yet.' : 'No steps were recorded.'))
    } else {
      const ol = document.createElement('ol')
      ol.className = 'fl-bgwork-steps'
      for (const step of steps) {
        const li = document.createElement('li')
        li.className = 'fl-bgwork-step'
        const number = document.createElement('span')
        number.className = 'fl-bgwork-step-number'
        number.textContent = String(step.number)
        const words = document.createElement('span')
        words.className = 'fl-bgwork-step-text'
        words.textContent = step.text
        const count = document.createElement('span')
        count.className = 'fl-bgwork-item-meta'
        count.textContent = step.running
          ? 'running'
          : step.tools === 0
            ? ''
            : `${String(step.tools)} ${step.tools === 1 ? 'tool' : 'tools'}`
        li.append(number, words, count)
        ol.append(li)
      }
      detail.append(ol)
    }
  }

  if (item.filesWritten.length > 0) {
    detail.append(label('Files written'))
    const files = document.createElement('ul')
    files.className = 'fl-bgwork-files'
    for (const file of item.filesWritten) {
      const li = document.createElement('li')
      li.className = item.overlapFiles.includes(file) ? 'fl-bgwork-file is-shared' : 'fl-bgwork-file'
      li.textContent = baseName(file)
      li.title = file
      files.append(li)
    }
    detail.append(files)
  }

  if (threadId !== null && (item.toolCallId !== null || item.row?.task !== undefined)) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'fl-bgwork-link'
    open.textContent = 'Open the full conversation'
    open.addEventListener('click', () => {
      openConversation(item, threadId)
      popover.close()
    })
    detail.append(open)
  }
  return detail
}

/** #1931's open path: a persisted spawn becomes a child thread in the main
 *  pane; a live task with no spawn found opens its progress view. */
function openConversation(item: WorkItem, threadId: string): void {
  const row = item.row
  if (row !== null && row.source === 'task' && row.task !== undefined) {
    void openSubagentTask(threadId, row.task, { label: row.label, running: row.running })
    return
  }
  const toolCallId = item.toolCallId
  if (toolCallId === null) return
  document.dispatchEvent(
    new CustomEvent('flow:open-subagent-thread', {
      detail: { parentThreadId: threadId, toolCallId },
    }),
  )
}

async function loadSteps(
  item: WorkItem,
  threadId: string,
  state: PanelState,
  rerender: () => void,
): Promise<void> {
  const toolCallId = item.toolCallId
  if (toolCallId === null) return
  const transcriptFn = window.flow.threads.subagentTranscript
  if (transcriptFn === undefined) {
    state.steps.set(item.key, 'unavailable')
    rerender()
    return
  }
  if (!state.steps.has(item.key)) state.steps.set(item.key, 'loading')
  try {
    const transcript = await transcriptFn({ threadId, toolCallId, outputLimit: STEP_OUTPUT_LIMIT })
    if (state.threadId !== threadId) return
    state.steps.set(item.key, transcriptSteps(transcript.messages, transcript.toolCalls, item.tone === 'running'))
  } catch (error) {
    console.error('flow: sub-agent steps fetch failed', { toolCallId, error })
    if (state.threadId !== threadId) return
    state.steps.set(item.key, 'unavailable')
  }
  rerender()
}

async function stopSubtask(
  item: WorkItem,
  threadId: string,
  state: PanelState,
  rerender: () => void,
): Promise<void> {
  const ticket = item.ticket
  const api = window.flow.subtasks
  if (ticket === null) return
  if (api === undefined) {
    state.notices.set(item.key, 'Stopping a subtask is not available in this version.')
    rerender()
    return
  }
  state.stopping.add(item.key)
  state.notices.delete(item.key)
  rerender()
  try {
    const result = await api.stop({ threadId, ticket })
    if (!result.ok) state.notices.set(item.key, result.detail ?? 'The subtask could not be stopped.')
  } catch (error) {
    console.error('flow: subtask stop failed', { ticket, error })
    state.notices.set(item.key, 'The subtask could not be stopped. Try again.')
  } finally {
    state.stopping.delete(item.key)
  }
  // The row's new state arrives as a subtask event; this redraws the button.
  if (state.threadId === threadId) rerender()
}

function actionButton(text: string, aria: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-bgwork-action'
  button.textContent = text
  button.title = aria
  button.setAttribute('aria-label', aria)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    run()
  })
  return button
}

function label(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'fl-bgwork-label'
  el.textContent = text
  return el
}

function muted(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'fl-bgwork-muted'
  el.textContent = text
  return el
}

/** A file's own name — the full path stays in the tooltip. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // Existing tokens only, over the shared fl-fmenu shell.
  style.textContent = [
    '.fl-fmenu.fl-bgwork { width: min(460px, calc(100vw - var(--fl-space-xl))); }',
    '.fl-bgwork-list { display: flex; flex-direction: column; gap: var(--fl-space-sm); min-width: 0; }',
    '.fl-bgwork-section { display: flex; flex-direction: column; gap: var(--fl-space-xs); min-width: 0; }',
    '.fl-bgwork-section-title { font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text-secondary); text-transform: uppercase; letter-spacing: .06em; }',
    '.fl-bgwork-section--failed > .fl-bgwork-section-title { color: var(--fl-color-error, #f14c4c); }',
    '.fl-bgwork-section-toggle { background: none; border: none; padding: 0; text-align: left; cursor: pointer; font-family: inherit; }',
    '.fl-bgwork-section-toggle:hover { color: var(--fl-color-text); }',
    '.fl-bgwork-section-toggle:focus-visible { outline: 1px solid var(--fl-color-focus-ring); }',
    '.fl-bgwork-group-title { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); margin-top: 2px; }',
    '.fl-bgwork-item { display: flex; flex-direction: column; gap: var(--fl-space-xs); padding: var(--fl-space-xs) var(--fl-space-sm); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); background: var(--fl-color-surface-raised); min-width: 0; }',
    '.fl-bgwork-item.is-open { border-color: var(--fl-color-accent-muted); }',
    '.fl-bgwork-item-head { display: flex; align-items: center; gap: var(--fl-space-xs); min-width: 0; }',
    '.fl-bgwork-item-toggle { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: var(--fl-space-sm); padding: 0; background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }',
    '.fl-bgwork-item-toggle:focus-visible { outline: 1px solid var(--fl-color-focus-ring); outline-offset: 2px; }',
    '.fl-bgwork-item-text { display: flex; flex-direction: column; min-width: 0; }',
    '.fl-bgwork-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fl-text-ui-size); }',
    '.fl-bgwork-item-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }',
    '.fl-bgwork-item-sub--error { color: var(--fl-color-error, #f14c4c); }',
    '.fl-bgwork-item-meta { flex: none; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }',
    '.fl-bgwork-tag { flex: none; font-size: var(--fl-text-caption-size); padding: 0 6px; border-radius: 999px; border: var(--fl-border-width) solid var(--fl-color-warning, var(--fl-color-error, #f14c4c)); color: var(--fl-color-warning, var(--fl-color-error, #f14c4c)); white-space: nowrap; }',
    '.fl-bgwork-action { flex: none; padding: 1px 8px; border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); background: var(--fl-color-surface); color: var(--fl-color-text); font: inherit; font-size: var(--fl-text-caption-size); cursor: pointer; }',
    '.fl-bgwork-action:hover:not(:disabled) { border-color: var(--fl-color-accent); }',
    '.fl-bgwork-action:disabled { opacity: .6; cursor: default; }',
    '.fl-bgwork-action:focus-visible { outline: 1px solid var(--fl-color-focus-ring); }',
    '.fl-bgwork-notice { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }',
    '.fl-bgwork-dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--fl-color-text-secondary); }',
    '.fl-bgwork-dot--done { background: var(--fl-color-success, #4ec9b0); }',
    '.fl-bgwork-dot--error { background: var(--fl-color-error, #f14c4c); }',
    '.fl-bgwork-dot--queued { background: transparent; border: 1px solid var(--fl-color-text-secondary); }',
    '.fl-bgwork-dot--running { background: var(--fl-color-accent, #4a9eff); animation: fl-bgwork-pulse 1.2s ease-in-out infinite; }',
    '@keyframes fl-bgwork-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }',
    '@media (prefers-reduced-motion: reduce) { .fl-bgwork-dot--running { animation: none; } }',
    '.fl-bgwork-detail { display: flex; flex-direction: column; gap: var(--fl-space-xs); padding-left: calc(8px + var(--fl-space-sm)); min-width: 0; }',
    '.fl-bgwork-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); margin-top: 2px; }',
    '.fl-bgwork-asked { font-size: var(--fl-text-caption-size); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 8em; overflow-y: auto; }',
    '.fl-bgwork-warning { font-size: var(--fl-text-caption-size); padding: var(--fl-space-xs) var(--fl-space-sm); border-left: 2px solid var(--fl-color-warning, var(--fl-color-error, #f14c4c)); background: var(--fl-color-surface); }',
    '.fl-bgwork-warning code, .fl-bgwork-file { font-family: var(--fl-font-mono); }',
    '.fl-bgwork-error { font-size: var(--fl-text-caption-size); font-family: var(--fl-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; padding: var(--fl-space-xs) var(--fl-space-sm); border: var(--fl-border-width) solid var(--fl-color-error, #f14c4c); border-radius: var(--fl-radius-sm); color: var(--fl-color-text); }',
    '.fl-bgwork-steps, .fl-bgwork-attempts, .fl-bgwork-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fl-text-caption-size); }',
    '.fl-bgwork-step, .fl-bgwork-attempt { display: flex; align-items: baseline; gap: var(--fl-space-sm); min-width: 0; }',
    '.fl-bgwork-step-number { flex: none; min-width: 1.4em; color: var(--fl-color-text-secondary); font-variant-numeric: tabular-nums; }',
    '.fl-bgwork-step-text, .fl-bgwork-attempt > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.fl-bgwork-attempt--error > span:first-child { color: var(--fl-color-error, #f14c4c); }',
    '.fl-bgwork-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.fl-bgwork-file.is-shared { color: var(--fl-color-warning, var(--fl-color-error, #f14c4c)); }',
    '.fl-bgwork-muted { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }',
    '.fl-bgwork-link { align-self: flex-start; padding: 0; background: none; border: none; color: var(--fl-color-accent); font: inherit; font-size: var(--fl-text-caption-size); cursor: pointer; }',
    '.fl-bgwork-link:hover { text-decoration: underline; }',
    '.fl-bgwork-link:focus-visible { outline: 1px solid var(--fl-color-focus-ring); }',
  ].join('\n')
  document.head.appendChild(style)
}
