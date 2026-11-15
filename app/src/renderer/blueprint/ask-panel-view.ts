// Ask the Blueprint — the floating panel (plan `ask_the_blueprint`, Phase 3).
//
// THIN ON PURPOSE. Everything this panel decides — what each state says, what
// a follow-up waits for, what the map shows — is `ask-panel-model`'s pure
// reducer; matching pasted text and the @ picker are `ask-tag-suggest`'s. This
// file turns DOM events into model events, model state into DOM, and talks to
// main through `window.flow.ask`.
//
// PAY ONLY WHILE OPEN (allowed-pattern #17). The `ask:state` subscription is
// taken when the panel opens and dropped when it closes; saved-question reads
// run only for the view on screen, and a read nobody is waiting for is dropped.
//
// No commands, paths or settings in its words (forbidden #12): a source shows
// a file NAME as a reference, and every error is main's plain sentence.

import type { AskSavedThread, AskSource } from '../../shared/ask-contract'
import {
  ageLabel,
  canFollowUp,
  continuePrompt,
  conversationTagIds,
  currentTurn,
  durationLabel,
  followUpTarget,
  initialAskState,
  isRunning,
  listLabel,
  mapTagIds,
  reduceAsk,
  type AskCellMark,
  type AskPanelEvent,
  type AskPanelState,
  type AskTag,
  type AskTurn,
} from './ask-panel-model'
import {
  activeMention,
  graphCandidates,
  pickerMatches,
  suggestTags,
  type PickerCandidate,
  type SuggestNode,
} from './ask-tag-suggest'

/** What the board lends the panel. */
export interface AskPanelHost {
  /** The project the panel asks about, or null when none is open. */
  rootId: () => string | null
  /** The features and parts the board holds — for suggestions and the @ picker. */
  graphNodes: () => readonly SuggestNode[]
  /** Which features the saved-question list reads when nothing is tagged. */
  historyScope: () => string[]
  /** The state changed — the board redraws the map if what it shows changed. */
  onChange: (state: AskPanelState) => void
  /** Open a source's file in the board's read-only drawer. */
  peekFile: (relPath: string) => void
}

const ASK_TIMEOUT_SENTENCE = "Flow couldn't start that question."
const LIST_DEBOUNCE_MS = 250
const THREAD_PICKER_LIMIT = 30

