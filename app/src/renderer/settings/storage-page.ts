/**
 * THE ONE DOOR — the page behind the Flow settings row, and the only surface
 * left that can see what a project is holding on disk.
 *
 * A SECTION, NOT A MODAL, and the difference matters. The ledger this replaces
 * was a dialog: it opened over whatever you were doing, it trapped the
 * keyboard, and closing it was the only way back. Nothing about a list of files
 * is urgent, nothing about it interrupts, and a person reading it is usually
 * deciding whether to bother at all — so it lives inside settings, where a
 * person goes when they have decided to look at something, and it is left by
 * walking back rather than by dismissing.
 *
 * IT RENDERS AND NOTHING ELSE. Every state, every sentence, every refusal and
 * every count comes from `storage-page-model.ts`, where the app's node-env jest
 * can read them without a DOM. What is left here is elements, listeners and two
 * IPC calls — the read, and the one release path that already existed
 * (allowed-pattern #14). No new channel, and nothing in `shared/` or `main/`
 * changed to make this page possible.
 *
 * THERE IS NO FORCE. A row holding work that exists nowhere else has its action
 * off with the reason printed beside it, and there is no second click, no
 * modifier and no "I understand" that gets past it (forbidden-pattern #15).
 * `confirmed: true` below is written at the press and nowhere else; nothing
 * here ever writes `allowUnlanded`, which is what makes the header's promise a
 * promise rather than a default.
 */

import type { ThreadWorktreeInventory } from '../../shared/ipc-contract'
import type { RunKeptData, RunKeptDataItem } from '../../shared/run-setup'
import { markModalOverlay } from '../modal-overlay'
import { KEPT_DATA_STRINGS, keptConfirm, keptKey, keptSection } from './kept-data-model'
import {
  FREE_FAILED,
  STORAGE_PAGE_TITLE,
  STORAGE_UNREADABLE,
  bulkFreeControl,
  freeSummary,
  landedRows,
  storageHeader,
  storageRows,
  type StorageRowView,
} from './storage-page-model'

/** What the page needs from whatever is hosting it. */
export interface StoragePageCallbacks {
  /** Walk back out of the page. The host owns what "back" means. */
  onBack: () => void
}

/**
 * The page, as a long-lived object.
 *
 * IT OUTLIVES ITS HOST'S RE-RENDERS ON PURPOSE. The settings panel rebuilds its
 * body whenever the project's config changes on disk, and a page that was
 * rebuilt with it would re-read the inventory — a directory walk and a git
 * call per row — every time an unrelated setting was written. The host keeps
 * this instance and re-attaches `element`; the page reloads only when it is
 * opened or when it has just changed something (allowed-pattern #17).
 */
export class StoragePage {
  readonly #root: HTMLDivElement
  readonly #rootPath: string
  readonly #callbacks: StoragePageCallbacks
  /** Guards against a slow read painting over a newer one. */
  #seq = 0
  /** True while a release is in flight — every control is off until it ends. */
  #busy = false
  /** What the last press did, in words. Null until something has been pressed. */
  #status: string | null = null
  /** The kept-data section lives in its own element, so a repaint of the files above never loses it. */
  readonly #keptEl: HTMLDivElement
  #kept: RunKeptData | null = null
  #keptSeq = 0
  #keptBusy = false
  #keptStatus: string | null = null
  #keptConfirm: { close: () => void } | null = null

  constructor(rootPath: string, callbacks: StoragePageCallbacks) {
    injectStorageStyles()
    this.#rootPath = rootPath
    this.#callbacks = callbacks
    this.#root = document.createElement('div')
    this.#root.className = 'fl-storage'
    this.#keptEl = document.createElement('div')
    this.#keptEl.className = 'fl-storage-kept'
    // THE CHROME IS UP BEFORE THE READ FINISHES. Listing what a project holds
    // walks directories and asks git about every row, which is fast but not
    // instant — and a door that opens onto nothing for half a second reads as a
    // broken button rather than as a page loading. The way back works from the
    // first frame, which is the control somebody pressing by accident wants.
    this.#root.append(this.#backControl(), this.#heading())
  }

