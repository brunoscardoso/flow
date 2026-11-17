/**
 * Problems — the second view of the bottom panel, beside Terminal.
 *
 * The list of what the editor's language checking found in open files,
 * grouped by file, with "Fix with agent" on a problem, on a file and for all
 * of them. It draws main's diagnostics and owns none: main keeps the latest
 * report per file and answers `editor:problems` with a bounded snapshot
 * (shared/problems-model.ts builds it, and the agent message too).
 *
 * COST RULES (allowed-patterns #17/#18): a diagnostics event only marks the
 * list stale and arms ONE trailing timer; the read that follows is skipped
 * while the panel is off screen, is counts-only while the terminal is shown,
 * and is the bounded list only while Problems is shown. Coming back on screen
 * re-reads once.
 *
 * Fix with agent goes through the composer's own send (`flow:send-prompt`),
 * like the chat cards' buttons: a person's press, echoed in their thread as a
 * message they can read and interrupt — never a second route to the agent.
 */
import type { FlowApi } from '../../shared/ipc-contract'
import {
  countSummary,
  emptyCounts,
  fileLabel,
  fixDisabledReason,
  fixMessage,
  NO_PROBLEMS_TEXT,
  problemsToggleLabel,
  refsOf,
  sourceLabel,
  type Problem,
  type ProblemFile,
  type ProblemRef,
  type ProblemsSnapshot,
} from '../../shared/problems-model'
import { PROBLEMS_COALESCE_MS, problemsReadLimit } from './problems-refresh-model'

export interface ProblemsMount {
  /** The bottom panel's root (`.fl-term-root`): the view classes go on it. */
  root: HTMLElement
  /** Its header — the actions and the Problems toggle go in front of `before`. */
  header: HTMLElement
  /** Header element the Problems actions are inserted in front of. */
  before: Element
  api: FlowApi
}

export interface ProblemsController {
  /** Back to the terminal view (a new terminal was asked for). */
  showTerminalView(): void
}

const SEVERITY_ICON: Record<Problem['severity'], string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

function icon(name: string, size = 14): HTMLElement {
  const element = document.createElement('fl-icon')
  element.setAttribute('name', name)
  element.setAttribute('size', String(size))
  return element
}