/* ── Tiny DOM helpers ─────────────────────────────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, press: () => void, label?: string): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  if (label !== undefined) node.setAttribute('aria-label', label)
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    press()
  })
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A stroke icon from path data — no emoji, no icon font. */
function icon(paths: string[], size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

const ICON_HISTORY = ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2']
const ICON_CLOSE = ['M6 6l12 12M18 6L6 18']
const ICON_BACK = ['M15 18l-6-6 6-6']
const ICON_CHECK = ['M20 6L9 17l-5-5']
const ICON_SPIN = ['M21 12a9 9 0 1 1-9-9']
const ICON_CHAT = ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']
const ICON_BRANCH = ['M6 4v12', 'M18 6a2 2 0 1 0 0 .01', 'M6 18a2 2 0 1 0 0 .01', 'M18 8c0 4-6 3-10 6']

function iconButton(paths: string[], label: string, press: () => void): HTMLButtonElement {
  const node = button('fb-ask-icon-btn', '', press, label)
  node.title = label
  node.appendChild(icon(paths))
  return node
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/* ── The panel ────────────────────────────────────────────────────────── */

export class AskPanelView {
  readonly element: HTMLElement
  readonly #host: AskPanelHost
  #state: AskPanelState = initialAskState()

  // Persistent pieces — rebuilt never, so focus and the caret survive a repaint.
  readonly #backBtn: HTMLButtonElement
  readonly #historyBtn: HTMLButtonElement
  readonly #body: HTMLElement
  readonly #compose: HTMLElement
  readonly #chips: HTMLElement
  readonly #textarea: HTMLTextAreaElement
  readonly #askBtn: HTMLButtonElement
  readonly #picker: HTMLElement
  readonly #suggestions: HTMLElement
  readonly #askedBefore: HTMLElement
  readonly #answer: HTMLElement
  readonly #history: HTMLElement
  readonly #footer: HTMLElement
  readonly #followInput: HTMLInputElement
  readonly #continueBtn: HTMLButtonElement

  #unsubscribe: (() => void) | null = null
  #pickerRows: PickerCandidate[] = []
  #pickerIndex = 0
  #threadCandidates: PickerCandidate[] | null = null
  #threadsLoading = false
  #listTimer: number | null = null
  #listSeq = 0
  #historySeq = 0
  #listedKey = ''
  #staleRead = false
  #copyTimer: number | null = null

  constructor(host: AskPanelHost) {
    this.#host = host
    injectAskStyles()

    this.element = el('div', 'fb-ask')
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Ask the Blueprint')
    this.element.hidden = true
    // Clicks and keys inside the panel are the panel's, never the sheet's.
    this.element.addEventListener('click', (event) => event.stopPropagation())
    this.element.addEventListener('dblclick', (event) => event.stopPropagation())
    this.element.addEventListener('keydown', (event) => this.#onKeydown(event))

    // HEADER — a drag handle, with back, history and close.
    const head = el('div', 'fb-ask-head')
    this.#backBtn = iconButton(ICON_BACK, 'Back to the question', () => this.#dispatch({ type: 'new-question' }))
    const title = el('span', 'fb-ask-title', 'Ask the Blueprint')
    const spacer = el('span', 'fb-ask-spacer')
    this.#historyBtn = iconButton(ICON_HISTORY, 'Saved questions', () => this.#showHistory())
    const close = iconButton(ICON_CLOSE, 'Close', () => this.close())
    head.append(this.#backBtn, title, spacer, this.#historyBtn, close)
    this.#wireDrag(head)

    this.#body = el('div', 'fb-ask-body')

    // COMPOSE — intro, the question box, the picker, suggestions, asked before.
    this.#compose = el('div', 'fb-ask-compose')
    const intro = el(
      'p',
      'fb-ask-intro',
      'Ask how something works, or paste a message from your team. Click a feature on the map to add it.',
    )
    const box = el('div', 'fb-ask-box')
    this.#chips = el('div', 'fb-ask-chips')
    this.#textarea = el('textarea', 'fb-ask-input')
    this.#textarea.rows = 3
    this.#textarea.placeholder = 'How does… / Can we build…'
    this.#textarea.setAttribute('aria-label', 'Your question')
    this.#textarea.addEventListener('input', (event) => this.#onInput(event as InputEvent))
    this.#textarea.addEventListener('blur', () => window.setTimeout(() => this.#closePicker(), 150))
    const boxFoot = el('div', 'fb-ask-box-foot')
    const hint = el('span', 'fb-ask-hint', '@ to tag a feature, part or conversation')
    this.#askBtn = button('fb-ask-primary', 'Ask', () => this.#submit(false))
    boxFoot.append(hint, el('span', 'fb-ask-spacer'), this.#askBtn)
    box.append(this.#chips, this.#textarea, boxFoot)
    this.#picker = el('div', 'fb-ask-picker')
    this.#picker.setAttribute('role', 'listbox')
    this.#picker.hidden = true
    const boxWrap = el('div', 'fb-ask-box-wrap')
    boxWrap.append(box, this.#picker)
    this.#suggestions = el('div', 'fb-ask-card fb-ask-suggest')
    this.#askedBefore = el('div', 'fb-ask-before')
    this.#compose.append(intro, boxWrap, this.#suggestions, this.#askedBefore)

    this.#answer = el('div', 'fb-ask-answer')
    this.#history = el('div', 'fb-ask-history')
    this.#body.append(this.#compose, this.#answer, this.#history)

    // FOOTER — the follow-up box and Continue in a conversation.
    this.#footer = el('div', 'fb-ask-foot')
    this.#followInput = el('input', 'fb-ask-follow')
    this.#followInput.type = 'text'
    this.#followInput.placeholder = 'Ask a follow-up…'
    this.#followInput.setAttribute('aria-label', 'Ask a follow-up')
    this.#followInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      event.stopPropagation()
      this.#submit(true)
    })
    this.#continueBtn = button('fb-ask-secondary', 'Continue in a conversation', () => this.#continueInConversation())
    this.#footer.append(this.#followInput, this.#continueBtn)

    this.element.append(head, this.#body, this.#footer)
    this.#render()
  }

  get state(): AskPanelState {
    return this.#state
  }

  get isOpen(): boolean {
    return this.#state.open
  }

  /** Open — with text or tags, a fresh question; with neither, where it was left. */
  open(input: { text?: string; tags?: AskTag[]; view?: 'history'; entryId?: string; submit?: boolean } = {}): void {
    this.#subscribe()
    this.#staleRead = false
    this.#threadCandidates = null
    const { view, entryId, submit, ...fresh } = input
    this.#dispatch({ type: 'open', ...fresh })
    if (entryId !== undefined) {
      // A saved answer: the list is read (for its stale marks too) and the
      // entry opens in place of a question.
      this.#dispatch({ type: 'show-history' })
      void this.#readHistory(entryId)
      return
    }
    if (view === 'history') {
      this.#showHistory()
      return
    }
    if (submit === true && input.text !== undefined) {
      this.#submit(false)
      return
    }
    if (input.text !== undefined) this.#suggestFrom(input.text)
    if (this.#state.view === 'compose') {
      this.#textarea.focus()
      this.#textarea.setSelectionRange(this.#textarea.value.length, this.#textarea.value.length)
    }
  }

  close(): void {
    this.#unsubscribeState()
    this.#closePicker()
    this.#clearListTimer()
    this.#listSeq += 1
    this.#historySeq += 1
    this.#dispatch({ type: 'close' })
  }

  /**
   * A map cell pressed while the panel is open. In the question box it becomes
   * a chip; on an answer it starts a new question with that answer's tags plus
   * this one. While an answer is still coming nothing changes, and false says
   * so — the board then leaves the press alone.
   */
  addTagFromMap(tag: AskTag): boolean {
    const turn = currentTurn(this.#state)
    if (this.#state.view === 'answer' && turn !== null) {
      if (isRunning(turn)) return false
      const tags = [...turn.tags]
      if (!tags.some((existing) => existing.id === tag.id)) tags.push(tag)
      this.#dispatch({ type: 'new-question' })
      for (const existing of tags) this.#dispatch({ type: 'add-tag', tag: existing })
      this.#textarea.focus()
      return true
    }
    if (this.#state.view === 'history') this.#dispatch({ type: 'new-question' })
    this.#dispatch({ type: 'add-tag', tag })
    return true
  }

  dispose(): void {
    this.close()
    if (this.#copyTimer !== null) window.clearTimeout(this.#copyTimer)
    this.element.remove()
  }

  /* ── State plumbing ─────────────────────────────────────────────────── */

  #dispatch(event: AskPanelEvent): void {
    const next = reduceAsk(this.#state, event)
    if (next === this.#state) return
    this.#state = next
    this.#render()
    this.#host.onChange(next)
    this.#scheduleAskedBefore()
  }

  #subscribe(): void {
    if (this.#unsubscribe !== null) return
    this.#unsubscribe =
      window.flow.ask?.onState((event) => {
        if (event.rootId !== this.#host.rootId()) return
        if (!this.#state.turns.some((turn) => turn.askId === event.askId)) return
        this.#dispatch({ type: 'state', event, at: Date.now() })
      }) ?? null
  }

  #unsubscribeState(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  /* ── Asking ─────────────────────────────────────────────────────────── */

  #submit(followUp: boolean): void {
    const rootId = this.#host.rootId()
    if (rootId === null) return
    const question = followUp ? this.#followInput.value : this.#textarea.value
    if (question.trim() === '') return
    if (followUp && !canFollowUp(this.#state)) return
    const followUpOf = followUp ? followUpTarget(this.#state) : null
    const at = Date.now()
    const before = this.#state
    this.#dispatch({ type: 'submit', question, followUp, at })
    // The reducer refused (an empty question, a follow-up while one runs).
    if (this.#state === before) return
    const turn = currentTurn(this.#state)
    if (turn === null || turn.askId !== null || turn.startedAt !== at) return
    if (followUp) this.#followInput.value = ''
    else this.#textarea.value = ''
    this.#closePicker()
    void this.#start(rootId, turn, followUpOf)
  }

  async #start(rootId: string, turn: AskTurn, followUpOf: string | null): Promise<void> {
    const api = window.flow.ask
    if (api === undefined) {
      this.#dispatch({ type: 'start-failed', sentence: ASK_TIMEOUT_SENTENCE })
      return
    }
    try {
      const result = await api.start({
        rootId,
        question: turn.question,
        tags: mapTagIds(turn.tags),
        conversationIds: conversationTagIds(turn.tags),
        followUpOf,
      })
      // The person moved on (a new question) while main was answering.
      if (!this.#state.turns.includes(turn)) return
      if (result.ok) this.#dispatch({ type: 'started', askId: result.askId })
      else this.#dispatch({ type: 'start-failed', sentence: result.detail })
    } catch {
      this.#dispatch({ type: 'start-failed', sentence: ASK_TIMEOUT_SENTENCE })
    }
  }

  #stop(turn: AskTurn): void {
    if (turn.askId === null) return
    this.#dispatch({ type: 'stop' })
    void window.flow.ask?.stop({ askId: turn.askId }).catch(() => undefined)
  }

  #askAgain(turn: AskTurn): void {
    this.#dispatch({ type: 'open', text: turn.question, tags: turn.tags })
    this.#textarea.value = turn.question
    this.#submit(false)
  }

  #continueInConversation(): void {
    const turn = currentTurn(this.#state)
    if (turn === null) return
    document.dispatchEvent(new CustomEvent('flow:compose-prompt', { detail: { text: continuePrompt(turn) } }))
  }

  /* ── Saved questions ────────────────────────────────────────────────── */

  /** Re-read "asked before" when the tagged features change, in the question box only. */
  #scheduleAskedBefore(): void {
    if (!this.#state.open || this.#state.view !== 'compose') return
    const ids = mapTagIds(this.#state.tags)
    const key = ids.slice().sort().join('\n')
    if (key === this.#listedKey) return
    this.#listedKey = key
    this.#clearListTimer()
    if (ids.length === 0) {
      this.#listSeq += 1
      this.#dispatch({ type: 'asked-before', threads: [], stale: [] })
      return
    }
    this.#listTimer = window.setTimeout(() => {
      this.#listTimer = null
      void this.#readAskedBefore(ids)
    }, LIST_DEBOUNCE_MS)
  }

  #clearListTimer(): void {
    if (this.#listTimer !== null) window.clearTimeout(this.#listTimer)
    this.#listTimer = null
  }

  async #readAskedBefore(featureIds: string[]): Promise<void> {
    const rootId = this.#host.rootId()
    const api = window.flow.ask
    if (rootId === null || api === undefined) return
    const seq = ++this.#listSeq
    const [list, stale] = await Promise.all([
      api.list({ rootId, featureIds }).catch(() => null),
      this.#staleRead ? Promise.resolve(null) : api.stale({ rootId }).catch(() => null),
    ])
    if (seq !== this.#listSeq || !this.#state.open) return
    if (stale !== null && stale.ok) this.#staleRead = true
    this.#dispatch({
      type: 'asked-before',
      threads: list !== null && list.ok ? list.threads : [],
      stale: stale !== null && stale.ok ? stale.results : [],
    })
  }

  #showHistory(): void {
    this.#dispatch({ type: 'show-history' })
    void this.#readHistory()
  }

  async #readHistory(openId?: string): Promise<void> {
    const rootId = this.#host.rootId()
    const api = window.flow.ask
    if (rootId === null || api === undefined) return
    const tagged = mapTagIds(this.#state.tags)
    const featureIds = tagged.length > 0 ? tagged : this.#host.historyScope()
    const seq = ++this.#historySeq
    if (featureIds.length === 0) {
      this.#dispatch({ type: 'history', threads: [], stale: [] })
      return
    }
    const [list, stale] = await Promise.all([
      api.list({ rootId, featureIds }).catch(() => null),
      api.stale({ rootId }).catch(() => null),
    ])
    if (seq !== this.#historySeq || !this.#state.open) return
    if (list === null || !list.ok) {
      this.#dispatch({ type: 'history-failed', sentence: list?.detail ?? "Saved questions couldn't be read." })
      return
    }
    this.#dispatch({ type: 'history', threads: list.threads, stale: stale !== null && stale.ok ? stale.results : [] })
    const wanted = openId === undefined ? undefined : list.threads.find((thread) => thread.id === openId)
    if (wanted !== undefined) this.#dispatch({ type: 'open-saved', thread: wanted })
  }

  /* ── Typing, pasting and the @ picker ───────────────────────────────── */

  #onInput(event: InputEvent): void {
    const text = this.#textarea.value
    this.#dispatch({ type: 'draft', text })
    if (event.inputType === 'insertFromPaste') this.#suggestFrom(text)
    this.#updatePicker()
  }

  #suggestFrom(text: string): void {
    const exclude = new Set(this.#state.tags.map((tag) => tag.id))
    const suggestions = suggestTags(text, this.#host.graphNodes(), { exclude })
    this.#dispatch({ type: 'suggest', suggestions })
  }

  #updatePicker(): void {
    const mention = activeMention(this.#textarea.value, this.#textarea.selectionStart ?? this.#textarea.value.length)
    if (mention === null) {
      this.#closePicker()
      return
    }
    if (this.#threadCandidates === null && !this.#threadsLoading) void this.#loadThreads()
    const candidates = [...graphCandidates(this.#host.graphNodes()), ...(this.#threadCandidates ?? [])]
    const exclude = new Set(this.#state.tags.map((tag) => tag.id))
    this.#pickerRows = pickerMatches(mention.query, candidates, { exclude })
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerRows.length - 1))
    this.#paintPicker()
  }

  async #loadThreads(): Promise<void> {
    const rootId = this.#host.rootId()
    if (rootId === null) return
    this.#threadsLoading = true
    try {
      const threads = await window.flow.threads.list({ projectRoot: rootId, limit: THREAD_PICKER_LIMIT })
      this.#threadCandidates = threads.map((thread) => ({
        id: thread.id,
        kind: 'conversation' as const,
        label: thread.title.trim() === '' ? 'Untitled conversation' : thread.title,
        hint: `Conversation · ${ageLabel(thread.updatedAt, Date.now())}`,
      }))
    } catch {
      this.#threadCandidates = []
    } finally {
      this.#threadsLoading = false
    }
    if (!this.#picker.hidden) this.#updatePicker()
  }

  #paintPicker(): void {
    this.#picker.replaceChildren()
    if (this.#pickerRows.length === 0) {
      this.#picker.appendChild(el('div', 'fb-ask-picker-empty', 'Nothing by that name.'))
    }
    this.#pickerRows.forEach((row, index) => {
      const item = el('button', `fb-ask-picker-row${index === this.#pickerIndex ? ' on' : ''}`)
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(index === this.#pickerIndex))
      const kind = el('span', 'fb-ask-picker-kind', row.kind === 'conversation' ? 'conversation' : row.kind)
      const label = el('span', 'fb-ask-picker-label', row.label)
      item.append(label, kind)
      if (row.hint !== undefined) item.title = row.hint
      // mousedown, so the textarea's blur does not close the list first.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.#pick(row)
      })
      this.#picker.appendChild(item)
    })
    this.#picker.hidden = false
  }

  #closePicker(): void {
    this.#picker.hidden = true
    this.#pickerRows = []
    this.#pickerIndex = 0
  }

  #pick(row: PickerCandidate): void {
    const text = this.#textarea.value
    const caret = this.#textarea.selectionStart ?? text.length
    const mention = activeMention(text, caret)
    if (mention !== null) {
      const next = `${text.slice(0, mention.start)}${text.slice(caret)}`.replace(/ {2,}/g, ' ')
      this.#textarea.value = next
      this.#textarea.setSelectionRange(mention.start, mention.start)
      this.#dispatch({ type: 'draft', text: next })
    }
    this.#dispatch({ type: 'add-tag', tag: { id: row.id, kind: row.kind, label: row.label } })
    this.#closePicker()
    this.#textarea.focus()
  }

  #onKeydown(event: KeyboardEvent): void {
    const pickerOpen = !this.#picker.hidden && this.#pickerRows.length > 0
    if (event.target === this.#textarea && pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        const step = event.key === 'ArrowDown' ? 1 : -1
        this.#pickerIndex = (this.#pickerIndex + step + this.#pickerRows.length) % this.#pickerRows.length
        this.#paintPicker()
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        const row = this.#pickerRows[this.#pickerIndex]
        if (row !== undefined) this.#pick(row)
        return
      }
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      if (!this.#picker.hidden) this.#closePicker()
      else this.close()
      return
    }
    if (event.target === this.#textarea && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      this.#submit(false)
      return
    }
    // Typing in the panel never reaches the board's own shortcuts; the app's
    // modifier shortcuts (the palette and the like) still do.
    if (!event.metaKey && !event.ctrlKey) event.stopPropagation()
  }

  /* ── Dragging ───────────────────────────────────────────────────────── */

  #wireDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (event) => {
      if ((event.target as Element).closest('button') !== null) return
      const parent = this.element.offsetParent as HTMLElement | null
      if (parent === null) return
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const left = this.element.offsetLeft
      const top = this.element.offsetTop
      const move = (moveEvent: PointerEvent): void => {
        const maxLeft = Math.max(0, parent.clientWidth - this.element.offsetWidth)
        const maxTop = Math.max(0, parent.clientHeight - 48)
        const nextLeft = Math.min(maxLeft, Math.max(0, left + moveEvent.clientX - startX))
        const nextTop = Math.min(maxTop, Math.max(0, top + moveEvent.clientY - startY))
        this.element.style.left = `${nextLeft}px`
        this.element.style.top = `${nextTop}px`
        this.element.style.right = 'auto'
      }
      const up = (): void => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
    })
  }

  /* ── Rendering ──────────────────────────────────────────────────────── */

  #render(): void {
    const state = this.#state
    this.element.hidden = !state.open
    if (!state.open) return
    this.#backBtn.hidden = state.view === 'compose'
    this.#historyBtn.hidden = state.view === 'history'
    this.#compose.hidden = state.view !== 'compose'
    this.#answer.hidden = state.view !== 'answer'
    this.#history.hidden = state.view !== 'history'
    this.#footer.hidden = state.view !== 'answer'
    if (this.#textarea.value !== state.draft) this.#textarea.value = state.draft
    if (state.view === 'compose') this.#renderCompose()
    if (state.view === 'answer') this.#renderAnswer()
    if (state.view === 'history') this.#renderHistory()
  }

  #renderCompose(): void {
    const state = this.#state
    this.#chips.replaceChildren()
    for (const tag of state.tags) this.#chips.appendChild(this.#chip(tag, true))
    this.#chips.hidden = state.tags.length === 0
    this.#askBtn.disabled = state.draft.trim() === '' || this.#host.rootId() === null

    this.#suggestions.replaceChildren()
    this.#suggestions.hidden = state.suggestions.length === 0
    if (state.suggestions.length > 0) {
      this.#suggestions.appendChild(el('div', 'fb-ask-suggest-head', 'Your message mentions these. Add them?'))
      const row = el('div', 'fb-ask-suggest-row')
      for (const suggestion of state.suggestions) {
        row.appendChild(
          button('fb-ask-suggest-chip', `+ ${suggestion.label}`, () =>
            this.#dispatch({ type: 'accept-suggestion', id: suggestion.id }),
          ),
        )
      }
      const actions = el('div', 'fb-ask-suggest-actions')
      actions.append(
        button('fb-ask-secondary fb-ask-small', 'Add all', () => this.#dispatch({ type: 'accept-all-suggestions' })),
        button('fb-ask-quiet fb-ask-small', 'Dismiss', () => this.#dispatch({ type: 'dismiss-suggestions' })),
      )
      this.#suggestions.append(row, actions)
    }

    this.#askedBefore.replaceChildren()
    this.#askedBefore.hidden = state.askedBefore.length === 0
    if (state.askedBefore.length > 0) {
      this.#askedBefore.appendChild(el('div', 'fb-ask-caps', 'Asked before about these features'))
      for (const thread of state.askedBefore.slice(0, 5)) this.#askedBefore.appendChild(this.#savedRow(thread))
    }
  }

  #chip(tag: AskTag, removable: boolean): HTMLElement {
    const chip = el('span', `fb-ask-chip fb-ask-chip-${tag.kind === 'conversation' ? 'conv' : 'map'}`)
    if (tag.kind === 'conversation') chip.appendChild(icon(ICON_CHAT, 11))
    else chip.appendChild(el('span', 'fb-ask-chip-dot'))
    chip.appendChild(document.createTextNode(tag.kind === 'conversation' ? `Conversation: ${tag.label}` : tag.label))
    if (removable) {
      const remove = button('fb-ask-chip-x', '×', () => this.#dispatch({ type: 'remove-tag', id: tag.id }), `Remove ${tag.label}`)
      chip.appendChild(remove)
    }
    return chip
  }

  #savedRow(thread: AskSavedThread): HTMLElement {
    const row = button('fb-ask-saved-row', '', () => this.#dispatch({ type: 'open-saved', thread }))
    row.appendChild(el('span', 'fb-ask-saved-q', thread.question))
    const stale = this.#state.staleIds.includes(thread.id)
    const meta = stale
      ? el('span', 'fb-ask-saved-meta fb-ask-warn-text', 'code changed since')
      : el('span', 'fb-ask-saved-meta', [thread.author, ageLabel(thread.ts, Date.now())].filter((part) => part !== '').join(' · '))
    row.appendChild(meta)
    return row
  }

  #renderHistory(): void {
    const state = this.#state
    this.#history.replaceChildren()
    this.#history.appendChild(el('div', 'fb-ask-caps', 'Saved questions'))
    if (state.historyError !== null) {
      this.#history.appendChild(el('p', 'fb-ask-error', state.historyError))
      return
    }
    if (state.history === null) {
      this.#history.appendChild(el('p', 'fb-ask-muted', 'Reading saved questions…'))
      return
    }
    if (state.history.length === 0) {
      this.#history.appendChild(el('p', 'fb-ask-muted', 'Nobody has asked about these features yet.'))
      return
    }
    for (const thread of state.history) this.#history.appendChild(this.#savedRow(thread))
  }

  #renderAnswer(): void {
    const state = this.#state
    this.#answer.replaceChildren()
    state.turns.forEach((turn, index) => {
      this.#answer.appendChild(this.#turnView(turn, index === state.turns.length - 1))
    })
    const last = currentTurn(state)
    this.#followInput.disabled = !canFollowUp(state)
    this.#followInput.placeholder =
      last !== null && isRunning(last) ? 'You can follow up when this answer is ready' : 'Ask a follow-up…'
    this.#continueBtn.disabled = last === null || last.answer === null
  }

  #turnView(turn: AskTurn, newest: boolean): HTMLElement {
    const wrap = el('div', 'fb-ask-turn')

    // The question, as a bubble, with what it was asked about.
    const bubble = el('div', 'fb-ask-bubble')
    bubble.appendChild(el('div', 'fb-ask-bubble-text', turn.question))
    const mapTags = turn.tags.filter((tag) => tag.kind !== 'conversation')
    const conversations = turn.tags.length - mapTags.length
    if (turn.tags.length > 0) {
      const tags = el('div', 'fb-ask-bubble-tags')
      for (const tag of mapTags) tags.appendChild(el('span', 'fb-ask-mini fb-ask-mini-map', tag.label))
      if (conversations > 0) {
        tags.appendChild(el('span', 'fb-ask-mini', `${conversations} conversation${conversations === 1 ? '' : 's'}`))
      }
      bubble.appendChild(tags)
    }
    wrap.appendChild(bubble)

    const answer = turn.answer
    if (answer === null && (turn.phase === 'fast' || turn.phase === 'digging')) {
      wrap.appendChild(el('p', 'fb-ask-muted fb-ask-pending', 'Looking at what Flow already knows…'))
    }

    if (answer !== null) {
      wrap.appendChild(this.#badgeRow(turn))
      if (turn.saved !== null && turn.saved.stale) {
        const stale = el('div', 'fb-ask-stale')
        stale.appendChild(el('span', '', 'The code under this answer changed since.'))
        stale.appendChild(button('fb-ask-secondary fb-ask-small', 'Ask again', () => this.#askAgain(turn)))
        wrap.appendChild(stale)
      }
      wrap.appendChild(this.#explanation(answer.explanation, answer.thin && answer.confidence === 'first' && isRunning(turn)))
    }

    if (newest && turn.phase === 'digging') wrap.appendChild(this.#diggingCard(turn))
    if (newest && turn.phase === 'fast' && turn.stopping) wrap.appendChild(el('p', 'fb-ask-muted', 'Stopping…'))

    if (answer !== null) {
      if (answer.couldNotFind !== undefined && !isRunning(turn)) {
        wrap.appendChild(el('p', 'fb-ask-muted', answer.couldNotFind))
      }
      if (answer.verdict !== undefined || answer.branchInProgress !== undefined) wrap.appendChild(this.#verdictCard(answer.verdict, answer.branchInProgress))
      if (answer.reply !== undefined && answer.reply.trim() !== '') wrap.appendChild(this.#replyCard(answer.reply))
      if (answer.sources.length > 0) wrap.appendChild(this.#sourcesList(answer.sources))
      if (!isRunning(turn)) {
        const foot = this.#answerFoot(turn)
        if (foot !== null) wrap.appendChild(foot)
      }
    }

    if (turn.phase === 'error' && turn.error !== null) wrap.appendChild(el('p', 'fb-ask-error', turn.error))
    return wrap
  }

  #badgeRow(turn: AskTurn): HTMLElement {
    const row = el('div', 'fb-ask-badges')
    const answer = turn.answer
    if (answer === null) return row
    let badge: HTMLElement
    let meta = ''
    if (turn.saved !== null) {
      badge = el('span', 'fb-ask-badge fb-ask-badge-saved', 'Saved answer')
      meta = [turn.saved.author, ageLabel(turn.saved.ts, Date.now())].filter((part) => part !== '').join(' · ')
    } else if (answer.partial || turn.phase === 'partial') {
      badge = el('span', 'fb-ask-badge fb-ask-badge-first')
      badge.append(el('span', 'fb-ask-badge-dot'), document.createTextNode('Partial · the code check did not finish'))
    } else if (answer.confidence === 'checked') {
      badge = el('span', 'fb-ask-badge fb-ask-badge-checked')
      badge.append(icon(ICON_CHECK, 11), document.createTextNode('Checked against the code'))
      if (turn.changedFromFirst) meta = 'changed from the first answer'
    } else {
      badge = el('span', 'fb-ask-badge fb-ask-badge-first')
      badge.append(el('span', 'fb-ask-badge-dot'), document.createTextNode('First answer · from what Flow already knows'))
    }
    if (turn.saved === null && turn.answeredAfterMs !== null) {
      meta = meta === '' ? durationLabel(turn.answeredAfterMs) : `${meta} · ${durationLabel(turn.answeredAfterMs)}`
    }
    row.appendChild(badge)
    if (meta !== '') row.appendChild(el('span', 'fb-ask-badge-meta', meta))
    return row
  }

  /** The explanation, with each [n] a link to source n. */
  #explanation(text: string, thin: boolean): HTMLElement {
    const box = el('div', 'fb-ask-explain')
    const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter((part) => part !== '')
    for (const paragraph of paragraphs) {
      const p = el('p')
      for (const piece of paragraph.split(/(\[\d+\])/)) {
        const ref = /^\[(\d+)\]$/.exec(piece)
        if (ref === null) {
          p.appendChild(document.createTextNode(piece))
          continue
        }
        const n = ref[1] ?? ''
        const link = button('fb-ask-ref', `[${n}]`, () => this.#focusSource(n), `Source ${n}`)
        p.appendChild(link)
      }
      box.appendChild(p)
    }
    if (thin) box.appendChild(el('p', 'fb-ask-muted', 'What Flow knows about this is thin, so this answer may change.'))
    return box
  }

  #focusSource(n: string): void {
    const row = this.#answer.querySelector<HTMLElement>(`[data-source-n="${CSS.escape(n)}"]`)
    if (row === null) return
    row.scrollIntoView({ block: 'nearest' })
    row.focus()
  }

  #diggingCard(turn: AskTurn): HTMLElement {
    const card = el('div', 'fb-ask-dig')
    const head = el('div', 'fb-ask-dig-head')
    const spin = icon(ICON_SPIN)
    spin.classList.add('fb-ask-spin')
    head.append(spin, el('span', 'fb-ask-dig-title', turn.stopping ? 'Stopping…' : 'Digging into the code…'), el('span', 'fb-ask-spacer'))
    const stop = button('fb-ask-secondary fb-ask-small', 'Stop here', () => this.#stop(turn))
    stop.disabled = turn.stopping || turn.askId === null
    head.appendChild(stop)
    card.appendChild(head)
    if (turn.steps.length > 0) {
      const steps = el('div', 'fb-ask-steps')
      for (const step of turn.steps) {
        const line = el('div', `fb-ask-step fb-ask-step-${step.state}`)
        if (step.state === 'done') line.appendChild(icon(ICON_CHECK, 11))
        line.appendChild(document.createTextNode(step.label))
        steps.appendChild(line)
      }
      card.appendChild(steps)
    }
    const facts: string[] = []
    if (turn.reads > 0) facts.push(`${turn.reads} file${turn.reads === 1 ? '' : 's'} read`)
    if (turn.digElapsedMs > 0) facts.push(durationLabel(turn.digElapsedMs))
    const note = turn.answer !== null ? 'The answer above updates when this finishes.' : 'The answer appears here when this finishes.'
    card.appendChild(el('div', 'fb-ask-dig-note', facts.length > 0 ? `${note} ${facts.join(' · ')}` : note))
    return card
  }

  #verdictCard(verdict: { label: string; risk?: string } | undefined, branch: string | undefined): HTMLElement {
    const card = el('div', 'fb-ask-verdict')
    if (verdict !== undefined) {
      const head = el('div', 'fb-ask-verdict-head')
      head.append(el('span', 'fb-ask-caps', 'Can we build it?'), el('span', 'fb-ask-verdict-label', verdict.label))
      card.appendChild(head)
      if (verdict.risk !== undefined && verdict.risk.trim() !== '') card.appendChild(el('div', 'fb-ask-verdict-risk', verdict.risk))
    }
    if (branch !== undefined) {
      const line = el('div', 'fb-ask-branch')
      line.append(icon(ICON_BRANCH, 12), document.createTextNode(branch))
      card.appendChild(line)
    }
    return card
  }

  #replyCard(reply: string): HTMLElement {
    const card = el('div', 'fb-ask-card fb-ask-reply')
    const head = el('div', 'fb-ask-reply-head')
    const copy = button('fb-ask-secondary fb-ask-small', 'Copy', () => {
      void navigator.clipboard
        .writeText(reply)
        .then(() => {
          copy.textContent = 'Copied'
          if (this.#copyTimer !== null) window.clearTimeout(this.#copyTimer)
          this.#copyTimer = window.setTimeout(() => {
            copy.textContent = 'Copy'
          }, 1500)
        })
        .catch(() => {
          copy.textContent = "Couldn't copy"
        })
    })
    head.append(el('span', 'fb-ask-caps', 'Reply ready to send'), el('span', 'fb-ask-spacer'), copy)
    card.append(head, el('div', 'fb-ask-reply-text', reply))
    return card
  }

  #sourcesList(sources: AskSource[]): HTMLElement {
    const list = el('div', 'fb-ask-sources')
    list.appendChild(el('div', 'fb-ask-caps', 'Sources'))
    sources.forEach((source, index) => {
      const n = source.n ?? null
      const row = el('button', 'fb-ask-source')
      row.type = 'button'
      if (n !== null) row.dataset['sourceN'] = String(n)
      row.append(el('span', 'fb-ask-source-n', n === null ? '·' : String(n)), el('span', 'fb-ask-source-label', source.label))
      if (source.file !== undefined) {
        row.appendChild(el('span', 'fb-ask-source-file', baseName(source.file)))
        row.title = `Open ${baseName(source.file)}`
        const file = source.file
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#host.peekFile(file)
        })
      } else {
        row.appendChild(el('span', 'fb-ask-source-know', 'from knowledge'))
        row.tabIndex = n === null ? -1 : 0
      }
      row.dataset['index'] = String(index)
      list.appendChild(row)
    })
    return list
  }

  #answerFoot(turn: AskTurn): HTMLElement | null {
    const answer = turn.answer
    if (answer === null) return null
    const lines: HTMLElement[] = []
    if (answer.factsLearned > 0) {
      const line = el('div')
      line.append(
        el('span', 'fb-ask-good-text', `${answer.factsLearned} fact${answer.factsLearned === 1 ? '' : 's'} learned`),
        document.createTextNode(', now part of what Flow knows.'),
      )
      lines.push(line)
    }
    if (!answer.factsSaved) lines.push(el('div', 'fb-ask-warn-text', "The facts this answer found couldn't be saved. The answer stands."))
    if (turn.saved === null && answer.savedId !== undefined) {
      const labels = turn.tags.filter((tag) => tag.kind !== 'conversation').map((tag) => tag.label)
      let text = labels.length > 0 ? `Saved on ${listLabel(labels)}, where your team can find it.` : 'Saved, where your team can find it.'
      if (turn.tags.some((tag) => tag.kind === 'conversation')) text += ' Used one of your conversations (its content stays private).'
      lines.push(el('div', '', text))
    } else if (turn.saved !== null && turn.saved.usedConversation) {
      lines.push(el('div', '', 'Used one of its author’s conversations (its content stays private).'))
    }
    if (lines.length === 0) return null
    const foot = el('div', 'fb-ask-answer-foot')
    foot.append(...lines)
    return foot
  }
}

