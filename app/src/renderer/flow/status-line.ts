/**
 * Flow status line — the blocked / inbox cluster at the BOTTOM-RIGHT of the
 * shell, where the toasts it summarises appear. Pure DOM view: `update()`
 * reflects the aggregate FlowState picked by index.ts, and the inbox button
 * just forwards clicks to the notification center.
 *
 * THREE THINGS LEFT THIS LINE (2026-09-04, on the user's call):
 *
 *  - `flow: <skill> · <phase>` — removed outright.
 *  - the terminal button — removed outright; the terminal is on the activity
 *    bar, ⌃`, and the palette, and this was a fourth door to it.
 *  - `autopilot on|off` — moved into the COMPOSER, where it also became a
 *    control rather than a readout. It was the one always-visible answer to
 *    "will this act without asking me?", and it sat at the far end of the
 *    window from the box you type the instruction into. Next to that box it
 *    needs no #1204 disambiguation either: the thread names its own project,
 *    so the flag can only ever be about that one.
 *
 * What stays is what is genuinely a NOTIFICATION: the blocked flag and the
 * unread count, in the corner the notifications themselves come from.
 */
import '../components'

export interface StatusLineData {
  /** Total unread notifications across all roots. */
  unread: number
  /** True when any root has a pending blocked prompt. */
  blocked: boolean
  /**
   * #1354: the project names of the blocked roots. The red ⚠ was computed
   * across ALL open roots and rendered with no attribution at all — no chip,
   * no tooltip — while the readouts beside it were deliberately made to
   * describe the ACTIVE project (#1204). So a BACKGROUND root's blocked task
   * read as though the project you were in had stopped for you, and the
   * blocked-prompt card has named its project since #1074.
   */
  blockedProjects?: string[]
  /** How many roots are blocked — >1 renders a count so the user knows more
   *  than one project is waiting on an answer (#1074). */
  blockedCount?: number
}

export interface StatusLine {
  update(data: StatusLineData): void
  onInboxToggle(listener: () => void): void
}

export function createStatusLine(statusBar: HTMLElement): StatusLine {
  injectStyles()

  const container = document.createElement('span')
  container.className = 'fl-flow-line'

  const blockedEl = document.createElement('span')
  blockedEl.className = 'fl-flow-line-item fl-flow-line-blocked'
  const blockedIcon = document.createElement('fl-icon')
  blockedIcon.setAttribute('name', 'warning')
  blockedIcon.setAttribute('size', '12')
  const blockedText = document.createElement('span')
  blockedText.textContent = 'blocked'
  blockedEl.appendChild(blockedIcon)
  blockedEl.appendChild(blockedText)
  blockedEl.hidden = true

  const inboxEl = document.createElement('button')
  inboxEl.type = 'button'
  inboxEl.className = 'fl-flow-line-item fl-flow-line-inbox'
  inboxEl.title = 'Flow notifications'
  const inboxIcon = document.createElement('fl-icon')
  inboxIcon.setAttribute('name', 'message')
  inboxIcon.setAttribute('size', '12')
  const unreadEl = document.createElement('span')
  unreadEl.className = 'fl-flow-line-unread'
  unreadEl.hidden = true
  inboxEl.appendChild(inboxIcon)
  inboxEl.appendChild(unreadEl)

  container.appendChild(blockedEl)
  container.appendChild(inboxEl)
  statusBar.appendChild(container)

  const inboxListeners: Array<() => void> = []
  inboxEl.addEventListener('click', () => {
    for (const listener of inboxListeners) listener()
  })

  return {
    update(data) {
      blockedEl.hidden = !data.blocked
      const blockedCount = data.blockedCount ?? (data.blocked ? 1 : 0)
      // #1354: say WHOSE. Unlabelled when it's the project you're in (the
      // #1204 rule the rest of this line already follows); named when it
      // isn't, so a background block never reads as yours.
      const blockedProjects = data.blockedProjects ?? []
      const elsewhere = blockedProjects.length > 0
      blockedText.textContent =
        blockedCount > 1
          ? `blocked ×${blockedCount}`
          : elsewhere
            ? `${blockedProjects[0] ?? ''} blocked`
            : 'blocked'
      blockedEl.title =
        blockedProjects.length === 0
          ? 'A task is waiting for your answer'
          : blockedProjects.length === 1
            ? `${blockedProjects[0] ?? ''} is waiting for your answer`
            : `Waiting for your answer: ${blockedProjects.join(', ')}`
      unreadEl.textContent = String(data.unread)
      unreadEl.hidden = data.unread === 0
    },
    onInboxToggle(listener) {
      inboxListeners.push(listener)
    },
  }
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-flow-line {
      /* Bottom-RIGHT: this is the notification corner, and the toasts stack
         directly above it. */
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-md);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      user-select: none;
    }
    .fl-flow-line-item {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      white-space: nowrap;
    }
    .fl-flow-line-blocked { color: var(--fl-color-error); }
    .fl-flow-line-inbox {
      margin: 0;
      padding: 0 var(--fl-space-xs);
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .fl-flow-line-inbox:hover { color: var(--fl-color-text); }
    .fl-flow-line-unread {
      min-width: 14px;
      padding: 0 var(--fl-space-xs);
      border-radius: 7px;
      background: var(--fl-color-accent-muted);
      color: var(--fl-color-accent);
      text-align: center;
      line-height: 14px;
    }
  `
  document.head.appendChild(style)
}
