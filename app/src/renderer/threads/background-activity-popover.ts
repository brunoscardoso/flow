/**
 * The list of a thread's background work, opened above the composer.
 *
 * The footer button toggles this; it opens ON the button (`openAnchoredPopover`)
 * and — because the button sits at the very foot of the pane — flips ABOVE the
 * input, which is where the reference puts it. It owns none of its own lifecycle
 * (settle-once, Escape-at-capture, close-on-outside-click, toggle-on-reclick all
 * come from the shell) and none of its own surface styling (`fl-fmenu`, the same
 * menu the branch chip uses). What it adds is the rows: one per sub-agent or
 * terminal run, each opening its own detail tab on the right when pressed.
 */
import {
  injectAnchoredMenuStyles,
  openAnchoredPopover,
  type AnchoredPopover,
} from './anchored-popover'
import { backgroundActivityStore, type BackgroundActivitySnapshot } from './background-activity-store'
import { statusTone, type BackgroundActivityRow } from './background-activity-model'
import { openSubagentTask } from './subagent-open'

export interface BackgroundActivityPopoverHandle {
  close(): void
}

export function openBackgroundActivityPopover(
  anchor: HTMLElement,
  onClose: () => void,
): BackgroundActivityPopoverHandle {
  injectAnchoredMenuStyles()
  injectStyles()

  let unsubscribe: (() => void) | null = null
  const popover: AnchoredPopover = openAnchoredPopover({
    anchor,
    className: 'fl-fmenu',
    ariaLabel: 'Sub-agents activity',
    onClose: () => {
      if (unsubscribe) unsubscribe()
      onClose()
    },
  })

  const title = document.createElement('div')
  title.className = 'fl-fmenu-title'
  title.textContent = 'Sub-agents activity'

  const list = document.createElement('div')
  list.className = 'fl-bgactivity-list'

  popover.panel.append(title, list)

  unsubscribe = backgroundActivityStore.subscribe({
    onScreen: () => popover.panel.isConnected,
    render: (snapshot) => renderRows(list, snapshot, popover),
  })

  return { close: () => popover.close() }
}

function renderRows(
  list: HTMLElement,
  snapshot: BackgroundActivitySnapshot,
  popover: AnchoredPopover,
): void {
  list.replaceChildren()

  // Newest-first: the run a reader just watched start is the one they want.
  const rows = [...snapshot.rows].reverse()

  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'fl-fmenu-body'
    empty.textContent = 'Nothing running in the background.'
    list.append(empty)
    popover.reposition()
    return
  }

  for (const row of rows) {
    list.append(buildRow(row, snapshot.threadId, popover))
  }
  popover.reposition()
}

function buildRow(
  row: BackgroundActivityRow,
  threadId: string | null,
  popover: AnchoredPopover,
): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'fl-fmenu-item'

  const head = document.createElement('div')
  head.className = 'fl-fmenu-item-head fl-bgactivity-head'

  const glyph = document.createElement('span')
  glyph.className = 'fl-bgactivity-glyph'
  glyph.setAttribute('aria-hidden', 'true')
  // A gear for a spawned sub-agent, a chevron for a terminal command.
  glyph.textContent = row.kind === 'subagent' ? '⚙' : '❯'

  const label = document.createElement('span')
  label.className = 'fl-fmenu-item-label fl-bgactivity-label'
  label.textContent = row.label

  const status = document.createElement('span')
  status.className = `fl-bgactivity-dot fl-bgactivity-dot--${statusTone(row.status)}`
  status.setAttribute('aria-hidden', 'true')

  head.append(glyph, label, status)
  item.append(head)

  if (row.detail.length > 0 && row.detail !== row.label) {
    const detail = document.createElement('div')
    detail.className = 'fl-fmenu-item-detail fl-bgactivity-detail'
    detail.textContent = row.detail
    item.append(detail)
  }

  item.title = `${row.label}${row.detail.length > 0 ? `\n${row.detail}` : ''}\nStatus: ${row.status}`
  item.addEventListener('click', () => {
    if (threadId === null) return
    if (row.source === 'task') {
      // A LIVE sub-agent — resolve it to its persisted spawn and open the full
      // child-thread chat in the MAIN pane; only an unresolvable/ambiguous task
      // falls back to the right-side live progress (#1931 D-4/D-5). One routing
      // code path, shared with the sidebar's rows (subagent-open.ts).
      if (row.task !== undefined) {
        void openSubagentTask(threadId, row.task, { label: row.label, running: row.running })
      }
    } else {
      // A persisted sub-agent — promote it to a navigable CHILD thread and SWITCH
      // the main pane to it, where the user can read its execution and continue
      // it as its own session (#1931). Supersedes the right-side sub-chat tab.
      document.dispatchEvent(
        new CustomEvent('flow:open-subagent-thread', {
          detail: { parentThreadId: threadId, toolCallId: row.id },
        }),
      )
    }
    popover.close()
  })
  return item
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // Existing tokens only, over the shared `fl-fmenu` shell — no new design
  // language. The list is a plain column; the row is the menu's own item.
  style.textContent = [
    '.fl-bgactivity-list { display: flex; flex-direction: column; gap: var(--fl-space-xs); min-width: 0; }',
    '.fl-bgactivity-head { width: 100%; align-items: center; }',
    '.fl-bgactivity-glyph { flex: none; opacity: .7; font-family: var(--fl-font-mono); }',
    /* The name is the point of the row, so it takes the width and shortens. */
    '.fl-bgactivity-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.fl-bgactivity-detail { font-family: var(--fl-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.fl-bgactivity-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fl-color-text-secondary); }',
    '.fl-bgactivity-dot--done { background: var(--fl-color-success, #4ec9b0); }',
    '.fl-bgactivity-dot--error { background: var(--fl-color-error, #f14c4c); }',
    '.fl-bgactivity-dot--running { background: var(--fl-color-accent, #4a9eff); animation: fl-bgactivity-pulse 1.2s ease-in-out infinite; }',
    '@keyframes fl-bgactivity-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }',
    '@media (prefers-reduced-motion: reduce) { .fl-bgactivity-dot--running { animation: none; } }',
  ].join('\n')
  document.head.appendChild(style)
}