/* ── The map's marks ──────────────────────────────────────────────────── */

const MARK_CLASSES = ['fb-terr-ask-tagged', 'fb-terr-ask-mentioned'] as const
const LIVE_WORDS: Record<NonNullable<AskCellMark['live']>, string> = {
  read: 'read now',
  reading: 'reading code…',
  thin: 'thin knowledge',
}

/**
 * Draw (or clear, with null) one cell's Ask marks: the outline, the live
 * state, the source numbers and the facts chip. The board calls this for
 * every drawn cell when the decoration changes, and never otherwise.
 */
export function paintCellMarks(cell: HTMLElement, mark: AskCellMark | null): void {
  cell.classList.remove(...MARK_CLASSES)
  cell.querySelector(':scope > .fb-terr-ask-marks')?.remove()
  if (mark === null) return
  if (mark.role !== null) cell.classList.add(`fb-terr-ask-${mark.role}`)
  const chips: HTMLElement[] = []
  if (mark.role === 'tagged' && mark.live === null && mark.numbers.length === 0) {
    chips.push(el('span', 'fb-terr-ask-chip fb-terr-ask-chip-tag', 'tagged'))
  }
  if (mark.role === 'mentioned' && mark.numbers.length === 0 && mark.live === null) {
    chips.push(el('span', 'fb-terr-ask-chip fb-terr-ask-chip-mention', 'mentioned in the answer'))
  }
  if (mark.live !== null) chips.push(el('span', `fb-terr-ask-chip fb-terr-ask-live-${mark.live}`, LIVE_WORDS[mark.live]))
  for (const { n, label } of mark.numbers) chips.push(el('span', 'fb-terr-ask-chip', `${n} · ${label}`))
  if (mark.facts > 0) chips.push(el('span', 'fb-terr-ask-chip fb-terr-ask-chip-facts', `+${mark.facts} fact${mark.facts === 1 ? '' : 's'} learned`))
  if (chips.length === 0) return
  const box = el('div', 'fb-terr-ask-marks')
  box.setAttribute('aria-hidden', 'true')
  box.append(...chips)
  cell.appendChild(box)
}

