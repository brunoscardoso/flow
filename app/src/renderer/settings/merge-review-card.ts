/**
 * "Review the merge" and "Shared merge reasons" — one Workspace's review card
 * in Settings → Workspaces.
 *
 * A VIEW, NOT A MODEL. Every sentence and decision comes from
 * `merge-review-model.ts` (DOM-free, tested, scanned for forbidden-pattern
 * #12). Every operation goes through `window.flow.workspaces` — agree,
 * disagree with a reason, decide one item, list and remove a shared reason —
 * and a refusal's own sentence (`detail`) is what the person reads, never its
 * reason code.
 *
 * ONE INSTANCE PER WORKSPACE, KEPT ACROSS THE SECTION'S REPAINTS. The settings
 * section redraws its whole body for many reasons; it re-attaches this
 * element instead of rebuilding it, so a half-typed reason survives. The card
 * redraws itself only when the REVIEW part of a status changed, or after one
 * of its own actions (allowed-pattern #17) — a typed character updates its own
 * button, never the card.
 */
import type {
  WorkspaceMergeGroupKey,
  WorkspaceMergeReason,
  WorkspaceReviewResult,
  WorkspaceSyncStatus,
} from '../../shared/workspaces-contract'
import {
  ACTION_FAILED_LINE,
  AGREE_LABEL,
  CANCEL_LABEL,
  DISAGREE_LABEL,
  EDIT_TEXT_ARIA,
  EDIT_TEXT_LABEL,
  EDIT_TEXT_PLACEHOLDER,
  EMPTY_UI_STATE,
  KEEP_MINE_LABEL,
  KEEP_TEAMS_LABEL,
  REASONS_SHOW_LABEL,
  REDO_LABEL,
  REMOVE_LABEL,
  SAVE_TEXT_LABEL,
  mergeReviewView,
  reasonsView,
  reviewKey,
  type GroupView,
  type MergeReviewUiState,
  type NeedsYouRowView,
  type Pill,
} from './merge-review-model'
import { reviewWaits } from './workspace-settings-model'

let stylesInjected = false

export interface MergeReviewCardOptions {
  slug: string
  /** A request answered with a newer status: the section keeps it and repaints its sync line. */
  onStatus: (status: WorkspaceSyncStatus) => void
}

export class MergeReviewCard {
  readonly element: HTMLDivElement
  readonly #slug: string
  readonly #onStatus: (status: WorkspaceSyncStatus) => void
  readonly #review: HTMLElement
  readonly #reasonsEl: HTMLElement
  #status: WorkspaceSyncStatus | null = null
  #key = ''
  #ui: MergeReviewUiState = { ...EMPTY_UI_STATE, open: new Set(), showAll: new Set() }
  /** null: not read yet · a sentence: could not be read · the list. */
  #reasons: WorkspaceMergeReason[] | string | null = null
  #reasonsOpen = false
  #reasonsBusy = false
  /** The Workspace shares through a repository: the reasons list is offered even with no review open. */
  #shared = false
  #disposed = false