export function mountProblems(mount: ProblemsMount): ProblemsController {
  injectProblemsStyles()
  const { root, header, api } = mount
  const readProblems = api.editor.problems?.bind(api.editor)

  // ── The Problems toggle (right side, beside the panel's own buttons) ────
  // No "Terminal" tab: the terminal tabs already say what the panel shows
  // (user decision 2026-11-17). Pressing Problems shows the list; pressing it
  // again — or any terminal action — brings the terminals back.
  const problemsTab = document.createElement('button')
  problemsTab.className = 'fl-term-tool fl-problems-toggle'
  problemsTab.dataset['view'] = 'problems'
  problemsTab.setAttribute('aria-pressed', 'false')
  problemsTab.title = 'Problems in open files'
  // Counts, like a status bar (mockup option A, user decision 2026-11-17):
  // an error icon and count, a warning icon and count. Grey zeros when clean.
  const errorCount = document.createElement('span')
  const warningCount = document.createElement('span')
  const errorIcon = icon('error', 13)
  const warningIcon = icon('warning', 13)
  errorIcon.classList.add('fl-problems-toggle-icon')
  warningIcon.classList.add('fl-problems-toggle-icon')
  problemsTab.append(errorIcon, errorCount, warningIcon, warningCount)

  // ── Problems header actions ─────────────────────────────────────────────
  const actions = document.createElement('div')
  actions.className = 'fl-problems-actions'
  const heading = document.createElement('span')
  heading.className = 'fl-problems-heading'
  heading.textContent = 'Problems'
  const summary = document.createElement('span')
  summary.className = 'fl-problems-summary'
  const spacer = document.createElement('span')
  spacer.className = 'fl-problems-spacer'
  const divider = document.createElement('span')
  divider.className = 'fl-problems-divider'
  const fixAllButton = document.createElement('button')
  fixAllButton.className = 'fl-term-tool fl-problems-fix-all'
  fixAllButton.append(icon('sparkles', 12), document.createTextNode('Fix all'))
  actions.append(heading, summary, spacer, fixAllButton, divider)
  header.insertBefore(actions, mount.before)
  header.insertBefore(problemsTab, mount.before)

  // ── Body ────────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.className = 'fl-problems-body'
    root.appendChild(body)

  // ── State ───────────────────────────────────────────────────────────────
  let listShown = false
  let stale = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let readSeq = 0
  let snapshot: ProblemsSnapshot = { files: [], counts: emptyCounts(), withheld: 0 }
  let threadId: string | null = null
  let threadRoot: string | null = null
  let sawThreadSignal = false
  const collapsed = new Set<string>()

  function rendered(): boolean {
    return root.isConnected && root.getClientRects().length > 0
  }

  function schedule(delay = PROBLEMS_COALESCE_MS): void {
    stale = true
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void read()
    }, delay)
  }

  async function read(): Promise<void> {
    const limit = problemsReadLimit({ rendered: rendered(), listShown })
    if (limit === null || readProblems === undefined) return // stays stale until shown
    stale = false
    const seq = ++readSeq
    try {
      const next = await readProblems({ limit })
      if (seq !== readSeq) return // a newer read is on its way
      snapshot = next
      paintLabel()
      if (listShown) paintList()
    } catch (error) {
      console.warn('flow: failed to read problems', error)
      stale = true
    }
  }

  // ── Painting ────────────────────────────────────────────────────────────

  function paintLabel(): void {
    const { errors, warnings } = snapshot.counts
    errorCount.textContent = String(errors)
    warningCount.textContent = String(warnings)
    problemsTab.classList.toggle('has-errors', errors > 0)
    problemsTab.classList.toggle('has-warnings', warnings > 0)
    problemsTab.setAttribute('aria-label', problemsToggleLabel(snapshot.counts))
    problemsTab.dataset['count'] = String(snapshot.counts.total)
    summary.textContent = countSummary(snapshot.counts)
    paintFixState(fixAllButton, snapshot.counts.total > 0)
    fixAllButton.title = fixDisabledReason(threadId) ?? 'Send every problem to the agent in this conversation'
  }

  function paintFixState(button: HTMLButtonElement, hasProblems: boolean): void {
    const reason = fixDisabledReason(threadId)
    button.disabled = reason !== null || !hasProblems
    if (reason !== null) button.title = reason
  }

  function paintList(): void {
    const scrollTop = body.scrollTop
    body.textContent = ''
    if (snapshot.files.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-problems-empty'
      empty.textContent = NO_PROBLEMS_TEXT
      body.appendChild(empty)
      return
    }
    const list = document.createElement('div')
    list.className = 'fl-problems-list'
    for (const file of snapshot.files) list.appendChild(fileGroup(file))
    if (snapshot.withheld > 0) {
      const more = document.createElement('div')
      more.className = 'fl-problems-more'
      more.textContent = `${snapshot.withheld} more not shown. Fix the ones above first.`
      list.appendChild(more)
    }
    body.appendChild(list)
    body.scrollTop = scrollTop
  }

  function fileKey(file: ProblemFile): string {
    return `${file.rootId}\u0000${file.filePath}`
  }

  function fileGroup(file: ProblemFile): HTMLElement {
    const group = document.createElement('div')
    group.className = 'fl-problems-group'
    const key = fileKey(file)
    const isCollapsed = collapsed.has(key)
    group.dataset['file'] = file.filePath

    const head = document.createElement('div')
    head.className = 'fl-problems-file'
    head.setAttribute('role', 'button')
    head.tabIndex = 0
    head.setAttribute('aria-expanded', String(!isCollapsed))
    const label = fileLabel(file.filePath)
    const name = document.createElement('span')
    name.className = 'fl-problems-file-name'
    name.textContent = label.name
    const folder = document.createElement('span')
    folder.className = 'fl-problems-file-folder'
    folder.textContent = label.folder
    folder.title = file.filePath
    const counts = document.createElement('span')
    counts.className = 'fl-problems-file-counts'
    if (file.counts.errors > 0) counts.append(countChip('error', file.counts.errors))
    if (file.counts.warnings > 0) counts.append(countChip('warning', file.counts.warnings))
    if (file.counts.infos > 0) counts.append(countChip('info', file.counts.infos))
    counts.title = countSummary(file.counts)
    const fix = fixButton('Fix with agent', true, () =>
      send(refsOf([file]), file.counts.total - file.problems.length),
    )
    head.append(icon(isCollapsed ? 'chevron-right' : 'chevron-down', 12), name, folder, counts, fix)
    const toggle = (): void => {
      if (collapsed.has(key)) collapsed.delete(key)
      else collapsed.add(key)
      paintList()
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })
    group.appendChild(head)

    if (!isCollapsed) {
      for (const problem of file.problems) group.appendChild(problemRow(file, problem))
      const unsent = file.counts.total - file.problems.length
      if (unsent > 0) {
        const more = document.createElement('div')
        more.className = 'fl-problems-more'
        more.textContent = `${unsent} more in this file not shown.`
        group.appendChild(more)
      }
    }
    return group
  }

  function countChip(severity: Problem['severity'], count: number): HTMLElement {
    const chip = document.createElement('span')
    chip.className = `fl-problems-count fl-problems-${severity}`
    chip.append(icon(SEVERITY_ICON[severity], 12), document.createTextNode(String(count)))
    return chip
  }

  function problemRow(file: ProblemFile, problem: Problem): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-problems-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.dataset['severity'] = problem.severity
    const severity = icon(SEVERITY_ICON[problem.severity])
    severity.classList.add(`fl-problems-${problem.severity}`)
    severity.setAttribute('aria-label', problem.severity)
    const message = document.createElement('span')
    message.className = 'fl-problems-message'
    message.textContent = problem.message
    message.title = problem.message
    const source = document.createElement('span')
    source.className = 'fl-problems-source'
    source.textContent = sourceLabel(problem)
    const position = document.createElement('span')
    position.className = 'fl-problems-position'
    position.textContent = `${problem.line}:${problem.column}`
    const fix = fixButton('Fix with agent', false, () =>
      send([{ rootId: file.rootId, filePath: file.filePath, problem }], 0),
    )
    row.append(severity, message, source, position, fix)
    const open = (): void => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', {
          detail: { rootPath: file.rootId, relPath: file.filePath, line: problem.line, column: problem.column },
        }),
      )
    }
    row.addEventListener('click', open)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        open()
      }
    })
    return row
  }

  function fixButton(label: string, withText: boolean, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = `fl-term-tool fl-problems-fix${withText ? '' : ' fl-problems-fix-icon'}`
    button.setAttribute('aria-label', label)
    button.title = 'Send to the agent in this conversation'
    button.append(icon('sparkles', 12))
    if (withText) button.append(document.createTextNode(label))
    paintFixState(button, true)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onPress()
    })
    button.addEventListener('keydown', (event) => event.stopPropagation())
    return button
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  function send(refs: ProblemRef[], notSent: number): void {
    if (threadId === null) return
    const text = fixMessage(refs, threadRoot, notSent)
    if (text === null) return
    document.dispatchEvent(new CustomEvent('flow:send-prompt', { detail: { threadId, text } }))
  }

  fixAllButton.addEventListener('click', () => send(refsOf(snapshot.files), snapshot.withheld))

  // ── View switching ──────────────────────────────────────────────────────

  function setView(view: 'terminal' | 'problems'): void {
    const next = view === 'problems'
    if (next === listShown) return
    listShown = next
    root.classList.toggle('fl-problems-mode', listShown)
    problemsTab.classList.toggle('active', listShown)
    problemsTab.setAttribute('aria-pressed', String(listShown))
    if (listShown) {
      paintList() // the snapshot already held, at once — then a fresh read
      void read()
    }
  }
  problemsTab.addEventListener('click', () => setView(listShown ? 'terminal' : 'problems'))

  // ── Signals ─────────────────────────────────────────────────────────────

  api.editor.onDiagnostics(() => schedule())

  // Back on screen (the panel re-attached or grew from nothing): one read if
  // anything changed while nobody could see it.
  new ResizeObserver(() => {
    if (stale && timer === null && rendered()) schedule(0)
  }).observe(root)

  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId?: string | null; projectRoot?: string | null }>).detail
    sawThreadSignal = true
    threadId = detail?.threadId ?? null
    threadRoot = threadId === null ? null : (detail?.projectRoot ?? null)
    paintLabel()
    if (listShown) paintList()
  })
  // Boot: the project's last conversation may be selected before this panel
  // listened. The signal, when it comes, wins.
  void api.project
    .active()
    .then((context) => {
      if (sawThreadSignal || !context?.activeThreadId) return
      threadId = context.activeThreadId
      threadRoot = context.rootPath ?? null
      paintLabel()
      if (listShown) paintList()
    })
    .catch(() => {
      // No active project yet — Fix stays disabled until a conversation opens.
    })

  paintLabel()
  schedule(0)

  return {
    showTerminalView: () => setView('terminal'),
  }
}