/* ── Styles ───────────────────────────────────────────────────────────── */

let askStylesInjected = false

function injectAskStyles(): void {
  if (askStylesInjected) return
  askStylesInjected = true
  const style = document.createElement('style')
  style.textContent = ASK_STYLES
  document.head.appendChild(style)
}

// NO BACKTICKS IN HERE — this whole sheet is one template literal.
const ASK_STYLES = `
  /* The panel is placed against the board itself, wherever the board sits. */
  .flow-board-root { position: relative; }
  .flow-board-root .fb-ask {
    --fb-ask-good: var(--fb-learn-known);
    --fb-ask-warn: var(--fb-warn);
    position: absolute;
    top: 52px;
    right: var(--fl-space-lg, 16px);
    width: 480px;
    max-width: calc(100% - 32px);
    max-height: calc(100% - 68px);
    z-index: 13;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--fb-card);
    color: var(--fb-ink);
    border: 1px solid var(--fb-card-border);
    border-radius: var(--fl-radius-lg, 12px);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    font-family: var(--fl-font-ui, system-ui, sans-serif);
    font-size: 13px;
  }
  .flow-board-root .fb-ask[hidden] { display: none; }
  .flow-board-root .fb-ask [hidden] { display: none !important; }
  .flow-board-root .fb-ask-head {
    height: 44px;
    flex: 0 0 auto;
    box-sizing: border-box;
    padding: 0 var(--fl-space-md, 12px);
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    border-bottom: 1px solid var(--fb-border);
    cursor: grab;
    user-select: none;
  }
  .flow-board-root .fb-ask-title { font-weight: 600; font-size: 14px; }
  .flow-board-root .fb-ask-spacer { flex: 1; }
  .flow-board-root .fb-ask-icon-btn {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-row, 6px);
    color: var(--fb-ink-dim);
    cursor: pointer;
  }
  .flow-board-root .fb-ask-icon-btn:hover { background: var(--fb-paper); color: var(--fb-ink); }
  .flow-board-root .fb-ask-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--fl-space-md, 12px) 14px;
  }
  .flow-board-root .fb-ask-compose,
  .flow-board-root .fb-ask-answer,
  .flow-board-root .fb-ask-history,
  .flow-board-root .fb-ask-turn {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-md, 12px);
  }
  .flow-board-root .fb-ask-answer { gap: var(--fl-space-lg, 16px); }
  .flow-board-root .fb-ask-intro,
  .flow-board-root .fb-ask-muted { margin: 0; color: var(--fb-ink-dim); font-size: 12px; line-height: 1.5; }
  .flow-board-root .fb-ask-box-wrap { position: relative; }
  .flow-board-root .fb-ask-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: var(--fl-space-md, 12px);
    background: var(--fb-paper);
    border: 1px solid var(--fb-border);
    border-radius: 10px;
  }
  .flow-board-root .fb-ask-box:focus-within { border-color: var(--fb-accent); }
  .flow-board-root .fb-ask-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .flow-board-root .fb-ask-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 var(--fl-space-sm, 8px);
    border-radius: var(--fl-radius-row, 6px);
    font-size: 12px;
  }
  .flow-board-root .fb-ask-chip-map {
    background: color-mix(in srgb, var(--fb-ask-good) 20%, transparent);
    color: var(--fb-ask-good);
  }
  .flow-board-root .fb-ask-chip-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--fb-ask-good); }
  .flow-board-root .fb-ask-chip-conv {
    background: var(--fb-card);
    border: 1px solid var(--fb-border);
    color: var(--fb-ink);
  }
  .flow-board-root .fb-ask-chip-x {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.8;
  }
  .flow-board-root .fb-ask-chip-x:hover { opacity: 1; }
  .flow-board-root .fb-ask-input {
    width: 100%;
    min-height: 56px;
    max-height: 200px;
    box-sizing: border-box;
    resize: vertical;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fb-ink);
    font: inherit;
    line-height: 1.55;
    outline: none;
  }
  .flow-board-root .fb-ask-input::placeholder { color: var(--fb-ink-dim); }
  .flow-board-root .fb-ask-box-foot { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); }
  .flow-board-root .fb-ask-hint { color: var(--fb-ink-dim); font-size: 12px; }
  .flow-board-root .fb-ask-primary {
    height: 30px;
    padding: 0 14px;
    background: var(--fb-accent);
    border: 0;
    border-radius: 7px;
    color: #ffffff;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-primary:disabled { opacity: 0.5; cursor: default; }
  .flow-board-root .fb-ask-secondary {
    height: 30px;
    padding: 0 var(--fl-space-md, 12px);
    background: var(--fb-paper);
    border: 1px solid var(--fb-border);
    border-radius: var(--fl-radius-row, 6px);
    color: var(--fb-ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .flow-board-root .fb-ask-secondary:hover:not(:disabled) { border-color: var(--fb-accent); }
  .flow-board-root .fb-ask-secondary:disabled { opacity: 0.5; cursor: default; }
  .flow-board-root .fb-ask-quiet {
    background: transparent;
    border: 0;
    color: var(--fb-ink-dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-small { height: 24px; padding: 0 10px; }
  .flow-board-root .fb-ask-picker {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 4px);
    z-index: 2;
    max-height: 240px;
    overflow-y: auto;
    padding: var(--fl-space-xs, 4px);
    background: var(--fb-card);
    border: 1px solid var(--fb-card-border);
    border-radius: var(--fl-radius-md, 8px);
    box-shadow: var(--fl-shadow-md, 0 4px 14px rgba(0, 0, 0, 0.45));
  }
  .flow-board-root .fb-ask-picker-row {
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    width: 100%;
    padding: 6px var(--fl-space-sm, 8px);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-row, 6px);
    color: var(--fb-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-picker-row.on,
  .flow-board-root .fb-ask-picker-row:hover { background: var(--fb-paper); }
  .flow-board-root .fb-ask-picker-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flow-board-root .fb-ask-picker-kind,
  .flow-board-root .fb-ask-caps {
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fb-ink-dim);
  }
  .flow-board-root .fb-ask-picker-empty { padding: 6px var(--fl-space-sm, 8px); color: var(--fb-ink-dim); font-size: 12px; }
  .flow-board-root .fb-ask-card {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-sm, 8px);
    padding: 10px var(--fl-space-md, 12px);
    background: var(--fb-paper);
    border: 1px solid var(--fb-border);
    border-radius: 10px;
  }
  .flow-board-root .fb-ask-suggest-head { font-size: 12px; color: var(--fb-ink); }
  .flow-board-root .fb-ask-suggest-row,
  .flow-board-root .fb-ask-suggest-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .flow-board-root .fb-ask-suggest-chip {
    height: 26px;
    padding: 0 var(--fl-space-sm, 8px);
    background: transparent;
    border: 1px dashed var(--fb-card-border);
    border-radius: var(--fl-radius-row, 6px);
    color: var(--fb-ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-suggest-chip:hover { border-color: var(--fb-ask-good); color: var(--fb-ask-good); }
  .flow-board-root .fb-ask-before {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px var(--fl-space-md, 12px);
    border: 1px solid var(--fb-border);
    border-radius: 10px;
  }
  .flow-board-root .fb-ask-saved-row {
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    padding: 6px 0;
    background: transparent;
    border: 0;
    color: var(--fb-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-saved-row:hover .fb-ask-saved-q { color: var(--fb-accent); }
  .flow-board-root .fb-ask-saved-q { flex: 1; min-width: 0; }
  .flow-board-root .fb-ask-saved-meta { flex: 0 0 auto; color: var(--fb-ink-dim); font-size: 12px; }
  .flow-board-root .fb-ask-warn-text { color: var(--fb-ask-warn); }
  .flow-board-root .fb-ask-good-text { color: var(--fb-ask-good); }
  .flow-board-root .fb-ask-bubble {
    align-self: flex-end;
    max-width: 88%;
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-sm, 8px);
    padding: 10px var(--fl-space-md, 12px);
    background: var(--fb-paper);
    border-radius: 10px;
  }
  .flow-board-root .fb-ask-bubble-text { line-height: 1.5; white-space: pre-wrap; }
  .flow-board-root .fb-ask-bubble-tags { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs, 4px); }
  .flow-board-root .fb-ask-mini {
    padding: 1px 6px;
    border-radius: var(--fl-radius-sm, 4px);
    background: var(--fb-card);
    color: var(--fb-ink);
    font-size: 11px;
  }
  .flow-board-root .fb-ask-mini-map {
    background: color-mix(in srgb, var(--fb-ask-good) 20%, transparent);
    color: var(--fb-ask-good);
  }
  .flow-board-root .fb-ask-badges { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); flex-wrap: wrap; }
  .flow-board-root .fb-ask-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 var(--fl-space-sm, 8px);
    border-radius: 11px;
    font-size: 11px;
    font-weight: 500;
  }
  .flow-board-root .fb-ask-badge-first {
    background: color-mix(in srgb, var(--fb-ask-warn) 18%, transparent);
    color: var(--fb-ask-warn);
  }
  .flow-board-root .fb-ask-badge-checked {
    background: color-mix(in srgb, var(--fb-ask-good) 18%, transparent);
    color: var(--fb-ask-good);
  }
  .flow-board-root .fb-ask-badge-saved { background: var(--fb-paper); color: var(--fb-ink); }
  .flow-board-root .fb-ask-badge-dot { width: 6px; height: 6px; border-radius: 3px; background: currentColor; }
  .flow-board-root .fb-ask-badge-meta { color: var(--fb-ink-dim); font-size: 11px; }
  .flow-board-root .fb-ask-stale {
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    padding: var(--fl-space-sm, 8px) 10px;
    border-radius: var(--fl-radius-md, 8px);
    background: color-mix(in srgb, var(--fb-ask-warn) 12%, transparent);
    color: var(--fb-ask-warn);
    font-size: 12px;
  }
  .flow-board-root .fb-ask-stale > span { flex: 1; }
  .flow-board-root .fb-ask-explain { line-height: 1.6; color: var(--fb-ink); }
  .flow-board-root .fb-ask-explain p { margin: 0 0 var(--fl-space-sm, 8px); }
  .flow-board-root .fb-ask-explain p:last-child { margin-bottom: 0; }
  .flow-board-root .fb-ask-ref {
    padding: 0 1px;
    background: none;
    border: 0;
    color: var(--fb-accent);
    font: inherit;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-ref:hover { text-decoration: underline; }
  .flow-board-root .fb-ask-dig,
  .flow-board-root .fb-ask-verdict {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-sm, 8px);
    padding: var(--fl-space-md, 12px);
    background: color-mix(in srgb, var(--fb-accent) 8%, var(--fb-card));
    border: 1px solid color-mix(in srgb, var(--fb-accent) 35%, var(--fb-border));
    border-radius: 10px;
  }
  .flow-board-root .fb-ask-verdict { padding: 10px var(--fl-space-md, 12px); gap: 6px; }
  .flow-board-root .fb-ask-dig-head { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); color: var(--fb-accent); }
  .flow-board-root .fb-ask-dig-title { font-weight: 500; color: var(--fb-ink); }
  .flow-board-root .fb-ask-spin { animation: fb-ask-spin 1s linear infinite; }
  @keyframes fb-ask-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .flow-board-root .fb-ask-spin { animation: none; } }
  .flow-board-root .fb-ask-steps { display: flex; flex-direction: column; gap: 6px; padding-left: 22px; font-size: 12px; }
  .flow-board-root .fb-ask-step { display: flex; align-items: center; gap: 6px; }
  .flow-board-root .fb-ask-step-done { color: var(--fb-ask-good); }
  .flow-board-root .fb-ask-step-current { color: var(--fb-ink); }
  .flow-board-root .fb-ask-dig-note { padding-left: 22px; font-size: 12px; color: var(--fb-ink-dim); }
  .flow-board-root .fb-ask-verdict-head { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); }
  .flow-board-root .fb-ask-verdict-label {
    padding: 2px var(--fl-space-sm, 8px);
    border-radius: var(--fl-radius-sm, 4px);
    background: color-mix(in srgb, var(--fb-accent) 22%, transparent);
    color: var(--fb-accent);
    font-size: 12px;
    font-weight: 500;
  }
  .flow-board-root .fb-ask-verdict-risk { line-height: 1.5; color: var(--fb-ink); }
  .flow-board-root .fb-ask-branch { display: flex; align-items: center; gap: 6px; color: var(--fb-ask-warn); font-size: 12px; }
  .flow-board-root .fb-ask-reply-head { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); }
  .flow-board-root .fb-ask-reply-text { line-height: 1.5; white-space: pre-wrap; }
  .flow-board-root .fb-ask-sources { display: flex; flex-direction: column; gap: 2px; }
  .flow-board-root .fb-ask-source {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-sm, 8px);
    padding: var(--fl-space-xs, 4px) 0;
    background: transparent;
    border: 0;
    color: var(--fb-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-source:focus-visible { outline: 2px solid var(--fb-accent); outline-offset: 1px; }
  .flow-board-root .fb-ask-source-n { color: var(--fb-ink-dim); min-width: 1em; }
  .flow-board-root .fb-ask-source-file {
    color: var(--fb-ink-dim);
    font-family: var(--fl-font-mono, ui-monospace, monospace);
    font-size: 11px;
  }
  .flow-board-root .fb-ask-source-know { color: var(--fb-ink-dim); font-size: 11px; }
  .flow-board-root .fb-ask-answer-foot {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-xs, 4px);
    padding: var(--fl-space-sm, 8px) 10px 0;
    border-top: 1px solid var(--fb-border);
    font-size: 12px;
    color: var(--fb-ink-dim);
  }
  .flow-board-root .fb-ask-error { margin: 0; color: var(--fb-danger); font-size: 12px; line-height: 1.5; }
  .flow-board-root .fb-ask-foot {
    flex: 0 0 auto;
    display: flex;
    gap: var(--fl-space-sm, 8px);
    padding: var(--fl-space-md, 12px) 14px;
    border-top: 1px solid var(--fb-border);
  }
  .flow-board-root .fb-ask-follow {
    flex: 1;
    min-width: 0;
    height: 36px;
    box-sizing: border-box;
    padding: 0 var(--fl-space-md, 12px);
    background: var(--fb-paper);
    border: 1px solid var(--fb-border);
    border-radius: var(--fl-radius-md, 8px);
    color: var(--fb-ink);
    font: inherit;
    outline: none;
  }
  .flow-board-root .fb-ask-follow:focus { border-color: var(--fb-accent); }
  .flow-board-root .fb-ask-follow:disabled { opacity: 0.6; }
  .flow-board-root .fb-ask-foot .fb-ask-secondary { height: 36px; }

  /* ── The map while the panel is open ── */
  .flow-board-root .fb-terr-cell.fb-terr-ask-tagged {
    border-color: var(--fb-learn-known);
    box-shadow: inset 0 0 0 2px var(--fb-learn-known);
  }
  .flow-board-root .fb-terr-cell.fb-terr-ask-mentioned {
    outline: 2px dashed var(--fb-accent);
    outline-offset: -2px;
    box-shadow: none;
  }
  .flow-board-root .fb-terr-ask-marks {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--fl-space-xs, 4px);
    max-width: calc(100% - 12px);
    pointer-events: none;
  }
  .flow-board-root .fb-terr-ask-chip {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 6px;
    border-radius: var(--fl-radius-sm, 4px);
    background: var(--fb-card);
    border: 1px solid var(--fb-border);
    color: var(--fb-ink);
    font-size: 11px;
    line-height: 1.5;
  }
  .flow-board-root .fb-terr-ask-chip-tag,
  .flow-board-root .fb-terr-ask-live-read,
  .flow-board-root .fb-terr-ask-live-reading,
  .flow-board-root .fb-terr-ask-chip-facts { color: var(--fb-learn-known); }
  .flow-board-root .fb-terr-ask-chip-facts {
    background: color-mix(in srgb, var(--fb-learn-known) 18%, var(--fb-card));
  }
  .flow-board-root .fb-terr-ask-chip-mention { color: var(--fb-accent); }
  .flow-board-root .fb-terr-ask-live-thin { color: var(--fb-warn); }
  .flow-board-root .fb-terr-ask-live-reading { animation: fb-ask-pulse 1.4s ease-in-out infinite; }
  @keyframes fb-ask-pulse { 50% { opacity: 0.55; } }
  @media (prefers-reduced-motion: reduce) { .flow-board-root .fb-terr-ask-live-reading { animation: none; } }
  .flow-board-root .fb-terr-ask-open .fb-terr-cell { cursor: copy; }
`
