/**
 * Live sub-agent progress tab (#1931).
 *
 * Opened from the LEFT SIDEBAR's running-agent rows (thread-sidebar.ts dispatches
 * `flow:open-subagent-progress` with the thread id, the runtime task id and the
 * BackgroundTaskInfo). It shows that sub-agent's live progress — description,
 * agent type, elapsed, and the tools it has run — fed by the `background-tasks`
 * stream, keyed on the runtime task id. No persisted transcript needed, so it
 * works for backgrounded sub-agents. When the task drops off the live set it
 * settles to "Done".
 */
import '../components'
import type { EditorApi } from '../editor'
import type { BackgroundTaskInfo } from '../../shared/ipc-contract'
import { taskLabel } from './background-task-rows'
import { CLOSE_SUBAGENT_VIEWS_EVENT } from './subagent-open'
import {
  foldProgress,
  initialProgress,
  markDone,
  type SubagentProgress,
} from './subagent-progress-model'

const TAB_PREFIX = 'view:subagent-progress:'
const MAX_TAB_LABEL = 28

interface OpenProgress {
  threadId: string
  taskId: string
  host: HTMLElement
  progress: SubagentProgress
}

export function initSubagentProgress(editorApi: EditorApi): void {
  const open = new Map<string, OpenProgress>()

  document.addEventListener('flow:open-subagent-progress', (event) => {
    const detail = (
      event as CustomEvent<
        | { threadId?: string; taskId?: string; task?: BackgroundTaskInfo; running?: boolean }
        | undefined
      >
    ).detail
    if (!detail?.threadId || !detail.taskId || !detail.task) return
    openTab(editorApi, open, detail.threadId, detail.taskId, detail.task, detail.running ?? true)
  })

  // The main pane switched to a sub-agent child thread (#1931 D-5) — the chat
  // IS the sub-agent's surface now, so every live-progress tab goes, including
  // one this module opened via the fallback for the same task moments before.
  document.addEventListener(CLOSE_SUBAGENT_VIEWS_EVENT, () => {
    for (const id of [...open.keys()]) {
      if (editorApi.hasTab(id)) editorApi.disposeView(id)
      open.delete(id)
    }
  })

  // Live: each background-tasks snapshot updates every open progress tab for
  // that thread; a task absent from the set has finished.
  window.flow.threads.onStream((event) => {
    if (event.kind !== 'background-tasks') return
    for (const [id, entry] of open) {
      if (entry.threadId !== event.threadId) continue
      const task = event.tasks.find((candidate) => candidate.id === entry.taskId)
      entry.progress = task ? foldProgress(entry.progress, task) : markDone(entry.progress)
      if (editorApi.hasTab(id)) render(entry)
    }
  })
}

function openTab(
  editorApi: EditorApi,
  open: Map<string, OpenProgress>,
  threadId: string,
  taskId: string,
  task: BackgroundTaskInfo,
  running: boolean,
): void {
  const id = TAB_PREFIX + taskId
  let entry = open.get(id)
  if (!entry) {
    injectStyles()
    const host = document.createElement('div')
    host.className = 'fl-subprogress'
    let progress = initialProgress(task, taskLabel(task))
    // Reopening a FINISHED sub-agent (retained in the chip after its run) — show
    // it as Done, not stuck on Running (#1931).
    if (!running) progress = markDone(progress)
    entry = { threadId, taskId, host, progress }
    open.set(id, entry)
  } else {
    entry.progress = foldProgress(entry.progress, task)
  }
  document.dispatchEvent(new CustomEvent('flow:show-editor'))
  editorApi.openView({
    id,
    label: tabLabel(taskLabel(task)),
    icon: 'sparkles',
    element: entry.host,
  })
  render(entry)
}

