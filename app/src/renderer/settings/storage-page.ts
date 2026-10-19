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

  constructor(rootPath: string, callbacks: StoragePageCallbacks) {
    injectStorageStyles()
    this.#rootPath = rootPath
    this.#callbacks = callbacks
    this.#root = document.createElement('div')
    this.#root.className = 'fl-storage'
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
      return
    }

    const list = document.createElement('div')
    list.className = 'fl-storage-rows'
    for (const row of rows) list.appendChild(this.#row(row))
    this.#root.appendChild(list)
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
    .fl-storage-detail {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      line-height: 1.5;
      margin-top: 2px;
    }
  `
  document.head.appendChild(style)
}