// ── Styles (light DOM, injected once) ────────────────────────────────────

let stylesInjected = false

function injectProblemsStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-problems-toggle { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .fl-problems-toggle .fl-problems-toggle-icon { color: var(--fl-color-text-secondary); }
    .fl-problems-toggle > span { color: var(--fl-color-text-secondary); }
    .fl-problems-toggle > fl-icon + span { margin-right: 4px; }
    .fl-problems-toggle > span:last-child { margin-right: 0; }
    .fl-problems-toggle.has-errors .fl-problems-toggle-icon:first-child { color: var(--fl-color-error); }
    .fl-problems-toggle.has-errors > span:nth-of-type(1) { color: var(--fl-color-text); }
    .fl-problems-toggle.has-warnings .fl-problems-toggle-icon:nth-of-type(2) { color: var(--fl-color-warning); }
    .fl-problems-toggle.has-warnings > span:nth-of-type(2) { color: var(--fl-color-text); }
    .fl-problems-toggle.active {
      color: var(--fl-color-text);
      background: var(--fl-color-surface-raised);
      box-shadow: inset 0 -2px 0 var(--fl-color-accent);
    }
    .fl-problems-heading {
      flex: none;
      padding-left: var(--fl-space-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-problems-spacer { flex: 1; }
    .fl-problems-divider {
      flex: none;
      width: 1px;
      height: 16px;
      background: var(--fl-color-border);
    }
    .fl-problems-mode .fl-term-header { min-height: var(--fl-tab-height); }
    .fl-problems-actions,
    .fl-problems-body { display: none; }
    .fl-problems-mode .fl-term-tabs,
    .fl-problems-mode .fl-term-hosts,
    .fl-problems-mode .fl-term-only { display: none !important; }
    .fl-problems-mode .fl-problems-actions {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: var(--fl-space-sm);
      flex: 1;
      min-width: 0;
    }
    .fl-problems-mode .fl-problems-body {
      display: block;
      flex: 1;
      min-height: 0;
      overflow: auto;
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-problems-summary {
      overflow: hidden;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .fl-problems-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 0 var(--fl-space-md, 12px);
      color: var(--fl-color-text-secondary);
      text-align: center;
      user-select: none;
    }
    .fl-problems-list { padding: 2px 0; }
    .fl-problems-file,
    .fl-problems-row {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      min-height: 22px;
      padding: 0 var(--fl-space-xs) 0 var(--fl-space-sm);
      cursor: pointer;
      user-select: none;
    }
    .fl-problems-row { padding-left: 28px; }
    .fl-problems-file:hover,
    .fl-problems-row:hover { background: var(--fl-color-surface-raised); }
    .fl-problems-file:focus-visible,
    .fl-problems-row:focus-visible {
      outline: 1px solid var(--fl-color-focus-ring);
      outline-offset: -1px;
    }
    .fl-problems-file fl-icon,
    .fl-problems-row fl-icon { flex: none; }
    .fl-problems-file-name { flex: none; color: var(--fl-color-text); }
    .fl-problems-file-folder {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .fl-problems-file-counts { display: inline-flex; gap: var(--fl-space-sm); flex: none; }
    .fl-problems-count {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: var(--fl-text-caption-size);
    }
    .fl-problems-error { color: var(--fl-color-error); }
    .fl-problems-warning { color: var(--fl-color-warning); }
    .fl-problems-info { color: var(--fl-color-accent); }
    .fl-problems-message {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: var(--fl-color-text);
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .fl-problems-source,
    .fl-problems-position {
      flex: none;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
    }
    .fl-problems-position { font-variant-numeric: tabular-nums; }
    .fl-problems-fix-icon { padding: 0 var(--fl-space-xs); opacity: 0; }
    .fl-problems-row:hover .fl-problems-fix-icon,
    .fl-problems-row:focus-within .fl-problems-fix-icon,
    .fl-problems-fix-icon:focus-visible { opacity: 1; }
    .fl-problems-file .fl-problems-fix { opacity: 0; }
    .fl-problems-file:hover .fl-problems-fix,
    .fl-problems-file:focus-within .fl-problems-fix { opacity: 1; }
    .fl-problems-more {
      padding: 2px var(--fl-space-sm) 2px 28px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  `
  document.head.appendChild(style)
}