function render(entry: OpenProgress): void {
  const p = entry.progress
  entry.host.replaceChildren()

  const header = document.createElement('div')
  header.className = 'fl-subprogress-header'
  const icon = document.createElement('fl-icon')
  icon.setAttribute('name', 'sparkles')
  icon.setAttribute('size', '14')
  header.appendChild(icon)
  const title = document.createElement('span')
  title.className = 'fl-subprogress-title'
  title.textContent = p.title
  header.appendChild(title)
  if (p.agentType) {
    const type = document.createElement('span')
    type.className = 'fl-subprogress-type'
    type.textContent = p.agentType
    header.appendChild(type)
  }
  const status = document.createElement('span')
  status.className = `fl-subprogress-status fl-subprogress-status-${p.status}`
  status.textContent =
    p.elapsedMs != null
      ? `${p.status === 'running' ? 'Running' : 'Done'} · ${formatElapsed(p.elapsedMs)}`
      : p.status === 'running'
        ? 'Running'
        : 'Done'
  header.appendChild(status)
  entry.host.appendChild(header)

  const label = document.createElement('div')
  label.className = 'fl-subprogress-label'
  label.textContent = 'Tools'
  entry.host.appendChild(label)

  const list = document.createElement('div')
  list.className = 'fl-subprogress-tools'
  if (p.log.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'fl-subprogress-empty'
    empty.textContent =
      p.status === 'running' ? 'Waiting for the first step…' : 'No steps were reported.'
    list.appendChild(empty)
  } else {
    p.log.forEach((tool, index) => {
      const row = document.createElement('div')
      row.className = 'fl-subprogress-tool'
      const dot = document.createElement('span')
      dot.className = 'fl-subprogress-dot'
      // The newest tool pulses while the sub-agent is still running.
      if (p.status === 'running' && index === p.log.length - 1) {
        dot.classList.add('fl-subprogress-dot-live')
      }
      const name = document.createElement('span')
      name.textContent = tool
      row.append(dot, name)
      list.appendChild(row)
    })
  }
  entry.host.appendChild(list)
}

function tabLabel(label: string): string {
  return label.length > MAX_TAB_LABEL ? `${label.slice(0, MAX_TAB_LABEL - 1)}…` : label
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-subprogress {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--fl-color-surface, #1f1f1f);
      color: var(--fl-color-text, #ddd);
      font-family: var(--fl-font-ui);
      overflow-y: auto;
    }
    .fl-subprogress-header {
      flex: none;
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm, 8px);
      padding: var(--fl-space-sm, 8px) var(--fl-space-md, 12px);
      background: var(--fl-color-surface, #1f1f1f);
      border-bottom: var(--fl-border-width, 1px) solid var(--fl-color-border, #2a2a2a);
    }
    .fl-subprogress-header fl-icon { flex: none; color: var(--fl-color-text-secondary, #9d9d9d); }
    .fl-subprogress-title { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-subprogress-type {
      flex: none; padding: 1px 6px; border-radius: var(--fl-radius-sm, 4px);
      background: var(--fl-color-accent-muted, rgba(55,148,255,0.16)); color: var(--fl-color-accent, #3794ff);
      font-family: var(--fl-font-mono); font-size: 10px;
    }
    .fl-subprogress-status { flex: none; font-size: var(--fl-text-caption-size, 11px); color: var(--fl-color-text-secondary, #9d9d9d); }
    .fl-subprogress-status-running { color: var(--fl-color-warning, #cca700); }
    .fl-subprogress-status-done { color: var(--fl-color-success, #89d185); }
    .fl-subprogress-label {
      flex: none; padding: var(--fl-space-md, 12px) var(--fl-space-md, 12px) var(--fl-space-xs, 4px);
      color: var(--fl-color-text-secondary, #9d9d9d); font-size: var(--fl-text-caption-size, 11px);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .fl-subprogress-tools { padding: 0 var(--fl-space-md, 12px) var(--fl-space-md, 12px); display: flex; flex-direction: column; gap: 2px; }
    .fl-subprogress-empty { color: var(--fl-color-text-secondary, #9d9d9d); padding: 4px 0; }
    .fl-subprogress-tool {
      display: flex; align-items: center; gap: var(--fl-space-sm, 8px);
      padding: 3px var(--fl-space-sm, 8px); border-radius: var(--fl-radius-sm, 4px);
      font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size, 13px);
    }
    .fl-subprogress-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--fl-color-text-secondary, #9d9d9d); }
    .fl-subprogress-dot-live { background: var(--fl-color-warning, #cca700); animation: fl-subprogress-pulse 1.4s ease-in-out infinite; }
    @keyframes fl-subprogress-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  `
  document.head.appendChild(style)
}
