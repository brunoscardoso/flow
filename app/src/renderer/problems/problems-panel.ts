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
 * TERMINALS: main also reads every user terminal's output and keeps its
 * errors and warnings (main/terminal/terminal-problems-service.ts); they are
 * read here under the same cost rules (`terminal:problems`), and the counters
 * add them to the editor's. Their change broadcast carries the counts, so the
 * counters never need a read for it. Rules for the section live in
 * terminal-problems-view-model.ts.
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
  refsOf,
  sourceLabel,
  type Problem,
  type ProblemFile,
  type ProblemRef,
  type ProblemsSnapshot,
} from '../../shared/problems-model'
import type {
  TerminalProblem,
  TerminalProblemGroup,
  TerminalProblemsSnapshot,
} from '../../shared/terminal-problems'
import { PROBLEMS_COALESCE_MS, problemsReadLimit, terminalProblemsReadLimit } from './problems-refresh-model'
import {
  combinedCounts,
  combinedToggleLabel,
  contextBlock,
  copyAllText,
  countsTooltip,
  DEFAULT_PROBLEMS_FILTER,
  emptyText,
  filterFiles,
  filterTerminalGroups,
  groupHeading,
  problemCopyText,
  problemMetaLine,
  showsFiles,
  showsTerminals,
  TERMINAL_PROBLEMS_STRINGS as T,
  terminalFixMessage,
  timesLabel,
  type ProblemsFilter,
  type ProblemsSource,
} from './terminal-problems-view-model'

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
  const readTerminalProblems = api.terminal.problems?.bind(api.terminal)

  // ── The Problems toggle (right side, beside the panel's own buttons) ────
  // No "Terminal" tab: the terminal tabs already say what the panel shows
  // (user decision 2026-11-17). Pressing Problems shows the list; pressing it
  // again — or any terminal action — brings the terminals back.
  const problemsTab = document.createElement('button')
  problemsTab.className = 'fl-term-tool fl-problems-toggle'
  problemsTab.dataset['view'] = 'problems'
  problemsTab.setAttribute('aria-pressed', 'false')
  problemsTab.title = T.toggleTitle
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
  const copyAllButton = document.createElement('button')
  copyAllButton.className = 'fl-term-tool fl-problems-copy-all'
  copyAllButton.title = T.copyAllTitle
  copyAllButton.append(icon('copy', 12), document.createTextNode(T.copyAll))
  const clearTerminalsButton = document.createElement('button')
  clearTerminalsButton.className = 'fl-term-tool fl-problems-clear-terminals'
  clearTerminalsButton.title = T.clearTerminalsTitle
  clearTerminalsButton.textContent = T.clearTerminals
  actions.append(heading, summary, spacer, copyAllButton, clearTerminalsButton, fixAllButton, divider)
  header.insertBefore(actions, mount.before)
  header.insertBefore(problemsTab, mount.before)

  // ── Body ────────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.className = 'fl-problems-body'
  const filterBar = document.createElement('div')
  filterBar.className = 'fl-problems-filters'
  filterBar.setAttribute('role', 'toolbar')
  const listEl = document.createElement('div')
  listEl.className = 'fl-problems-content'
  body.append(filterBar, listEl)
  root.appendChild(body)

  // ── State ───────────────────────────────────────────────────────────────
  let listShown = false
  let stale = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let readSeq = 0
  let snapshot: ProblemsSnapshot = { files: [], counts: emptyCounts(), withheld: 0 }
  let terminalSnapshot: TerminalProblemsSnapshot = { counts: { errors: 0, warnings: 0 }, groups: [], withheld: 0 }
  let filter: ProblemsFilter = { ...DEFAULT_PROBLEMS_FILTER }
  /** The terminal problem whose row is open, by id. */
  let openId: string | null = null
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
    const surface = { rendered: rendered(), listShown }
    const limit = problemsReadLimit(surface)
    const terminalLimit = terminalProblemsReadLimit(surface)
    if (limit === null || terminalLimit === null) return // stays stale until shown
    if (readProblems === undefined && readTerminalProblems === undefined) return
    stale = false
    const seq = ++readSeq
    try {
      const [next, nextTerminals] = await Promise.all([
        readProblems === undefined ? Promise.resolve(snapshot) : readProblems({ limit }),
        readTerminalProblems === undefined ? Promise.resolve(terminalSnapshot) : readTerminalProblems({ limit: terminalLimit }),
      ])
      if (seq !== readSeq) return // a newer read is on its way
      snapshot = next
      // A counts-only read keeps the list held from the last full read.
      terminalSnapshot = terminalLimit === 0 ? { ...terminalSnapshot, counts: nextTerminals.counts } : nextTerminals
      paintLabel()
      if (listShown) paintList()
    } catch (error) {
      console.warn('flow: failed to read problems', error)
      stale = true
    }
  }

  // ── Painting ────────────────────────────────────────────────────────────

  function paintLabel(): void {
    const { errors, warnings } = combinedCounts(snapshot.counts, terminalSnapshot.counts)
    errorCount.textContent = String(errors)
    warningCount.textContent = String(warnings)
    problemsTab.classList.toggle('has-errors', errors > 0)
    problemsTab.classList.toggle('has-warnings', warnings > 0)
    problemsTab.setAttribute('aria-label', combinedToggleLabel(snapshot.counts, terminalSnapshot.counts))
    problemsTab.title = `${T.toggleTitle}. ${countsTooltip(snapshot.counts, terminalSnapshot.counts)}`
    const total = errors + warnings + snapshot.counts.infos
    problemsTab.dataset['count'] = String(total)
    problemsTab.dataset['errors'] = String(errors)
    problemsTab.dataset['warnings'] = String(warnings)
    summary.textContent = countSummary({ errors, warnings, infos: snapshot.counts.infos, total })
    const terminalTotal = terminalSnapshot.counts.errors + terminalSnapshot.counts.warnings
    clearTerminalsButton.disabled = terminalTotal === 0
    copyAllButton.disabled = terminalSnapshot.groups.length === 0 && snapshot.files.length === 0
    paintFixState(fixAllButton, snapshot.counts.total > 0)
    fixAllButton.title = fixDisabledReason(threadId) ?? 'Send every problem to the agent in this conversation'
  }

  function paintFixState(button: HTMLButtonElement, hasProblems: boolean): void {
    const reason = fixDisabledReason(threadId)
    button.disabled = reason !== null || !hasProblems
    if (reason !== null) button.title = reason
  }

  function shownTerminalGroups(): TerminalProblemGroup[] {
    return filterTerminalGroups(terminalSnapshot.groups, filter)
  }

  function paintFilters(): void {
    filterBar.textContent = ''
    const sources: Array<[ProblemsSource, string]> = [
      ['all', T.filterAll],
      ['terminals', T.filterTerminals],
      ['files', T.filterFiles],
    ]
    for (const [source, label] of sources) {
      filterBar.appendChild(
        chip(label, filter.source === source, { source }, () => {
          filter = { ...filter, source }
          paintList()
        }),
      )
    }
    const gap = document.createElement('span')
    gap.className = 'fl-problems-chip-gap'
    filterBar.appendChild(gap)
    filterBar.appendChild(
      chip(T.filterErrors, filter.errors, { severity: 'error' }, () => {
        filter = { ...filter, errors: !filter.errors }
        paintList()
      }),
    )
    filterBar.appendChild(
      chip(T.filterWarnings, filter.warnings, { severity: 'warning' }, () => {
        filter = { ...filter, warnings: !filter.warnings }
        paintList()
      }),
    )
  }

  function chip(label: string, on: boolean, data: Record<string, string>, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'fl-problems-chip'
    button.textContent = label
    button.setAttribute('aria-pressed', String(on))
    for (const [key, value] of Object.entries(data)) button.dataset[key] = value
    button.addEventListener('click', onPress)
    return button
  }

  function sectionHeading(text: string): HTMLElement {
    const heading = document.createElement('div')
    heading.className = 'fl-problems-section'
    heading.textContent = text
    return heading
  }

  function paintList(): void {
    const scrollTop = body.scrollTop
    paintFilters()
    listEl.textContent = ''
    const groups = shownTerminalGroups()
    const files = filterFiles(snapshot.files, filter)
    if (groups.length === 0 && files.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-problems-empty'
      empty.textContent =
        filter.source === 'files' && snapshot.files.length === 0 && filter.errors && filter.warnings
          ? NO_PROBLEMS_TEXT
          : emptyText(filter, snapshot.files.length > 0, terminalSnapshot.groups.length > 0)
      listEl.appendChild(empty)
      return
    }
    const list = document.createElement('div')
    list.className = 'fl-problems-list'
    const both = filter.source === 'all'
    if (showsTerminals(filter) && groups.length > 0) {
      if (both) list.appendChild(sectionHeading(T.sectionTerminals))
      for (const group of groups) list.appendChild(terminalGroup(group))
      if (terminalSnapshot.withheld > 0) {
        const more = document.createElement('div')
        more.className = 'fl-problems-more'
        more.textContent = `${terminalSnapshot.withheld} more from terminals not shown.`
        list.appendChild(more)
      }
    }
    if (showsFiles(filter) && files.length > 0) {
      if (both && groups.length > 0) list.appendChild(sectionHeading(T.sectionFiles))
      for (const file of files) list.appendChild(fileGroup(file))
      if (snapshot.withheld > 0) {
        const more = document.createElement('div')
        more.className = 'fl-problems-more'
        more.textContent = `${snapshot.withheld} more not shown. Fix the ones above first.`
        list.appendChild(more)
      }
    }
    listEl.appendChild(list)
    body.scrollTop = scrollTop
  }

  // ── Terminal problems ───────────────────────────────────────────────────

  function terminalGroup(group: TerminalProblemGroup): HTMLElement {
    const element = document.createElement('div')
    element.className = 'fl-problems-tgroup'
    element.dataset['terminalId'] = group.terminalId
    const head = document.createElement('div')
    head.className = 'fl-problems-thead'
    const heading = groupHeading(group)
    const label = document.createElement('b')
    label.textContent = heading.label
    const detail = document.createElement('span')
    detail.textContent = heading.detail
    head.append(icon('terminal', 12), label, detail)
    element.appendChild(head)
    for (const problem of group.problems) element.appendChild(terminalRow(group, problem))
    return element
  }

  function terminalRow(group: TerminalProblemGroup, problem: TerminalProblem): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-problems-titem'
    const isOpen = openId === problem.id
    const row = document.createElement('div')
    row.className = `fl-problems-trow${isOpen ? ' open' : ''}`
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', String(isOpen))
    row.dataset['severity'] = problem.severity
    row.dataset['problemId'] = problem.id
    const severity = icon(SEVERITY_ICON[problem.severity])
    severity.classList.add(`fl-problems-${problem.severity}`)
    severity.setAttribute('aria-label', problem.severity)
    const text = document.createElement('div')
    text.className = 'fl-problems-ttext'
    const message = document.createElement('div')
    message.className = 'fl-problems-tmsg'
    message.textContent = problem.message
    const meta = document.createElement('div')
    meta.className = 'fl-problems-tmeta'
    meta.textContent = problemMetaLine(problem)
    text.append(message, meta)
    const times = document.createElement('span')
    times.className = 'fl-problems-times'
    times.textContent = timesLabel(problem.count)
    row.append(severity, text, times)
    const toggle = (): void => {
      openId = openId === problem.id ? null : problem.id
      paintList()
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })
    wrap.appendChild(row)
    if (isOpen) {
      const block = contextBlock(problem)
      const context = document.createElement('div')
      context.className = 'fl-problems-context'
      for (const line of block.before) {
        const lineEl = document.createElement('div')
        lineEl.textContent = line
        context.appendChild(lineEl)
      }
      const hl = document.createElement('div')
      hl.className = `fl-problems-hl fl-problems-${problem.severity}`
      hl.textContent = block.line
      context.appendChild(hl)
      const bar = document.createElement('div')
      bar.className = 'fl-problems-dbar'
      const copy = actionButton(T.copy, 'copy', () => copyText(problemCopyText(group, problem)))
      copy.dataset['action'] = 'copy'
      const show = actionButton(T.showInTerminal, 'terminal', () => showInTerminal(group.terminalId))
      show.dataset['action'] = 'show'
      const fix = actionButton(T.fixWithAgent, 'sparkles', () => {
        if (threadId === null) return
        document.dispatchEvent(
          new CustomEvent('flow:send-prompt', { detail: { threadId, text: terminalFixMessage(group, problem) } }),
        )
      })
      fix.dataset['action'] = 'fix'
      const reason = fixDisabledReason(threadId)
      fix.disabled = reason !== null
      fix.title = reason ?? T.fixTitle
      bar.append(copy, show, fix)
      wrap.append(context, bar)
    }
    return wrap
  }

  function actionButton(label: string, iconName: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'fl-term-tool fl-problems-dbtn'
    button.append(icon(iconName, 12), document.createTextNode(label))
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onPress()
    })
    button.addEventListener('keydown', (event) => event.stopPropagation())
    return button
  }

  function toast(title: string, level: 'info' | 'error'): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: { kind: 'state-change', rootId: '', title, body: '', timestamp: new Date().toISOString(), level },
      }),
    )
  }

  function copyText(text: string): void {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast(T.copied, 'info'))
      .catch(() => toast(T.copyFailed, 'error'))
  }

  function showInTerminal(terminalId: string): void {
    setView('terminal')
    document.dispatchEvent(new CustomEvent('flow:terminal-focus', { detail: { terminalId } }))
  }

  copyAllButton.addEventListener('click', () => {
    const parts: string[] = []
    const groups = shownTerminalGroups()
    if (groups.length > 0) parts.push(copyAllText(groups))
    const files = filterFiles(snapshot.files, filter)
    for (const ref of refsOf(files)) {
      parts.push(`${ref.filePath}:${ref.problem.line}:${ref.problem.column} — ${ref.problem.severity}: ${ref.problem.message}`)
    }
    if (parts.length > 0) copyText(parts.join('\n\n'))
  })

  clearTerminalsButton.addEventListener('click', () => {
    const clear = api.terminal.clearProblems?.bind(api.terminal)
    if (clear === undefined) return
    openId = null
    terminalSnapshot = { counts: { errors: 0, warnings: 0 }, groups: [], withheld: 0 }
    paintLabel()
    if (listShown) paintList()
    void clear()
      .then(() => schedule(0))
      .catch((error: unknown) => console.warn('flow: failed to clear terminal problems', error))
  })

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
  // Terminal problems: the broadcast carries the counts — the counters need
  // no read; the list (only while shown) reads once after the quiet window.
  api.terminal.onProblemsChanged?.((counts) => {
    terminalSnapshot = { ...terminalSnapshot, counts }
    if (!rendered()) {
      stale = true
      return
    }
    paintLabel()
    if (listShown) schedule()
  })

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
    .fl-problems-filters {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 6px var(--fl-space-sm);
      border-bottom: 1px solid var(--fl-color-border);
      background: var(--fl-color-surface);
    }
    .fl-problems-chip {
      padding: 0 10px;
      min-height: 20px;
      border: 1px solid var(--fl-color-border);
      border-radius: 99px;
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .fl-problems-chip[aria-pressed='true'] {
      border-color: var(--fl-color-accent);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-problems-chip:focus-visible { outline: 1px solid var(--fl-color-focus-ring); }
    .fl-problems-chip-gap { width: var(--fl-space-sm); }
    .fl-problems-content { min-height: 0; }
    .fl-problems-filters + .fl-problems-content .fl-problems-empty { height: auto; padding-top: 24px; }
    .fl-problems-section {
      padding: 6px var(--fl-space-sm) 2px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .fl-problems-thead {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      padding: 6px var(--fl-space-sm) 2px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-problems-thead b { color: var(--fl-color-text); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-problems-trow {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) auto;
      gap: var(--fl-space-sm);
      align-items: start;
      padding: 4px var(--fl-space-sm) 4px 18px;
      cursor: pointer;
    }
    .fl-problems-trow > fl-icon { margin-top: 2px; }
    .fl-problems-trow:hover,
    .fl-problems-trow.open { background: var(--fl-color-surface-raised); }
    .fl-problems-trow:focus-visible { outline: 1px solid var(--fl-color-focus-ring); outline-offset: -1px; }
    .fl-problems-tmsg {
      color: var(--fl-color-text);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
      line-height: 1.45;
      word-break: break-word;
      user-select: text;
    }
    .fl-problems-tmeta {
      margin-top: 1px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-problems-times {
      padding: 0 7px;
      border-radius: 99px;
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
      font-weight: 600;
      white-space: nowrap;
    }
    .fl-problems-trow.open .fl-problems-times { background: var(--fl-color-surface); }
    .fl-problems-context {
      margin: 4px var(--fl-space-sm) 6px 42px;
      padding: 6px 10px;
      overflow-x: auto;
      border: 1px solid var(--fl-color-border);
      border-radius: 6px;
      background: var(--fl-color-surface);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
      line-height: 1.5;
      white-space: pre;
      user-select: text;
    }
    .fl-problems-dbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0 var(--fl-space-sm) 8px 42px;
    }
    .fl-problems-dbtn { display: inline-flex; align-items: center; gap: 4px; }
  `
  document.head.appendChild(style)
}