  constructor(options: MergeReviewCardOptions) {
    injectStyles()
    this.#slug = options.slug
    this.#onStatus = options.onStatus
    this.element = document.createElement('div')
    this.element.className = 'fl-mrc'
    this.element.dataset['part'] = 'merge-review'
    this.#review = document.createElement('section')
    this.#review.className = 'fl-mrc-section fl-mrc-review'
    this.#review.hidden = true
    this.#reasonsEl = document.createElement('section')
    this.#reasonsEl.className = 'fl-mrc-section fl-mrc-reasons'
    this.#reasonsEl.hidden = true
    this.element.append(this.#review, this.#reasonsEl)
  }

  /** Whether there is anything to show (a review, or a shared Workspace's reasons). */
  get visible(): boolean {
    return reviewWaits(this.#status?.review) || this.#shared
  }

  /** A newer status for this Workspace. Redraws only when its review part changed. */
  update(status: WorkspaceSyncStatus | null, shared: boolean): void {
    if (this.#disposed) return
    const sharedChanged = shared !== this.#shared
    this.#shared = shared
    this.#status = status
    const key = reviewKey(status)
    const reviewChanged = key !== this.#key
    this.#key = key
    if (reviewChanged) {
      this.#drawReview()
      // A review on screen opens the reasons beside it — the policy the agent reads.
      if (reviewWaits(status?.review) && !this.#reasonsOpen) {
        this.#reasonsOpen = true
        void this.#loadReasons()
      }
    }
    if (reviewChanged || sharedChanged) this.#drawReasons()
  }

  /** Bring the review into view and put focus on its heading (the review notice's way in). */
  focusReview(): boolean {
    if (this.#review.hidden) return false
    const heading = this.#review.querySelector<HTMLElement>('.fl-mrc-title')
    this.#review.scrollIntoView({ block: 'start', behavior: 'smooth' })
    heading?.focus({ preventScroll: true })
    return true
  }

  dispose(): void {
    this.#disposed = true
  }

  // ── The review ────────────────────────────────────────────────────────────

  #drawReview(): void {
    const view = mergeReviewView(this.#status, this.#ui, Date.now())
    this.#review.replaceChildren()
    this.#review.hidden = view === null
    if (view === null) return

    const head = row('fl-mrc-head')
    const title = text('h3', view.title, 'fl-mrc-title')
    title.tabIndex = -1
    head.append(title, text('span', view.subtitle, 'fl-wss-muted'))
    this.#review.appendChild(head)

    if (view.summary.length > 0) {
      const summary = row('fl-mrc-summary')
      for (const item of view.summary) summary.appendChild(pill(item))
      this.#review.appendChild(summary)
    }

    if (view.groups.length > 0) {
      const groups = document.createElement('div')
      groups.className = 'fl-mrc-groups'
      for (const group of view.groups) groups.appendChild(this.#group(group))
      this.#review.appendChild(groups)
    }

    if (view.needsYou !== null) {
      const needs = document.createElement('div')
      needs.className = 'fl-mrc-needs'
      needs.dataset['part'] = 'needs-you'
      const needsHead = row('fl-mrc-ghead fl-mrc-needs-head')
      const titleBox = document.createElement('div')
      titleBox.className = 'fl-mrc-gtitle'
      titleBox.append(text('div', view.needsYou.title, 'fl-mrc-gname'), text('div', view.needsYou.blurb, 'fl-wss-muted'))
      needsHead.append(text('span', String(view.needsYou.count), 'fl-mrc-count fl-mrc-count-static'), titleBox)
      needs.appendChild(needsHead)
      for (const entry of view.needsYou.rows) needs.appendChild(this.#needsYouRow(entry, view.busy))
      this.#review.appendChild(needs)
    }

    if (view.doneLine !== null) this.#review.appendChild(text('div', view.doneLine, 'fl-wss-muted'))
    if (view.notice !== null) {
      const notice = text('div', view.notice, 'fl-wss-notice fl-mrc-notice')
      notice.setAttribute('role', 'status')
      this.#review.appendChild(notice)
    }

    const footer = row('fl-mrc-footer')
    // One request for every group: a per-group agree would hold the other groups back before sharing.
    const agreeAll = button(view.agreeAllLabel, () => void this.#agreeAllGroups(), 'agree-all')
    agreeAll.classList.add('fl-wss-primary')
    agreeAll.disabled = !view.canAgreeAll
    footer.append(text('span', view.footerLine, 'fl-wss-muted'), agreeAll)
    this.#review.appendChild(footer)
  }

  #group(group: GroupView): HTMLElement {
    const box = document.createElement('div')
    box.className = 'fl-mrc-group'
    box.dataset['group'] = group.key
    const head = row('fl-mrc-ghead')
    const count = button(String(group.count), () => this.#toggle(group.key), 'group-count')
    count.className = 'fl-mrc-count fl-mrc-link'
    count.setAttribute('aria-expanded', String(group.open))
    count.setAttribute('aria-label', group.countAria)
    const titleBox = document.createElement('div')
    titleBox.className = 'fl-mrc-gtitle'
    titleBox.append(text('div', group.label, 'fl-mrc-gname'), text('div', group.blurb, 'fl-wss-muted'))
    head.append(count, titleBox, pill(group.pill))
    if (group.disagreeableIds.length > 0) {
      const disagree = button(DISAGREE_LABEL, () => this.#openDisagree(group.key), 'group-disagree')
      disagree.disabled = !group.canDisagree
      head.appendChild(disagree)
    }
    if (group.agreeableIds.length > 0) {
      const agree = button(AGREE_LABEL, () => void this.#agree(group.agreeableIds), 'group-agree')
      agree.classList.add('fl-wss-primary')
      agree.disabled = !group.canAgree
      head.appendChild(agree)
    }
    box.appendChild(head)

    if (group.open) {
      const items = document.createElement('div')
      items.className = 'fl-mrc-items'
      for (const item of group.rows) {
        const line = row('fl-mrc-item')
        line.dataset['itemId'] = item.id
        line.append(text('span', item.label, 'fl-mrc-item-name'), pill(item.pill))
        if (item.why !== '') line.appendChild(text('span', item.why, 'fl-wss-muted fl-mrc-why'))
        if (item.yourReason !== null) line.appendChild(text('span', item.yourReason, 'fl-wss-muted fl-mrc-why'))
        items.appendChild(line)
      }
      if (group.showAllLabel !== null) {
        const all = button(group.showAllLabel, () => this.#showAll(group.key), 'show-all')
        all.className = 'fl-mrc-link'
        items.appendChild(all)
      }
      if (group.moreLine !== null) items.appendChild(text('span', group.moreLine, 'fl-wss-muted'))
      box.appendChild(items)
    }

    const disagree = group.disagree
    if (disagree !== null) {
      const panel = document.createElement('div')
      panel.className = 'fl-mrc-reason'
      const id = `fl-mrc-reason-${this.#slug}-${group.key}`
      const label = document.createElement('label')
      label.htmlFor = id
      label.append(text('strong', disagree.question, ''), text('span', disagree.help, 'fl-wss-muted fl-mrc-help'))
      const area = document.createElement('textarea')
      area.id = id
      area.className = 'fl-settings-input fl-mrc-textarea'
      area.placeholder = disagree.placeholder
      area.value = disagree.draft
      const send = button(REDO_LABEL, () => void this.#disagree(group.key, group.disagreeableIds), 'redo-with-reason')
      send.classList.add('fl-wss-primary')
      send.disabled = !disagree.canSend
      area.addEventListener('input', () => {
        this.#ui = { ...this.#ui, reasonDraft: area.value }
        send.disabled = this.#ui.busy || area.value.trim() === ''
      })
      const actions = row('fl-mrc-actions')
      const cancel = button(CANCEL_LABEL, () => this.#closeDisagree(), 'cancel-disagree')
      cancel.className = 'fl-mrc-link'
      actions.append(cancel, spacer(), send)
      panel.append(label, area, actions)
      box.appendChild(panel)
      queueMicrotask(() => {
        if (area.isConnected && document.activeElement !== area) area.focus()
      })
    }
    return box
  }

  #needsYouRow(entry: NeedsYouRowView, busy: boolean): HTMLElement {
    const box = document.createElement('div')
    box.className = 'fl-mrc-need'
    box.dataset['itemId'] = entry.id
    const top = row('')
    const name = document.createElement('span')
    name.className = 'fl-mrc-grow'
    name.appendChild(text('strong', entry.title, ''))
    if (entry.project !== null) name.appendChild(text('span', entry.project, 'fl-wss-muted fl-mrc-project'))
    top.append(name, pill(entry.pill))
    box.append(top, text('div', entry.sentence, 'fl-wss-muted'))
    if (entry.agentReason !== null) box.appendChild(text('div', entry.agentReason, 'fl-wss-muted fl-mrc-agent-reason'))

    const actions = row('fl-mrc-actions')
    const mine = button(KEEP_MINE_LABEL, () => void this.#decide(entry.id, 'ours'), 'keep-mine')
    const teams = button(KEEP_TEAMS_LABEL, () => void this.#decide(entry.id, 'theirs'), 'keep-teams')
    const edit = button(EDIT_TEXT_LABEL, () => this.#openEditor(entry.id), 'edit-text')
    for (const control of [mine, teams, edit]) control.disabled = busy
    edit.disabled = busy || entry.editing
    actions.append(mine, teams, edit)
    box.appendChild(actions)

    if (entry.editing) {
      const area = document.createElement('textarea')
      area.className = 'fl-settings-input fl-mrc-textarea fl-mrc-editor'
      area.placeholder = EDIT_TEXT_PLACEHOLDER
      area.setAttribute('aria-label', EDIT_TEXT_ARIA)
      area.value = entry.draftText
      const save = button(SAVE_TEXT_LABEL, () => void this.#decideText(entry.id, area.value), 'use-text')
      save.classList.add('fl-wss-primary')
      save.disabled = !entry.canSaveText
      area.addEventListener('input', () => {
        this.#ui = { ...this.#ui, textDraft: area.value }
        save.disabled = this.#ui.busy || area.value.trim() === ''
      })
      const editActions = row('fl-mrc-actions')
      const cancel = button(CANCEL_LABEL, () => this.#closeEditor(), 'cancel-edit')
      cancel.className = 'fl-mrc-link'
      editActions.append(cancel, spacer(), save)
      box.append(area, editActions)
      queueMicrotask(() => {
        if (area.isConnected && document.activeElement !== area) area.focus()
      })
    }
    return box
  }

  #setUi(next: Partial<MergeReviewUiState>): void {
    this.#ui = { ...this.#ui, ...next }
    this.#drawReview()
  }

  #toggle(key: WorkspaceMergeGroupKey): void {
    const open = new Set(this.#ui.open)
    if (open.has(key)) open.delete(key)
    else open.add(key)
    this.#setUi({ open })
  }

  #showAll(key: WorkspaceMergeGroupKey): void {
    this.#setUi({ showAll: new Set([...this.#ui.showAll, key]) })
  }

  #openDisagree(key: WorkspaceMergeGroupKey): void {
    this.#setUi({ disagreeing: key, reasonDraft: this.#ui.disagreeing === key ? this.#ui.reasonDraft : '', notice: null })
  }

  #closeDisagree(): void {
    this.#setUi({ disagreeing: null, reasonDraft: '' })
  }

  #openEditor(id: string): void {
    this.#setUi({ editing: id, textDraft: null, notice: null })
  }

  #closeEditor(): void {
    this.#setUi({ editing: null, textDraft: null })
  }

  async #agree(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.#run(() => window.flow.workspaces?.reviewAgree({ slug: this.#slug, ids: [...ids] }), {})
  }

  async #agreeAllGroups(): Promise<void> {
    await this.#run(() => window.flow.workspaces?.reviewAgree({ slug: this.#slug, allGroups: true }), {})
  }

  async #disagree(key: WorkspaceMergeGroupKey, ids: readonly string[]): Promise<void> {
    const reason = this.#ui.reasonDraft.trim()
    if (reason === '' || ids.length === 0) return
    await this.#run(() => window.flow.workspaces?.reviewDisagree({ slug: this.#slug, ids: [...ids], reason }), {
      disagreeing: this.#ui.disagreeing === key ? null : this.#ui.disagreeing,
      reasonDraft: '',
    })
  }

  async #decide(id: string, take: 'ours' | 'theirs'): Promise<void> {
    await this.#run(() => window.flow.workspaces?.reviewDecide({ slug: this.#slug, id, take }), { editing: null, textDraft: null })
  }

  async #decideText(id: string, value: string): Promise<void> {
    if (value.trim() === '') return
    await this.#run(() => window.flow.workspaces?.reviewDecide({ slug: this.#slug, id, take: 'text', text: value }), {
      editing: null,
      textDraft: null,
    })
  }

  /** One review request: everything waits, then the answer's status repaints, and its sentence shows when it did not work. */
  async #run(
    call: () => Promise<WorkspaceReviewResult> | undefined,
    onSuccess: Partial<MergeReviewUiState>,
  ): Promise<void> {
    if (this.#ui.busy) return
    this.#setUi({ busy: true, notice: null })
    let result: WorkspaceReviewResult | null = null
    try {
      result = (await call()) ?? null
    } catch {
      result = null
    }
    if (this.#disposed) return
    if (result === null) {
      this.#setUi({ busy: false, notice: ACTION_FAILED_LINE })
      return
    }
    this.#ui = { ...this.#ui, busy: false, ...(result.ok ? { ...onSuccess, notice: null } : { notice: result.detail }) }
    // The status carries what waits now, whether or not the request did its work.
    this.#key = ''
    this.#onStatus(result.status)
    this.update(result.status, this.#shared)
    if (result.ok) void this.#loadReasons()
  }

  // ── Shared merge reasons ──────────────────────────────────────────────────

  async #loadReasons(): Promise<void> {
    const api = window.flow.workspaces
    if (api === undefined) return
    const answer = await api.mergeReasons({ slug: this.#slug }).catch(() => null)
    if (this.#disposed) return
    this.#reasons = answer === null ? ACTION_FAILED_LINE : answer.ok ? answer.reasons : answer.detail
    this.#drawReasons()
  }

  async #remove(id: string): Promise<void> {
    const api = window.flow.workspaces
    if (api === undefined || this.#reasonsBusy) return
    this.#reasonsBusy = true
    this.#drawReasons()
    const answer = await api.removeMergeReason({ slug: this.#slug, id }).catch(() => null)
    this.#reasonsBusy = false
    if (this.#disposed) return
    if (answer !== null && answer.ok) this.#reasons = answer.reasons
    else {
      // Keep the list as it was; say why beside it.
      this.#drawReasons(answer === null ? ACTION_FAILED_LINE : answer.detail)
      return
    }
    this.#drawReasons()
  }

  #drawReasons(notice: string | null = null): void {
    this.#reasonsEl.replaceChildren()
    this.#reasonsEl.hidden = !this.visible
    if (!this.visible) return
    const view = reasonsView(this.#reasons, Date.now(), this.#reasonsBusy)
    const head = row('fl-mrc-head')
    head.append(text('h3', view.title, 'fl-mrc-title'), text('span', view.blurb, 'fl-wss-muted'))
    if (!this.#reasonsOpen) {
      head.appendChild(
        button(REASONS_SHOW_LABEL, () => {
          this.#reasonsOpen = true
          this.#drawReasons()
          void this.#loadReasons()
        }, 'show-reasons'),
      )
      this.#reasonsEl.appendChild(head)
      return
    }
    this.#reasonsEl.appendChild(head)
    if (view.line !== null) this.#reasonsEl.appendChild(text('div', view.line, 'fl-wss-muted'))
    const list = document.createElement('div')
    list.className = 'fl-mrc-reason-list'
    for (const reason of view.rows) {
      const line = row('fl-mrc-reason-row')
      line.dataset['reasonId'] = reason.id
      const remove = button(REMOVE_LABEL, () => void this.#remove(reason.id), 'remove-reason')
      remove.className = 'fl-mrc-link'
      remove.setAttribute('aria-label', reason.removeAria)
      remove.disabled = !reason.canRemove
      line.append(pill({ text: reason.kind, tone: 'pending' }), text('q', reason.quote, 'fl-mrc-quote'), text('span', reason.meta, 'fl-wss-muted'), remove)
      list.appendChild(line)
    }
    if (view.rows.length > 0) this.#reasonsEl.appendChild(list)
    if (notice !== null) {
      const line = text('div', notice, 'fl-wss-notice fl-mrc-notice')
      line.setAttribute('role', 'status')
      this.#reasonsEl.appendChild(line)
    }
  }
}

// ── Small builders ──────────────────────────────────────────────────────────

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className !== '') el.className = className
  el.textContent = value
  return el
}

function row(className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className === '' ? 'fl-mrc-row' : `fl-mrc-row ${className}`
  return el
}

function spacer(): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'fl-mrc-grow'
  return el
}

function pill(value: Pill): HTMLSpanElement {
  return text('span', value.text, `fl-mrc-pill ${value.tone}`)
}

function button(label: string, onClick: () => void, part: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'fl-settings-btn'
  el.textContent = label
  el.dataset['part'] = part
  el.addEventListener('click', onClick)
  return el
}

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-mrc { display: flex; flex-direction: column; gap: var(--fl-space-md); padding: 0 var(--fl-space-md) var(--fl-space-md); }
    .fl-mrc-section {
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
      padding: var(--fl-space-md); background: var(--fl-color-surface);
    }
    .fl-mrc-section[hidden] { display: none; }
    .fl-mrc-row { display: flex; align-items: center; gap: var(--fl-space-sm); flex-wrap: wrap; }
    .fl-mrc-grow { flex: 1 1 auto; min-width: 0; }
    .fl-mrc-head .fl-mrc-title { flex: 1 1 auto; }
    .fl-mrc-title { margin: 0; font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); outline: none; }
    .fl-mrc-title:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 2px; border-radius: var(--fl-radius-sm); }
    .fl-mrc-summary { gap: var(--fl-space-xs); }
    .fl-mrc-pill {
      font-size: var(--fl-text-caption-size); padding: 1px 8px; border-radius: 999px; white-space: nowrap;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-mrc-pill.ok { color: var(--fl-color-success); background: color-mix(in srgb, var(--fl-color-success) 14%, transparent); }
    .fl-mrc-pill.pending { color: var(--fl-color-accent); background: color-mix(in srgb, var(--fl-color-accent) 14%, transparent); }
    .fl-mrc-pill.warn { color: var(--fl-color-warning); background: color-mix(in srgb, var(--fl-color-warning) 14%, transparent); }
    .fl-mrc-pill.held { color: var(--fl-color-text-secondary); background: var(--fl-color-surface-raised); border: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-mrc-groups, .fl-mrc-needs {
      display: flex; flex-direction: column; overflow: hidden;
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm);
    }
    .fl-mrc-needs { border-color: var(--fl-color-warning); }
    .fl-mrc-group + .fl-mrc-group { border-top: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-mrc-ghead { padding: var(--fl-space-sm) var(--fl-space-sm); }
    .fl-mrc-needs-head { background: color-mix(in srgb, var(--fl-color-warning) 10%, transparent); }
    .fl-mrc-gtitle { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .fl-mrc-gname { font-size: var(--fl-text-ui-size); color: var(--fl-color-text); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-mrc-count { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; font-weight: var(--fl-text-ui-weight-medium); font-size: var(--fl-text-ui-size); }
    .fl-mrc-count-static { color: var(--fl-color-text); }
    .fl-mrc-link {
      border: none; background: none; padding: 2px 2px; cursor: pointer; font: inherit; font-size: var(--fl-text-ui-size);
      color: var(--fl-color-accent);
    }
    .fl-mrc-link.fl-mrc-count { font-weight: var(--fl-text-ui-weight-medium); }
    .fl-mrc-link:hover:not(:disabled) { text-decoration: underline; }
    .fl-mrc-link:disabled { opacity: 0.5; cursor: default; }
    .fl-mrc-link:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; border-radius: var(--fl-radius-sm); }
    .fl-mrc-items {
      display: flex; flex-direction: column; align-items: flex-start; gap: var(--fl-space-xs);
      padding: var(--fl-space-xs) var(--fl-space-sm) var(--fl-space-sm) 64px; background: var(--fl-color-surface-raised);
    }
    .fl-mrc-item { width: 100%; align-items: baseline; gap: var(--fl-space-xs) var(--fl-space-sm); }
    .fl-mrc-item-name { flex: 1 1 auto; min-width: 0; font-size: var(--fl-text-ui-size); color: var(--fl-color-text); overflow-wrap: anywhere; }
    .fl-mrc-why { flex-basis: 100%; }
    .fl-mrc-reason {
      display: flex; flex-direction: column; gap: var(--fl-space-xs);
      padding: var(--fl-space-sm) var(--fl-space-sm) var(--fl-space-sm) 64px;
      background: color-mix(in srgb, var(--fl-color-warning) 10%, transparent);
    }
    .fl-mrc-reason label { display: flex; flex-direction: column; gap: 2px; font-size: var(--fl-text-ui-size); color: var(--fl-color-text); }
    .fl-mrc-textarea { width: 100%; min-height: 64px; resize: vertical; font: inherit; font-size: var(--fl-text-ui-size); box-sizing: border-box; }
    .fl-mrc-editor { min-height: 140px; font-family: var(--fl-font-mono); font-size: var(--fl-text-caption-size); }
    .fl-mrc-actions { gap: var(--fl-space-xs); }
    .fl-mrc-need { display: flex; flex-direction: column; gap: var(--fl-space-xs); padding: var(--fl-space-sm); }
    .fl-mrc-need + .fl-mrc-need, .fl-mrc-needs-head + .fl-mrc-need { border-top: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-mrc-project { margin-left: var(--fl-space-xs); }
    .fl-mrc-agent-reason { font-style: italic; }
    .fl-mrc-notice { margin: 0; }
    .fl-mrc-footer {
      justify-content: space-between; border-top: var(--fl-border-width) solid var(--fl-color-border);
      padding-top: var(--fl-space-sm);
    }
    .fl-mrc-reason-list { display: flex; flex-direction: column; }
    .fl-mrc-reason-row { align-items: baseline; padding: var(--fl-space-xs) 0; }
    .fl-mrc-reason-row + .fl-mrc-reason-row { border-top: var(--fl-border-width) solid var(--fl-color-separator, var(--fl-color-border)); }
    .fl-mrc-quote { flex: 1 1 220px; min-width: 0; font-size: var(--fl-text-ui-size); color: var(--fl-color-text); quotes: "\\201C" "\\201D"; }
    @container (max-width: 560px) {
      .fl-mrc-items, .fl-mrc-reason { padding-left: var(--fl-space-sm); }
    }
  `
  document.head.appendChild(style)
}
