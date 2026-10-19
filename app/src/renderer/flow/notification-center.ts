/**
 * Flow notification center — a fixed toast stack (bottom-right) plus a
 * bounded inbox panel. Regular notifications auto-dismiss; blocked-prompt
 * toasts are sticky and carry an inline markdown-rendered prompt with a
 * reply box wired to `flow:respondPrompt` (one live prompt card per root —
 * a newer prompt for the same root replaces the older card).
 */
import { notificationActionEvents } from './notification-action'
import '../components'
import { shouldPinToNewest } from './toast-pin'
import type { FlowNotification, FlowNotificationLevel } from '../../shared/ipc-contract'
import { isStickyPrompt, shouldElevateToasts } from './notification-dedupe'
import { promptSummary } from './prompt-summary'
import { readInbox, writeInbox, type InboxStorage, type PersistedInbox } from './inbox-store'

const TOAST_AUTO_DISMISS_MS = 6_000
const INBOX_MAX_ENTRIES = 200

/** fl-card tone per notification level. */
const LEVEL_TONES: Record<FlowNotificationLevel, string> = {
  info: 'accent',
  warn: 'warning',
  error: 'error',
}

/** How a prompt's card went away (#1165). */
export interface DismissPromptOptions {
  /** The question that was open, so the announcement can name it. */
  task?: string
  /** False when the ROOT went away rather than the question being answered —
   *  nothing to announce, and no stale record to correct. Defaults to true. */
  announce?: boolean
}

export interface NotificationCenter {
  notify(notification: FlowNotification): void
  toggleInbox(): void
  /** Remove the live blocked-prompt card for a root (prompt answered/gone). */
  /** The live prompt for a root is gone (#1165). */
  dismissPrompt(rootId: string, options?: DismissPromptOptions): void
  onUnreadChanged(listener: (unread: number) => void): void
}

export type RespondPrompt = (
  rootId: string,
  promptId: string,
  response: string,
) => Promise<void>