  /** The node to attach. Stable for the life of the page. */
  get element(): HTMLElement {
    return this.#root
  }

  /** Read the inventory and paint. Safe to call again at any time. */
  async load(): Promise<void> {
    void this.#loadKept()
    const seq = ++this.#seq
    const threads = window.flow?.threads
    if (threads === undefined || typeof threads.worktreeInventory !== 'function') {
      this.#paintUnavailable()
      return
    }
    try {
      const inventory = await threads.worktreeInventory({ rootPath: this.#rootPath })
      if (seq !== this.#seq) return
      this.#paint(inventory)
    } catch (error) {
      console.warn('flow: could not read what this project is holding on disk', error)
      if (seq === this.#seq) this.#paintUnavailable()
    }
  }

  // ── Painting ─────────────────────────────────────────────────────────────

  #paintUnavailable(): void {
    this.#root.textContent = ''
    this.#root.append(this.#backControl(), this.#heading())
    const line = document.createElement('div')
    line.className = 'fl-storage-note'
    line.textContent = STORAGE_UNREADABLE
    this.#root.appendChild(line)
    this.#root.appendChild(this.#keptEl)
  }

  #paint(inventory: ThreadWorktreeInventory): void {
    const rows = storageRows(inventory)
    const header = storageHeader(inventory)
    const control = bulkFreeControl(rows)

    this.#root.textContent = ''
    this.#root.append(this.#backControl(), this.#heading())

    const head = document.createElement('div')
    head.className = 'fl-storage-head'
    const count = document.createElement('div')
    count.className = 'fl-storage-count'
    count.textContent = header.line
    head.appendChild(count)

    const bulk = document.createElement('button')
    bulk.type = 'button'
    bulk.className = 'fl-settings-btn'
    bulk.textContent = control.text
    bulk.disabled = !control.enabled || this.#busy
    // THE REASON GOES WHERE THE PRESS IS. A disabled control that explains
    // itself somewhere else on the page is a control that explains itself to
    // nobody — the reader is looking at the button.
    if (control.blockedReason !== null) bulk.title = control.blockedReason
    bulk.addEventListener('click', () => {
      if (bulk.disabled) return
      void this.#free(landedRows(rows))
    })
    head.appendChild(bulk)
    this.#root.appendChild(head)

    const note = document.createElement('div')
    note.className = 'fl-storage-note'
    note.textContent = header.note
    this.#root.appendChild(note)

    if (control.blockedReason !== null) {
      const blocked = document.createElement('div')
      blocked.className = 'fl-storage-note'
      blocked.textContent = control.blockedReason
      this.#root.appendChild(blocked)
    }

    if (this.#status !== null) {
      const status = document.createElement('div')
      status.className = 'fl-storage-status'
      status.setAttribute('role', 'status')
      status.textContent = this.#status
      this.#root.appendChild(status)
    }

    if (header.empty !== null) {
      const empty = document.createElement('div')
      empty.className = 'fl-storage-empty'
      empty.textContent = header.empty
      this.#root.appendChild(empty)
      this.#root.appendChild(this.#keptEl)
      return
    }

    const list = document.createElement('div')
    list.className = 'fl-storage-rows'
    for (const row of rows) list.appendChild(this.#row(row))
    this.#root.appendChild(list)
    this.#root.appendChild(this.#keptEl)
  }

  // ── Data kept from deleted threads ───────────────────────────────────────

  /** Read only while this page is open (allowed-pattern #17); a slow read never paints over a newer one. */
  async #loadKept(): Promise<void> {
    const seq = ++this.#keptSeq
    const run = window.flow?.run
    if (run === undefined || typeof run.keptData !== 'function') {
      this.#kept = null
      this.#paintKept()
      return
    }
    try {
      const data = await run.keptData()
      if (seq !== this.#keptSeq) return
      this.#kept = data
    } catch (error) {
      console.warn('flow: could not read the data kept from deleted threads', error)
      if (seq !== this.#keptSeq) return
      this.#kept = null
    }
    this.#paintKept()
  }

  #paintKept(): void {
    const el = this.#keptEl
    el.textContent = ''
    const view = keptSection(this.#kept)
    if (view === null) return
    const head = document.createElement('div')
    head.className = 'fl-storage-head'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = view.heading
    head.appendChild(heading)
    if (view.kind === 'list' && view.total !== null) {
      const total = document.createElement('div')
      total.className = 'fl-storage-count'
      total.textContent = view.total
      head.appendChild(total)
    }
    el.appendChild(head)
    const note = document.createElement('div')
    note.className = 'fl-storage-note'
    note.textContent = view.kind === 'list' ? view.explanation : view.closed
    el.appendChild(note)
    if (view.kind !== 'list') return
    if (this.#keptStatus !== null) {
      const status = document.createElement('div')
      status.className = 'fl-storage-status'
      status.setAttribute('role', 'status')
      status.textContent = this.#keptStatus
      el.appendChild(status)
    }
    const items = new Map((this.#kept?.items ?? []).map((item) => [keptKey(item), item]))
    const list = document.createElement('div')
    list.className = 'fl-storage-rows'
    for (const row of view.rows) {
      const item = items.get(row.key)
      if (item === undefined) continue
      const rowEl = document.createElement('div')
      rowEl.className = 'fl-storage-row'
      const main = document.createElement('div')
      main.className = 'fl-storage-main'
      const title = document.createElement('div')
      title.className = 'fl-storage-title'
      if (item.title === null || item.title.trim() === '') title.classList.add('plain')
      title.textContent = row.title
      const sub = document.createElement('div')
      sub.className = 'fl-storage-facts'
      sub.textContent = row.sub
      main.append(title, sub)
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'fl-settings-btn'
      del.textContent = KEPT_DATA_STRINGS.delete
      del.disabled = this.#keptBusy
      del.addEventListener('click', () => {
        if (!del.disabled) this.#openKeptConfirm(item)
      })
      rowEl.append(main, del)
      list.appendChild(rowEl)
    }
    el.appendChild(list)
  }

  /** The confirm before deleting: what goes, its size, and what is not touched. Cancel has the keyboard. */
  #openKeptConfirm(item: RunKeptDataItem): void {
    this.#keptConfirm?.close()
    const copy = keptConfirm(item)
    const overlay = document.createElement('div')
    overlay.className = 'fl-storage-confirm-overlay'
    markModalOverlay(overlay)
    const box = document.createElement('div')
    box.className = 'fl-storage-confirm'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    const title = document.createElement('div')
    title.className = 'fl-storage-confirm-title'
    title.id = `fl-storage-confirm-${String(Date.now())}`
    title.textContent = copy.title
    box.setAttribute('aria-labelledby', title.id)
    const body = document.createElement('p')
    body.className = 'fl-storage-note'
    body.textContent = copy.body
    const actions = document.createElement('div')
    actions.className = 'fl-storage-confirm-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-settings-btn'
    cancel.textContent = copy.cancel
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'fl-settings-btn fl-storage-danger'
    go.textContent = copy.confirm
    actions.append(cancel, go)
    box.append(title, body, actions)
    overlay.appendChild(box)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const close = (): void => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      if (this.#keptConfirm?.close === close) this.#keptConfirm = null
      previous?.focus?.()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        ;(document.activeElement === go ? cancel : go).focus()
      }
    }
    cancel.addEventListener('click', close)
    go.addEventListener('click', () => {
      close()
      void this.#deleteKept(item)
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    this.#keptConfirm = { close }
    // A destructive confirm focuses its SAFE answer.
    cancel.focus()
  }

  /** `confirmed: true` IS THE PRESS on the confirm's button, written here and nowhere else (forbidden-pattern #15). */
  async #deleteKept(item: RunKeptDataItem): Promise<void> {
    const run = window.flow?.run
    if (this.#keptBusy || run === undefined || typeof run.deleteKeptData !== 'function') return
    this.#keptBusy = true
    this.#keptStatus = null
    this.#paintKept()
    try {
      const answer = await run.deleteKeptData({ threadId: item.threadId, projectRoot: item.projectRoot, confirmed: true })
      if (!answer.ok) this.#keptStatus = answer.detail ?? KEPT_DATA_STRINGS.failed
    } catch (error) {
      console.error('flow: deleting kept data failed', error)
      this.#keptStatus = KEPT_DATA_STRINGS.failed
    } finally {
      this.#keptBusy = false
      await this.#loadKept()
    }
  }

  #heading(): HTMLElement {
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = STORAGE_PAGE_TITLE
    return heading
  }

  /**
   * The way back.
   *
   * A REAL CONTROL, not a sentence telling the reader to press Escape
   * (forbidden-pattern #12). It is first in the DOM so a keyboard reaches it
   * before the list, which is the order somebody who arrived here by accident
   * wants.
   */
  #backControl(): HTMLElement {
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'fl-storage-back'
    back.textContent = '‹ Flow settings'
    back.addEventListener('click', () => this.#callbacks.onBack())
    return back
  }

  #row(row: StorageRowView): HTMLElement {
    const el = document.createElement('div')
    el.className = 'fl-storage-row'

    // THE MARK IS A RULE, NEVER A BADGE AND NEVER A WORD. It holds its width
    // whatever the state, so a list of fifteen rows has one left edge rather
    // than fifteen slightly different ones.
    const mark = document.createElement('span')
    mark.className = 'fl-storage-mark'
    mark.dataset.tone = row.tone
    mark.setAttribute('aria-hidden', 'true')
    el.appendChild(mark)

    const main = document.createElement('div')
    main.className = 'fl-storage-main'

    const title = document.createElement('div')
    title.className = 'fl-storage-title'
    // A ROW WITH NO CONVERSATION READS AS PLAIN TEXT, because it is not a name
    // — quoting it or emphasising it would present a sentence as a title.
    if (!row.hasConversation) title.classList.add('plain')
    title.textContent = row.title
    main.appendChild(title)

    if (row.facts.length > 0) {
      const facts = document.createElement('div')
      facts.className = 'fl-storage-facts'
      facts.textContent = row.facts.join(' · ')
      main.appendChild(facts)
    }

    const detail = document.createElement('div')
    detail.className = 'fl-storage-detail'
    detail.textContent = row.detail
    main.appendChild(detail)
    el.appendChild(main)

    const free = document.createElement('button')
    free.type = 'button'
    free.className = 'fl-settings-btn'
    free.textContent = 'Free'
    free.disabled = !row.free.enabled || this.#busy
    if (row.free.reason !== null) free.title = row.free.reason
    free.addEventListener('click', () => {
      if (free.disabled) return
      void this.#free([row])
    })
    el.appendChild(free)
    return el
  }

  // ── Doing it ─────────────────────────────────────────────────────────────

  /**
   * Let files go — with the say-so this press IS.
   *
   * `confirmed: true` IS THIS CLICK, written here and nowhere else in this flow
   * (forbidden-pattern #15). `allowUnlanded` is never written at all: the rows
   * it exists for cannot be pressed, so there is no gesture on this page that
   * could produce it, which is what the header promises.
   *
   * SEQUENTIAL, AND A REFUSAL DOES NOT STOP THE NEXT ONE. A row that grew work
   * since the page was drawn must be KEPT, and keeping it must not cost the
   * other eleven their removal — main re-checks each one, and a `kept` count is
   * the rule working rather than a failure.
   */
  async #free(rows: readonly StorageRowView[]): Promise<void> {
    const threads = window.flow?.threads
    if (
      this.#busy ||
      rows.length === 0 ||
      threads === undefined ||
      typeof threads.releaseWorktree !== 'function'
    ) {
      return
    }
    this.#busy = true
    let freed = 0
    let kept = 0
    try {
      for (const row of rows) {
        const result = await threads.releaseWorktree({
          threadId: row.id,
          confirmed: true,
          // A row no conversation claims cannot be looked up from one; main
          // resolves it from the same listing this row came from. Keyed on a
          // typed fact, never on the row's display copy.
          ...(row.unclaimed ? { abandonedIn: this.#rootPath } : {}),
        })
        if (result.status === 'pruned') freed += 1
        else kept += 1
      }
      this.#status = freeSummary(freed, kept)
    } catch (error) {
      console.error('flow: freeing files failed', error)
      this.#status = FREE_FAILED
    } finally {
      this.#busy = false
      await this.load()
    }
  }
}

// ── Styles ──────────────────────────────────────────────────────────────────

let storageStylesInjected = false

/**
 * The page's own CSS, injected once.
 *
 * ONLY WHAT IS THIS PAGE'S ALONE — the heading, the button and the panel's
 * spacing all come from the settings panel this renders inside, so a change to
 * the panel's chrome reaches this page for free. Note the absence of any
 * backtick below: this is a template literal, and one inside it breaks the
 * build with a TypeScript error that names the wrong line entirely.
 */
function injectStorageStyles(): void {
  if (storageStylesInjected) return
  storageStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-storage { display: flex; flex-direction: column; gap: var(--fl-space-sm); }
    .fl-storage-back {
      align-self: flex-start;
      border: none;
      background: none;
      padding: 0;
      cursor: pointer;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
    }
    .fl-storage-back:hover { color: var(--fl-color-text); }
    .fl-storage-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--fl-space-sm);
    }
    .fl-storage-count {
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-storage-note, .fl-storage-empty {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      line-height: 1.5;
    }
    .fl-storage-status {
      color: var(--fl-color-text);
      font-size: var(--fl-text-caption-size);
      border-left: 2px solid var(--fl-color-accent);
      padding-left: var(--fl-space-sm);
    }
    .fl-storage-rows { display: flex; flex-direction: column; }
    .fl-storage-row {
      display: flex;
      align-items: flex-start;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) 0;
      border-top: var(--fl-border-width) solid var(--fl-color-separator);
    }
    /* The width is held whatever the tone, so nothing shifts between rows. */
    .fl-storage-mark {
      flex: 0 0 auto;
      width: 3px;
      align-self: stretch;
      border-radius: var(--fl-radius-pill);
      background: var(--fl-color-border);
    }
    .fl-storage-mark[data-tone='working'] { background: var(--fl-color-accent); }
    .fl-storage-mark[data-tone='orphaned'] { background: var(--fl-color-warning); }
    .fl-storage-main { flex: 1 1 auto; min-width: 0; }
    .fl-storage-title {
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-storage-title.plain { color: var(--fl-color-text-secondary); font-style: italic; }
    .fl-storage-facts {
      color: var(--fl-color-text-muted);
      font-size: var(--fl-text-caption-size);
      margin-top: 1px;
    }
    .fl-storage-kept { display: flex; flex-direction: column; gap: var(--fl-space-sm); margin-top: var(--fl-space-md); }
    .fl-storage-kept:empty { display: none; }
    .fl-storage-confirm-overlay {
      position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.35);
    }
    .fl-storage-confirm {
      width: min(440px, calc(100vw - 32px)); box-sizing: border-box; padding: var(--fl-space-lg);
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35); font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-storage-confirm-title { font-weight: var(--fl-text-ui-weight-medium); }
    .fl-storage-confirm .fl-storage-note { margin: 0; }
    .fl-storage-confirm-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-sm); }
    .fl-storage-danger { background: var(--fl-color-error); border-color: var(--fl-color-error); color: var(--fl-color-on-accent); }
    .fl-storage-detail {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      line-height: 1.5;
      margin-top: 2px;
    }
  `
  document.head.appendChild(style)
}