export function createNotificationCenter(
  respondPrompt: RespondPrompt,
  storage: InboxStorage = window.localStorage,
): NotificationCenter {
  injectStyles()

  const toastStack = document.createElement('div')
  toastStack.className = 'fl-flow-toasts'
  document.body.appendChild(toastStack)

  const inbox = document.createElement('div')
  inbox.className = 'fl-flow-inbox'
  inbox.hidden = true
  const inboxHeader = document.createElement('div')
  inboxHeader.className = 'fl-flow-inbox-header'
  const inboxHeaderTitle = document.createElement('span')
  inboxHeaderTitle.textContent = 'Notifications'
  inboxHeader.appendChild(inboxHeaderTitle)
  // Visible dismiss affordance (#1114) — every sibling overlay (palette,
  // settings, onboarding) can be closed in place; the inbox's only exit was
  // the 12px status-bar icon that opened it.
  const inboxClose = document.createElement('fl-button')
  inboxClose.setAttribute('variant', 'ghost')
  inboxClose.setAttribute('small', '')
  inboxClose.setAttribute('aria-label', 'Close notifications')
  const inboxCloseIcon = document.createElement('fl-icon')
  inboxCloseIcon.setAttribute('name', 'close')
  inboxCloseIcon.setAttribute('size', '12')
  inboxClose.appendChild(inboxCloseIcon)
  inboxClose.addEventListener('click', () => closeInbox())
  inboxHeader.appendChild(inboxClose)
  const inboxList = document.createElement('div')
  inboxList.className = 'fl-flow-inbox-list'
  inbox.appendChild(inboxHeader)
  inbox.appendChild(inboxList)
  document.body.appendChild(inbox)

  function closeInbox(): void {
    inbox.hidden = true
  }

  // Escape dismisses the open inbox (#1114) — same contract as the command
  // palette and both settings overlays. Guarded on visibility so it never
  // steals Escape from Monaco/xterm/dialogs while the panel is closed.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !inbox.hidden) closeInbox()
  })
  // Click-outside dismisses too (#1114) — matching popover behaviour elsewhere.
  // The status-line inbox button is excluded: its own click handler is the
  // toggle, and handling its pointerdown here would close-then-reopen.
  document.addEventListener('pointerdown', (event) => {
    if (inbox.hidden) return
    const path = event.composedPath()
    if (path.includes(inbox)) return
    const toggleButton = document.querySelector('.fl-flow-line-inbox')
    if (toggleButton && path.includes(toggleButton)) return
    closeInbox()
  })

  /** Live blocked-prompt card per root — newer prompts replace older cards. */
  const promptCards = new Map<string, HTMLElement>()
  /** #1403: `${rootId}\0${promptId}` for prompts THIS window answered, recorded
   *  before the reply is sent so either dismissal path recognises it. */
  const answeredLocally = new Set<string>()
  /** Live PERSISTENT actionable toasts (#769) — like promptCards, these carry a
   *  click affordance and keep the stack elevated above the open inbox. */
  const actionToasts = new Set<HTMLElement>()

  /**
   * Keep the toast stack above the inbox WHILE a sticky prompt is live (#459) — the
   * two share a fixed region and the inbox is normally on top, which would occlude
   * the prompt's reply box (the only in-app way to answer a blocked task). Call after
   * every promptCards mutation.
   */
  function syncToastElevation(): void {
    toastStack.classList.toggle(
      'fl-flow-toasts--sticky',
      shouldElevateToasts(promptCards.size, actionToasts.size),
    )
  }
  const unreadListeners: Array<(unread: number) => void> = []
  let unread = 0
  let inboxEmpty = true

  /**
   * The durable copy of what the inbox is showing (#1459), oldest-first and
   * bounded exactly like the live list. `webContents.reload()` — stock View ▸
   * Reload — tears the DOM down and rebuilds it, and this is what puts the
   * record back. Written by `persist()` only, so there is one writer.
   */
  const persisted: PersistedInbox = { entries: [], unread: 0 }

  function persist(): void {
    persisted.unread = unread
    writeInbox(storage, persisted, INBOX_MAX_ENTRIES)
  }

  function setUnread(count: number): void {
    if (count === unread) return
    unread = count
    for (const listener of unreadListeners) listener(unread)
  }

  /**
   * `replay` marks the boot rehydration: the record is being re-rendered, not
   * added to, so it must not be appended to itself.
   */
  function addToInbox(notification: FlowNotification, replay = false): void {
    if (!replay) {
      persisted.entries.push(notification)
      if (persisted.entries.length > INBOX_MAX_ENTRIES) {
        persisted.entries.splice(0, persisted.entries.length - INBOX_MAX_ENTRIES)
      }
    }
    if (inboxEmpty) {
      inboxList.textContent = ''
      inboxEmpty = false
    }
    const entry = document.createElement('div')
    entry.className = 'fl-flow-inbox-entry'
    if (notification.rootId) entry.dataset.rootId = notification.rootId
    const dot = document.createElement('span')
    dot.className = `fl-flow-level-dot fl-flow-level-${notification.level}`
    const text = document.createElement('div')
    text.className = 'fl-flow-inbox-text'
    const title = document.createElement('div')
    title.className = 'fl-flow-title'
    title.textContent = notification.title
    // Name the project the entry belongs to. #1074 did this for blocked
    // prompts; #1170 widened it to every root-stamped entry, because a
    // notification can be raised for a project the user is NOT in — the
    // discovery ask fires per root on its own provisioning-ready transition,
    // and addRoot deliberately does not steal the active project (#382). The
    // module count in "Learning 3 module(s)" was the only thing on screen that
    // betrayed which project had been learned.
    if (notification.rootId) {
      text.appendChild(buildProjectChip(notification.rootId, notification.label))
    }
    const fullBody = notification.body
    // #1404: the SUMMARY skips the template's shared title. Every
    // blocked-prompt entry's line was the identical constant
    // `# Heartbeat Prompt`, so a list of them said nothing about any of them.
    const summary = promptSummary(fullBody)
    const body = document.createElement('div')
    body.className = 'fl-flow-caption'
    body.textContent = summary
    // Keep the WHOLE body (#1075): the toast holding the full failure reason
    // auto-dismisses in 6s — the inbox is the durable record, so a multi-line
    // body is retained and the entry expands on click to reveal it.
    if (fullBody.includes('\n')) {
      entry.dataset.body = fullBody
      body.title = fullBody
      entry.classList.add('fl-flow-inbox-entry--expandable')
      let expanded = false
      const setExpanded = (next: boolean): void => {
        expanded = next
        if (expanded) {
          // #1404: RENDER it, like the toast beside it already does. Expanded
          // entries showed `##`, `**`, list markers and fences verbatim.
          // renderMarkdownLite is escape-first, so prompt content still cannot
          // inject HTML.
          body.innerHTML = renderMarkdownLite(fullBody)
        } else {
          body.textContent = summary
        }
        body.classList.toggle('fl-flow-inbox-body-full', expanded)
      }
      // #1317: the toggle was bound to a click on the WHOLE entry, so the drag
      // a user makes to SELECT AND COPY the body fired it — the entry
      // collapsed, the retained text left the DOM, and the selection was
      // wiped. The text the inbox exists to preserve could not be copied out
      // of the one surface that keeps it.
      //
      // A click that ENDS a selection is not a toggle. Everything else still
      // toggles anywhere on the entry, so the affordance is unchanged for the
      // gesture it was built for.
      entry.addEventListener('click', () => {
        const selection = window.getSelection()
        const selectingInsideEntry =
          selection !== null &&
          !selection.isCollapsed &&
          selection.anchorNode !== null &&
          entry.contains(selection.anchorNode)
        if (selectingInsideEntry) return
        setExpanded(!expanded)
      })
    }
    const time = document.createElement('div')
    time.className = 'fl-flow-caption'
    time.textContent = formatTime(notification.timestamp)
    text.appendChild(title)
    if (body.textContent) text.appendChild(body)
    text.appendChild(time)
    entry.appendChild(dot)
    entry.appendChild(text)
    inboxList.prepend(entry)
    while (inboxList.childElementCount > INBOX_MAX_ENTRIES) {
      inboxList.lastElementChild?.remove()
    }
  }

  function showToast(notification: FlowNotification): void {
    const level = notification.level
    const card = document.createElement('fl-card')
    card.setAttribute('tone', LEVEL_TONES[level])
    card.setAttribute('dense', '')
    card.className = 'fl-flow-toast'
    const sticky = isStickyPrompt(notification)
    const head = document.createElement('div')
    head.className = 'fl-flow-toast-head'
    const title = document.createElement('span')
    title.className = 'fl-flow-title'
    title.textContent = notification.title
    head.appendChild(title)
    // Same on the toast (#1074 for sticky reply cards, #1170 for the rest): an
    // action that costs a real agent run must say which project it will run
    // over, whether or not it is the one in the titlebar.
    if (notification.rootId) {
      card.dataset.rootId = notification.rootId
      head.appendChild(buildProjectChip(notification.rootId, notification.label))
    }
    // A sticky blocked-prompt card carries the ONLY reply affordance and is
    // removed on Send reply / when the prompt resolves — a generic dismiss (X)
    // would permanently strand the still-blocked task, unanswerable in-app (#423).
    if (!sticky) {
      const close = document.createElement('fl-button')
      close.setAttribute('variant', 'ghost')
      close.setAttribute('small', '')
      close.setAttribute('aria-label', 'Dismiss')
      const closeIcon = document.createElement('fl-icon')
      closeIcon.setAttribute('name', 'close')
      closeIcon.setAttribute('size', '12')
      close.appendChild(closeIcon)
      close.addEventListener('click', () => removeToast(card))
      head.appendChild(close)
    }
    card.appendChild(head)

    if (notification.kind === 'blocked-prompt' && notification.promptId) {
      // Sticky prompt card — never auto-dismissed, replaced per root.
      // #1403: the card carries WHICH prompt it is, so a dismissal can tell
      // "this window answered it" from "something else did".
      card.dataset['promptId'] = notification.promptId
      card.appendChild(
        buildPromptBody(notification.rootId, notification.promptId, notification.body),
      )
      // A swapped-in prompt replaces the live card — carry the draft the user
      // was typing into the replacement so it is never destroyed without a
      // trace (#1004). The question changed, so flag it for review.
      const previous = promptCards.get(notification.rootId)
      const draft = previous?.querySelector<HTMLTextAreaElement>('.fl-flow-reply')?.value ?? ''
      if (draft.trim()) {
        const reply = card.querySelector<HTMLTextAreaElement>('.fl-flow-reply')
        const status = card.querySelector<HTMLElement>('.fl-flow-prompt-actions .fl-flow-caption')
        if (reply && !reply.value) reply.value = draft
        if (status) status.textContent = 'The question changed — review your draft before sending'
      }
      previous?.remove()
      promptCards.set(notification.rootId, card)
      syncToastElevation()
    } else {
      if (notification.body) {
        const body = document.createElement('div')
        body.className = 'fl-flow-caption fl-flow-toast-body'
        body.textContent = notification.body
        card.appendChild(body)
      }
      const time = document.createElement('div')
      time.className = 'fl-flow-caption'
      time.textContent = formatTime(notification.timestamp)
      card.appendChild(time)
      // An actionable notification (e.g. "Basic discovery started · Open blueprint",
      // #582) renders its action button and is PERSISTENT — like the prompt card, a
      // 6s auto-dismiss would rob the user of the action before they can click it.
      const action = notification.action
      if (action) {
        const actions = document.createElement('div')
        actions.className = 'fl-flow-prompt-actions'
        const btn = document.createElement('fl-button')
        btn.setAttribute('variant', 'primary')
        btn.setAttribute('small', '')
        btn.textContent = action.label
        btn.addEventListener('click', () => {
          // The action's detail (a Workspace's slug) rides on its event, so the
          // button opens what the notification is about.
          for (const spec of notificationActionEvents(action)) {
            document.dispatchEvent(
              spec.detail === undefined ? new CustomEvent(spec.type) : new CustomEvent(spec.type, { detail: spec.detail }),
            )
          }
          removeToast(card)
        })
        actions.appendChild(btn)
        card.appendChild(actions)
        // Persistent + click-required: elevate above the open inbox (#769),
        // the same reachability guarantee sticky prompt cards get (#463).
        actionToasts.add(card)
        syncToastElevation()
      } else {
        window.setTimeout(() => removeToast(card), TOAST_AUTO_DISMISS_MS)
      }
    }
    // Measured BEFORE the append — afterwards scrollHeight already counts the
    // new card, and every stack would look "scrolled away from the bottom".
    const pin = shouldPinToNewest({
      scrollHeight: toastStack.scrollHeight,
      scrollTop: toastStack.scrollTop,
      clientHeight: toastStack.clientHeight,
      holdsFocus:
        document.activeElement !== null && toastStack.contains(document.activeElement),
    })
    toastStack.appendChild(card)
    // Cards never shrink (#1036) — the stack scrolls instead. Pin it to the
    // newest card so the arrival is the one in view — unless that would take
    // something away from the user (#1458): the reply box they are typing in,
    // or a scroll position they chose themselves.
    if (pin) toastStack.scrollTop = toastStack.scrollHeight
  }

  function removeToast(card: HTMLElement): void {
    for (const [rootId, promptCard] of promptCards) {
      if (promptCard === card) promptCards.delete(rootId)
    }
    actionToasts.delete(card)
    card.remove()
    syncToastElevation()
  }

  function buildPromptBody(rootId: string, promptId: string, markdown: string): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-flow-prompt'
    const rendered = document.createElement('div')
    rendered.className = 'fl-flow-md'
    rendered.innerHTML = renderMarkdownLite(markdown)
    wrap.appendChild(rendered)
    const reply = document.createElement('textarea')
    reply.className = 'fl-flow-reply'
    reply.rows = 3
    reply.placeholder = 'Reply to the blocked task…'
    // ⌘/Ctrl+Enter submits (#1036) — the reply is never gated on one button's
    // pixels if layout ever clips the actions row again.
    reply.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        send.click()
      }
    })
    wrap.appendChild(reply)
    const actions = document.createElement('div')
    actions.className = 'fl-flow-prompt-actions'
    const status = document.createElement('span')
    status.className = 'fl-flow-caption'
    const send = document.createElement('fl-button')
    send.setAttribute('variant', 'primary')
    send.setAttribute('small', '')
    send.textContent = 'Send reply'
    send.addEventListener('click', () => {
      const response = reply.value.trim()
      if (!response) {
        status.textContent = 'Enter a reply first'
        return
      }
      send.setAttribute('disabled', '')
      status.textContent = 'Sending…'
      // #1403: MARK IT ANSWERED BEFORE AWAITING.
      //
      // #1316's fix put `announce: false` on the dismissPrompt in the .then()
      // below, on my stated premise that the FlowState arriving afterwards
      // "still reaches that branch ... finding no card". That premise was
      // false, and I asserted it without tracing the order.
      //
      // FlowObserver.respondPrompt unlinks the prompt file and calls
      // refresh() BEFORE the invoke resolves, so `flow:stateChanged` →
      // applyState → dismissPrompt lands FIRST, while the card is still there
      // — announcing "someone else answered this, your reply was never sent"
      // about the reply we were in the middle of sending. My suppression then
      // applied to the later, no-op call.
      //
      // Recording it here, before the await, is order-independent: whichever
      // dismissal arrives first knows this window answered.
      answeredLocally.add(`${rootId}\u0000${promptId}`)
      respondPrompt(rootId, promptId, response)
        .then(() => {
          // #1316: WE answered — say nothing about anyone else. This called
          // dismissPrompt without options, so the "Question answered
          // elsewhere" branch fired on the normal, only in-app way to unblock
          // a run: a red card claiming somebody else answered and the user's
          // reply was never sent, landing directly above the blue "Reply sent"
          // card saying the opposite. Both persist in the inbox, so the
          // durable record contradicted itself about who answered.
          //
          // The FlowState that follows (prompt file unlinked) reaches
          // dismissPrompt too, and finds no card — so the elsewhere branch
          // stays correct for the case it exists for.
          dismissPrompt(rootId, { announce: false })
          notifyInternal({
            kind: 'state-change',
            rootId,
            title: 'Reply sent',
            body: `Prompt archived — ${projectName(rootId)} will resume the task.`,
            timestamp: new Date().toISOString(),
            level: 'info',
          })
        })
        .catch((error: unknown) => {
          send.removeAttribute('disabled')
          status.textContent = `Failed to send: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
    })
    actions.appendChild(send)
    actions.appendChild(status)
    wrap.appendChild(actions)
    return wrap
  }

  function notifyInternal(notification: FlowNotification): void {
    addToInbox(notification)
    showToast(notification)
    // Count a notification the user cannot currently see (#1113): the panel
    // being open only shows the TOP of the list — an entry prepended while the
    // user has scrolled down lands above their viewport, the toast is occluded
    // by the panel, and the old `if (inbox.hidden)` guard suppressed the badge
    // too, leaving the arrival announced nowhere. A user who never saw it has
    // not read it. Opening the inbox still clears the counter (#376).
    if (inbox.hidden || inboxList.scrollTop > 0) setUnread(unread + 1)
    // One write per notification, after the counter settles (#1459).
    persist()
  }

  /**
   * The live prompt for `rootId` is gone. `task` names it when the caller knows
   * which question was resolved.
   *
   * #1165: a prompt can be resolved OUT OF BAND — the daemon consuming it, a
   * Telegram reply, a CLI session archiving .heartbeat-prompt.md. This used to
   * be a bare `card.remove()`: the answer the user was mid-way through typing
   * was destroyed with no toast, no confirmation, no copy anywhere in the DOM;
   * nothing recorded that the question was resolved, so the inbox's last word
   * on the task stayed "Task blocked: …", which was now false; and the red
   * `blocked` indicator just quietly vanished.
   *
   * #1004 already set the floor for the sibling path — a swapped-in prompt
   * carries the draft into its replacement so it "is never destroyed without a
   * trace". Resolution now gets the same treatment: the resolution is
   * announced (toast + inbox, so the record is corrected), and any unsent draft
   * is carried into that announcement, where it stays readable and copyable.
   */
  function dismissPrompt(rootId: string, options?: DismissPromptOptions): void {
    const card = promptCards.get(rootId)
    if (!card) return
    // #1403: did THIS window answer it? Keyed by (root, prompt) so a later,
    // genuinely external answer to a DIFFERENT prompt still announces.
    const promptId = card.dataset['promptId'] ?? ''
    const localKey = `${rootId}\u0000${promptId}`
    const answeredHere = answeredLocally.delete(localKey)
    const draft = card.querySelector<HTMLTextAreaElement>('.fl-flow-reply')?.value.trim() ?? ''
    promptCards.delete(rootId)
    card.remove()
    syncToastElevation()

    // The root itself went away (removed / unmounted): nobody answered
    // anything, so there is nothing to announce or correct.
    if (options?.announce === false) return
    // #1403: we answered it. Saying somebody else did — and that the reply was
    // never sent — contradicts the "Reply sent" card landing beside it.
    if (answeredHere) return

    const task = options?.task
    const named = task && task.length > 0 ? `: ${task}` : ''
    notifyInternal({
      kind: 'state-change',
      rootId,
      title: `Question answered elsewhere${named}`,
      body: draft
        ? `Someone or something else answered this one. Your unsent reply is kept here so nothing you wrote is lost:\n\n${draft}`
        : 'Someone or something else answered this one, so the reply card closed.',
      timestamp: new Date().toISOString(),
      // An unsent draft is worth an error-level, non-auto-dismissing card; a
      // bare resolution is just information.
      level: draft ? 'error' : 'info',
    })
  }

  const empty = document.createElement('div')
  empty.className = 'fl-flow-caption fl-flow-inbox-empty'
  empty.textContent = 'No notifications yet'
  inboxList.appendChild(empty)

  // Put the record back (#1459). AFTER the empty state is mounted, because the
  // first `addToInbox` clears the list to drop it — rehydrating earlier would
  // leave "No notifications yet" appended below the restored entries.
  //
  // Only the inbox is replayed: no toasts, no unread bumps. A reload must not
  // re-announce what the user already saw, and the live blocked-prompt card is
  // rebuilt from FlowState by whoever owns it, not from this log.
  const restored = readInbox(storage, INBOX_MAX_ENTRIES)
  for (const entry of restored.entries) {
    persisted.entries.push(entry)
    addToInbox(entry, true)
  }
  unread = restored.unread

  return {
    notify: notifyInternal,
    toggleInbox() {
      // Opening the inbox clears the in-session unread counter. It intentionally
      // does NOT mark the heartbeat backlog read — the badge no longer counts the
      // backlog, and marking unshown events read was the silent-loss bug (#376).
      inbox.hidden = !inbox.hidden
      if (!inbox.hidden) {
        setUnread(0)
        // Clearing the badge is durable too (#1459) — a reload must not
        // resurrect a count the user already read away.
        persist()
      }
    },
    dismissPrompt,
    onUnreadChanged(listener) {
      unreadListeners.push(listener)
      // A count restored from the persisted log (#1459) changed before any
      // listener existed, so `setUnread`'s change events could never carry it.
      // Delivered on a microtask rather than inline: the caller registers from
      // inside its own initialisation, where the state `renderStatus` reads is
      // not all bound yet, so a synchronous callback would run too early.
      if (unread !== 0) queueMicrotask(() => listener(unread))
    },
  }
}

/** Human project name for a rootId (absolute root path) — its basename. */
function projectName(rootId: string): string {
  const parts = rootId.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? rootId
}

/** Small project chip naming the root a card/entry belongs to (#1074). */
function buildProjectChip(rootId: string, label?: string): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'fl-flow-project-chip'
  chip.textContent = label ?? projectName(rootId)
  chip.title = label ?? rootId
  return chip
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

/**
 * Minimal, escape-first markdown renderer for prompt bodies: headings,
 * **bold**, and fenced code blocks only. Everything is HTML-escaped BEFORE
 * any markup is generated, so prompt content can never inject HTML.
 */
function renderMarkdownLite(markdown: string): string {
  const html: string[] = []
  let inCode = false
  let codeLines: string[] = []
  const flushCode = (): void => {
    html.push(`<pre class="fl-flow-code">${escapeHtml(codeLines.join('\n'))}</pre>`)
    codeLines = []
  }
  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        flushCode()
      }
      inCode = !inCode
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }
    const trimmed = escapeHtml(line.trim())
    if (!trimmed) continue
    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/)
    const bolded = (heading ? heading[2] : trimmed).replace(
      /\*\*(.+?)\*\*/g,
      '<strong>$1</strong>',
    )
    html.push(heading ? `<div class="fl-flow-md-h">${bolded}</div>` : `<div>${bolded}</div>`)
  }
  if (inCode) {
    flushCode()
  }
  return html.join('')
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-flow-toasts {
      position: fixed;
      right: var(--fl-space-md);
      bottom: 32px;
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      width: 340px;
      max-height: calc(100vh - 64px);
      overflow-y: auto;
      z-index: 1000;
    }
    /* While a sticky blocked-prompt is live, lift the toast stack above the inbox
     * (1001) so its reply box is never occluded by an open inbox (#459). */
    .fl-flow-toasts--sticky {
      z-index: 1002;
    }
    /* Cards must never flex-shrink below their content (#1036): compression
     * clipped every card's actions row — including Send reply, the only in-app
     * way to answer a blocked task — away at once. The stack scrolls instead. */
    .fl-flow-toast { flex: none; }
    .fl-flow-toast-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--fl-space-sm);
    }
    .fl-flow-title {
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-flow-caption {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-flow-toast-body { margin-top: var(--fl-space-xs); white-space: pre-line; }
    .fl-flow-prompt {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      margin-top: var(--fl-space-sm);
    }
    .fl-flow-md {
      max-height: 200px;
      overflow-y: auto;
      padding: var(--fl-space-sm);
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text);
    }
    .fl-flow-md-h {
      font-weight: var(--fl-text-ui-weight-medium);
      margin-top: var(--fl-space-xs);
    }
    .fl-flow-code {
      margin: var(--fl-space-xs) 0;
      padding: var(--fl-space-sm);
      background: var(--fl-color-bg);
      border-radius: var(--fl-radius-sm);
      overflow-x: auto;
      white-space: pre;
    }
    .fl-flow-reply {
      resize: vertical;
      padding: var(--fl-space-sm);
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-flow-reply:focus { outline: 1px solid var(--fl-color-focus-ring); }
    .fl-flow-prompt-actions {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
    }
    .fl-flow-inbox {
      position: fixed;
      right: var(--fl-space-md);
      bottom: 32px;
      width: 340px;
      max-height: 50vh;
      display: flex;
      flex-direction: column;
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      z-index: 1001;
    }
    /* The class rule above sets display:flex, which ties with the UA
       [hidden]{display:none} on specificity and wins by order — so the
       inbox would never hide. This higher-specificity rule restores it. */
    .fl-flow-inbox[hidden] { display: none; }
    .fl-flow-inbox-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) var(--fl-space-md);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      font-weight: var(--fl-text-ui-weight-medium);
      font-size: var(--fl-text-ui-size);
    }
    .fl-flow-project-chip {
      flex: none;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 var(--fl-space-xs);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-accent-muted);
      color: var(--fl-color-accent);
      font-size: var(--fl-text-caption-size);
    }
    .fl-flow-inbox-entry--expandable { cursor: pointer; }
    .fl-flow-inbox-body-full { white-space: pre-line; }
    .fl-flow-inbox-list { overflow-y: auto; }
    .fl-flow-inbox-entry {
      display: flex;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) var(--fl-space-md);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-flow-inbox-entry:last-child { border-bottom: none; }
    .fl-flow-inbox-empty { padding: var(--fl-space-md); }
    .fl-flow-inbox-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .fl-flow-level-dot {
      flex: none;
      width: 8px;
      height: 8px;
      margin-top: 5px;
      border-radius: 50%;
    }
    .fl-flow-level-info { background: var(--fl-color-accent); }
    .fl-flow-level-warn { background: var(--fl-color-warning); }
    .fl-flow-level-error { background: var(--fl-color-error); }
  `
  document.head.appendChild(style)
}
