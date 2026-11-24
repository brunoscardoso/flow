// Ask the Blueprint — the island's entry field and the centered sheet (plans
// `ask_the_blueprint` and `ask_the_blueprint_workspace`; redesigned as a
// sheet on 2026-11-16, "option B").
//
// ONE SMALL FIELD, ONE SHEET. The island keeps a small entry — a placeholder
// and the "/" key. Pressing or focusing it (or "/") opens a 760px sheet in the
// middle of the board over a dim layer, and EVERYTHING about asking happens in
// that sheet: the question, what it is about, suggested and recent questions,
// the working status, the answer, follow-ups. Esc or a press on the dim layer
// closes it and puts focus back on the island field. The map does not react
// while the sheet is open — the dim layer covers it.
//
// THIN ON PURPOSE. What each state says and what a follow-up waits for is
// `ask-panel-model`'s pure reducer; what an answer's text IS (lead, sections,
// lists, code/file/feature chips, citations, "Not covered") is
// `ask-answer-model`'s parser, and the suggested and recent questions are its
// helpers; matching pasted text and the @ picker are `ask-tag-suggest`'s. This
// file turns DOM events into model events, model state into DOM, and talks to
// main through `window.flow.ask`. Model text only ever reaches the page as text
// nodes — never through innerHTML.
//
// THE FIELD OUTLIVES THE STRIP. The board rebuilds its header strip on every
// render, so the field is built once here and MOVED into each new strip
// (`mountField`).
//
// PAY ONLY WHILE OPEN (allowed-pattern #17). The `ask:state` subscription, the
// outside-press listener and the elapsed-time tick are taken when the sheet
// opens (the tick only while an answer runs) and dropped when it closes.
//
// No commands, paths or settings in its words (forbidden #12): a file chip
// shows a repo path the answer itself named, and every error is main's plain
// sentence.

import { guideInfoButton } from '../guides/guide-info'
import type { AskSavedThread, AskSource, AskSuggestedConnection } from '../../shared/ask-contract'
import { markModalOverlay } from '../modal-overlay'
import {
  parseAnswer,
  recentRows,
  suggestedQuestions,
  type AnswerBlock,
  type AnswerInline,
  type SuggestInput,
} from './ask-answer-model'
import {
  ageLabel,
  askScopeLine,
  askStatusLine,
  askTitle,
  canFollowUp,
  connectionButton,
  connectionView,
  continuePrompt,
  conversationTagIds,
  currentTurn,
  factsSentence,
  followUpTarget,
  initialAskState,
  isRunning,
  knowledgeOnlySentence,
  labelOfId,
  mapTagIds,
  reduceAsk,
  savedSentence,
  scopeKey,
  type AskCellMark,
  type AskConnectionEnd,
  type AskPanelEvent,
  type AskPanelState,
  type AskScope,
  type AskTag,
  type AskTagKind,
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

/** What the board lends the sheet. */
export interface AskPanelHost {
  /** The project the sheet asks from (the Workspace is resolved from it), or null when none is open. */
  rootId: () => string | null
  /** The scope a fresh open asks: the sheet on screen decides. */
  scope: () => AskScope
  /** The Workspace's scope, when the board knows one — a pointer to a Workspace answer opens there. */
  workspaceScope: () => AskScope | null
  /** The features and parts for suggestions and the @ picker, in `scope`'s id grammar. */
  graphNodes: (scope: AskScope) => readonly SuggestNode[]
  /** Workspace scope: projects and connections for the @ picker. */
  extraCandidates: (scope: AskScope) => readonly PickerCandidate[]
  /** Project scope: which features "Your questions" reads when nothing is tagged. */
  historyScope: () => string[]
  /** A project's name and colour (a CSS colour value), for chips and sources. */
  project: (slug: string) => { name: string; color: string | null } | null
  /** A feature's name in a project, when the board holds it. */
  featureName: (project: string, featureId: string) => string | null
  /** A feature or part id (either grammar)'s name, when the board holds it. */
  featureLabel: (id: string) => string | null
  /** What "Try asking" is built from, for this scope and these tags. */
  suggestInput: (scope: AskScope, tags: readonly AskTag[]) => SuggestInput
  /**
   * Project scope: every saved question, read ONCE per board load (not per
   * broadcast); null until read. "Your recent questions" reads it when
   * nothing is tagged.
   */
  savedAll: () => readonly AskSavedThread[] | null
  /** An answer was saved — the board reads its saved list again (its markers too). */
  onSaved: () => void
  /** The state changed. */
  onChange: (state: AskPanelState) => void
  /** Whether a file of this project can be opened here (a checkout on this computer). */
  canOpenFile: (project: string | undefined) => boolean
  /** Open a repo file in the app's editor. */
  openFile: (relPath: string, project: string | undefined) => void
  /**
   * What pressing a feature chip does — the board's navigation to it — or null
   * when that feature cannot be opened from here (another project's).
   */
  featureTarget: (id: string) => (() => void) | null
  /** A connection was recorded — the Workspace map is read again. */
  onConnectionSaved: () => void
  /** The sheet closed and the island field is not on screen — the board takes focus back. */
  onClosed: () => void
}

const ASK_TIMEOUT_SENTENCE = "Flow couldn't start that question."
const SAVE_FAILED_SENTENCE = "Flow couldn't save that connection."
const LIST_DEBOUNCE_MS = 250
const THREAD_PICKER_LIMIT = 30
const RECENT_SHOWN = 4

export const ASK_FIELD_PLACEHOLDER = 'Ask how something works…'
export const ASK_SHEET_PLACEHOLDER = 'What do you want to know?'

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
function icon(paths: string[], size = 14, box = 24): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', `0 0 ${String(box)} ${String(box)}`)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', box === 16 ? '1.5' : '2')
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

const ICON_SPARK = ['M8 1.8 L9.3 6.7 L14.2 8 L9.3 9.3 L8 14.2 L6.7 9.3 L1.8 8 L6.7 6.7 Z']
const ICON_BACK = ['M15 18l-6-6 6-6']
const ICON_CHECK = ['M20 6L9 17l-5-5']
const ICON_SPIN = ['M21 12a9 9 0 1 1-9-9']
const ICON_CHAT = ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z']
const ICON_BRANCH = ['M6 4v12', 'M18 6a2 2 0 1 0 0 .01', 'M6 18a2 2 0 1 0 0 .01', 'M18 8c0 4-6 3-10 6']

/** A key hint: the key cap, then what it does. */
function keyHint(key: string, what: string): HTMLElement {
  const hint = el('span', 'fb-ask-keyhint')
  hint.append(el('kbd', 'fb-ask-kbd', key), document.createTextNode(` ${what}`))
  return hint
}

/* ── The field and the sheet ──────────────────────────────────────────── */

export class AskPanelView {
  /** The dim layer with the sheet in it — placed on the board root, over everything. */
  readonly element: HTMLElement
  /** The island's entry field — moved into each header strip the board builds. */
  readonly field: HTMLElement
  readonly #host: AskPanelHost
  #state: AskPanelState = initialAskState()

  // The island field.
  readonly #fieldInput: HTMLTextAreaElement
  readonly #fieldKey: HTMLElement

  // The sheet — built once, so focus and the caret survive a repaint.
  readonly #sheet: HTMLElement
  readonly #big: HTMLElement
  readonly #textarea: HTMLTextAreaElement
  readonly #scopeLine: HTMLElement
  readonly #qhead: HTMLElement
  readonly #qtitle: HTMLElement
  readonly #meta: HTMLElement
  readonly #body: HTMLElement
  readonly #pick: HTMLElement
  readonly #pickHead: HTMLElement
  readonly #pickList: HTMLElement
  readonly #compose: HTMLElement
  readonly #suggestions: HTMLElement
  readonly #columns: HTMLElement
  readonly #answer: HTMLElement
  readonly #history: HTMLElement
  readonly #hints: HTMLElement
  readonly #pickHints: HTMLElement
  readonly #footer: HTMLElement
  readonly #followInput: HTMLInputElement
  readonly #continueBtn: HTMLButtonElement

  #unsubscribe: (() => void) | null = null
  #pickerRows: PickerCandidate[] = []
  #pickerIndex = 0
  #pickerQuery: string | null = null
  #threadCandidates: PickerCandidate[] | null = null
  #threadsLoading = false
  #listTimer: number | null = null
  #listSeq = 0
  #historySeq = 0
  #listedKey = ''
  #staleRead = false
  #copyTimer: number | null = null
  #tickTimer: number | null = null
  /** "Show steps" is open. Reset with every new question. */
  #stepsOpen = false
  /** Turns whose folded reply is shown, by index. */
  #repliesOpen = new Set<number>()
  /** A saved id already reported to the board, so `onSaved` fires once per answer. */
  #reportedSaved = new Set<string>()
  /** Focus being put back on the island field — its focus event must not reopen the sheet. */
  #returningFocus = false

  constructor(host: AskPanelHost) {
    this.#host = host
    injectAskStyles()

    // ── THE ISLAND FIELD — a small entry: a placeholder and the "/" key. ──
    this.field = el('div', 'fb-askf')
    this.field.dataset['ask'] = 'field'
    this.field.setAttribute('role', 'search')
    this.field.appendChild(icon(ICON_SPARK, 14, 16)).classList.add('fb-askf-spark')
    this.#fieldInput = el('textarea', 'fb-askf-input')
    this.#fieldInput.rows = 1
    this.#fieldInput.wrap = 'off'
    this.#fieldInput.readOnly = true
    this.#fieldInput.placeholder = ASK_FIELD_PLACEHOLDER
    this.#fieldInput.setAttribute('aria-label', 'Ask how something works, or whether it can be built')
    this.#fieldInput.setAttribute('aria-haspopup', 'dialog')
    this.#fieldInput.spellcheck = false
    this.#fieldInput.addEventListener('focus', () => {
      if (this.#returningFocus) return
      if (!this.#state.open) this.#openFromField()
    })
    // A press on a field already focused (focus fires no event) opens it too.
    this.#fieldInput.addEventListener('mousedown', () => {
      if (!this.#state.open && document.activeElement === this.#fieldInput) this.#openFromField()
    })
    this.#fieldInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (!this.#state.open) this.#openFromField()
      }
    })
    this.#fieldKey = el('kbd', 'fb-askf-key', '/')
    this.#fieldKey.title = 'Press / to ask'
    this.field.append(this.#fieldInput, this.#fieldKey)
    this.field.addEventListener('mousedown', (event) => {
      if (event.target === this.#fieldInput) return
      event.preventDefault()
      if (!this.#state.open) this.#openFromField()
    })
    this.field.addEventListener('click', (event) => event.stopPropagation())

    // ── THE DIM LAYER and the sheet in it ──────────────────────────────────
    this.element = el('div', 'fb-ask-dim')
    this.element.hidden = true
    this.element.dataset['ask'] = 'dim'
    // A MODAL while open: the app's panel shortcuts are inert, the terminal
    // does not take focus, and Tab stays inside the sheet.
    markModalOverlay(this.element)
    // A press on the dim layer itself (not the sheet) closes.
    this.element.addEventListener('mousedown', (event) => {
      if (event.target !== this.element) return
      event.preventDefault()
      this.#closeFromKeyboard()
    })
    this.element.addEventListener('click', (event) => event.stopPropagation())
    this.element.addEventListener('dblclick', (event) => event.stopPropagation())

    this.#sheet = el('div', 'fb-ask')
    this.#sheet.setAttribute('role', 'dialog')
    this.#sheet.setAttribute('aria-modal', 'true')
    this.#sheet.setAttribute('aria-label', 'Ask the Blueprint')
    this.#sheet.tabIndex = -1
    this.#sheet.addEventListener('keydown', (event) => this.#onKeydown(event))
    this.element.appendChild(this.#sheet)

    // HEAD — the big field and the scope (compose), or the question and its status (answer).
    const head = el('div', 'fb-ask-head')
    this.#big = el('div', 'fb-ask-big')
    this.#big.appendChild(icon(ICON_SPARK, 15, 16)).classList.add('fb-ask-big-spark')
    this.#textarea = el('textarea', 'fb-ask-input')
    this.#textarea.rows = 1
    this.#textarea.wrap = 'off'
    this.#textarea.placeholder = ASK_SHEET_PLACEHOLDER
    this.#textarea.setAttribute('aria-label', 'Your question')
    this.#textarea.spellcheck = false
    this.#textarea.addEventListener('input', (event) => this.#onInput(event as InputEvent))
    this.#textarea.addEventListener('blur', () =>
      window.setTimeout(() => {
        if (document.activeElement !== this.#textarea) this.#closePicker()
      }, 150),
    )
    const esc = el('kbd', 'fb-ask-esc', 'esc')
    esc.title = 'Close'
    esc.addEventListener('mousedown', (event) => {
      event.preventDefault()
      this.#closeFromKeyboard()
    })
    this.#big.append(this.#textarea, guideInfoButton('ask', 'asking'), esc)
    this.#big.addEventListener('mousedown', (event) => {
      if (event.target === this.#textarea || (event.target as Element).closest('kbd') !== null) return
      event.preventDefault()
      this.#focusInput()
    })
    this.#scopeLine = el('div', 'fb-ask-scope')

    this.#qhead = el('div', 'fb-ask-qhead')
    this.#qtitle = el('div', 'fb-ask-qtitle')
    const newQuestion = button('fb-ask-quiet fb-ask-newq', 'New question', () => this.#newQuestion())
    const closeBtn = button('fb-ask-icon-btn', '', () => this.#closeFromKeyboard(), 'Close')
    closeBtn.title = 'Close'
    closeBtn.appendChild(el('kbd', 'fb-ask-esc', 'esc'))
    this.#qhead.append(this.#qtitle, newQuestion, closeBtn)
    this.#meta = el('div', 'fb-ask-meta')
    head.append(this.#big, this.#qhead, this.#meta, this.#scopeLine)

    this.#body = el('div', 'fb-ask-body')

    // THE @ LIST — the body while a tag is being typed.
    this.#pick = el('div', 'fb-ask-pick')
    this.#pickHead = el('div', 'fb-ask-caps fb-ask-pick-head')
    this.#pickList = el('div', 'fb-ask-pick-list')
    this.#pickList.setAttribute('role', 'listbox')
    this.#pickList.setAttribute('aria-label', 'Features to add')
    this.#pick.append(this.#pickHead, this.#pickList)

    // COMPOSE — tags the pasted text names, then Try asking | Your recent questions.
    this.#compose = el('div', 'fb-ask-compose')
    this.#suggestions = el('div', 'fb-ask-card fb-ask-suggest')
    this.#columns = el('div', 'fb-ask-cols')
    this.#compose.append(this.#suggestions, this.#columns)

    this.#answer = el('div', 'fb-ask-answer')
    this.#history = el('div', 'fb-ask-history')
    this.#body.append(this.#pick, this.#compose, this.#answer, this.#history)

    // FOOTERS — compose's key hints, the @ list's, and the answer's follow-up.
    this.#hints = el('div', 'fb-ask-hints')
    this.#hints.append(keyHint('↵', 'ask'), keyHint('@', 'add a feature'), el('span', 'fb-ask-spacer'), el('span', 'fb-ask-private', 'Only you see your questions'))
    this.#pickHints = el('div', 'fb-ask-hints')
    this.#pickHints.append(keyHint('↑↓', 'move'), keyHint('↵', 'add'), keyHint('esc', 'back to the question'))

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

    this.#sheet.append(head, this.#body, this.#hints, this.#pickHints, this.#footer)
    this.#render()
  }

  get state(): AskPanelState {
    return this.#state
  }

  get isOpen(): boolean {
    return this.#state.open
  }

  /** Put the field in a header strip. The strip is rebuilt on every render, so this MOVES the one field. */
  mountField(parent: HTMLElement): void {
    parent.appendChild(this.field)
  }

  /** Open — with text or tags, a fresh question; with neither, where it was left. */
  open(
    input: { text?: string; tags?: AskTag[]; view?: 'history'; entryId?: string; submit?: boolean; scope?: AskScope } = {},
  ): void {
    const wasOpen = this.#state.open
    const { view, entryId, submit, scope, ...fresh } = input
    const nextScope = scope ?? this.#host.scope()
    if (!wasOpen || scopeKey(nextScope) !== scopeKey(this.#state.scope)) {
      this.#staleRead = false
      this.#threadCandidates = null
      this.#listedKey = ''
    }
    if (fresh.text !== undefined || (fresh.tags !== undefined && fresh.tags.length > 0)) this.#resetAnswerChrome()
    this.#subscribe()
    this.#dispatch({ type: 'open', ...fresh, scope: nextScope })
    if (entryId !== undefined) {
      // A saved answer: the list is read (for its stale marks too) and the
      // entry opens in place of a question.
      this.#dispatch({ type: 'show-history' })
      void this.#readHistory(entryId)
      this.#focusSheet()
      return
    }
    if (view === 'history') {
      this.#showHistory()
      this.#focusSheet()
      return
    }
    // A SAVED LIST IS NOT A PLACE TO RETURN TO: a bare open after one starts a question.
    if (wasOpen === false && fresh.text === undefined && fresh.tags === undefined && this.#state.view === 'history') {
      this.#dispatch({ type: 'new-question' })
      for (const tag of this.#state.tags) this.#dispatch({ type: 'remove-tag', id: tag.id })
      this.#textarea.value = ''
    }
    if (submit === true && input.text !== undefined) {
      this.#textarea.value = input.text
      this.#submit(false)
      return
    }
    if (input.text !== undefined) this.#suggestFrom(input.text)
    this.#focusSheet()
  }

  close(): void {
    this.#unsubscribeState()
    this.#closePicker()
    this.#clearListTimer()
    this.#stopTick()
    this.#listSeq += 1
    this.#historySeq += 1
    this.#dispatch({ type: 'close' })
  }

  /**
   * A map piece named while the sheet is open (an opener, not a map press —
   * the dim layer covers the map). In the question box it becomes a chip; on
   * a finished answer it starts a new question with that answer's tags plus
   * this one. While an answer is still coming nothing changes.
   */
  addTagFromMap(tag: AskTag): boolean {
    const turn = currentTurn(this.#state)
    if (this.#state.view === 'answer' && turn !== null) {
      if (isRunning(turn)) return false
      const tags = [...turn.tags]
      if (!tags.some((existing) => existing.id === tag.id)) tags.push(tag)
      const question = turn.question
      this.#newQuestion()
      for (const existing of tags) this.#dispatch({ type: 'add-tag', tag: existing })
      this.#dispatch({ type: 'draft', text: question })
      this.#focusInput()
      return true
    }
    if (this.#state.view === 'history') this.#dispatch({ type: 'new-question' })
    this.#dispatch({ type: 'add-tag', tag })
    this.#focusInput()
    return true
  }

  /** Kept for the board's resize path: the sheet is centred by CSS, so there is nothing to place. */
  reposition(): void {
    // Nothing: the sheet is laid out by CSS against the board.
  }

  /** The board's saved list changed: "Your recent questions" reads it again. */
  refreshSaved(): void {
    if (this.#state.open && this.#state.view === 'compose') this.#render()
  }

  dispose(): void {
    this.close()
    if (this.#copyTimer !== null) window.clearTimeout(this.#copyTimer)
    this.element.remove()
    this.field.remove()
  }

  /* ── State plumbing ─────────────────────────────────────────────────── */

  #dispatch(event: AskPanelEvent): void {
    const next = reduceAsk(this.#state, event)
    if (next === this.#state) return
    this.#state = next
    this.#render()
    this.#host.onChange(next)
    this.#scheduleAskedBefore()
    this.#reportSaved()
    this.#syncTick()
  }

  /** A fresh answer that just landed in the saved log: the board re-reads its list, once. */
  #reportSaved(): void {
    for (const turn of this.#state.turns) {
      const id = turn.saved === null ? turn.answer?.savedId : undefined
      if (id === undefined || isRunning(turn) || this.#reportedSaved.has(id)) continue
      this.#reportedSaved.add(id)
      this.#host.onSaved()
    }
  }

  #subscribe(): void {
    if (this.#unsubscribe !== null) return
    const off =
      window.flow.ask?.onState((event) => {
        if (event.rootId !== this.#host.rootId()) return
        if (!this.#state.turns.some((turn) => turn.askId === event.askId)) return
        this.#dispatch({ type: 'state', event, at: Date.now() })
      }) ?? null
    // WHILE OPEN ONLY: a press outside the board's sheet and field closes.
    document.addEventListener('pointerdown', this.#onOutsidePress, true)
    this.#unsubscribe = () => {
      off?.()
      document.removeEventListener('pointerdown', this.#onOutsidePress, true)
    }
  }

  #unsubscribeState(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  readonly #onOutsidePress = (event: PointerEvent): void => {
    if (!this.#state.open) return
    const target = event.target
    // The dim layer is the sheet's own (its press closes it and returns focus).
    if (target instanceof Node && (this.element.contains(target) || this.field.contains(target))) return
    this.close()
  }

  /** The elapsed seconds tick once a second, only while an answer runs and the sheet is open. */
  #syncTick(): void {
    const turn = currentTurn(this.#state)
    const running = this.#state.open && turn !== null && isRunning(turn)
    if (!running) {
      this.#stopTick()
      return
    }
    if (this.#tickTimer !== null) return
    this.#tickTimer = window.setInterval(() => this.#renderMeta(), 1000)
  }

  #stopTick(): void {
    if (this.#tickTimer !== null) window.clearInterval(this.#tickTimer)
    this.#tickTimer = null
  }

  #focusInput(): void {
    this.#textarea.focus({ preventScroll: true })
    const end = this.#textarea.value.length
    this.#textarea.setSelectionRange(end, end)
  }

  /** Focus what the sheet's state is about: the question box, else the follow-up, else the sheet. */
  #focusSheet(): void {
    window.requestAnimationFrame(() => {
      if (!this.#state.open) return
      if (this.#state.view === 'compose') this.#focusInput()
      else if (this.#state.view === 'answer' && !this.#followInput.disabled) this.#followInput.focus({ preventScroll: true })
      else this.#sheet.focus({ preventScroll: true })
    })
    if (this.#state.view === 'compose') this.#focusInput()
  }

  /** Esc, the dim layer, or the esc key cap: close, and focus goes back to the island field. */
  #closeFromKeyboard(): void {
    this.close()
    if (this.field.isConnected) {
      this.#returningFocus = true
      this.#fieldInput.focus({ preventScroll: true })
      this.#returningFocus = false
      return
    }
    this.#host.onClosed()
  }

  #resetAnswerChrome(): void {
    this.#stepsOpen = false
    this.#repliesOpen.clear()
  }

  #newQuestion(): void {
    this.#closePicker()
    this.#resetAnswerChrome()
    this.#dispatch({ type: 'new-question' })
    this.#textarea.value = ''
    this.#focusInput()
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
    if (!followUp) this.#resetAnswerChrome()
    else this.#stepsOpen = false
    this.#dispatch({ type: 'submit', question, followUp, at })
    // The reducer refused (an empty question, a follow-up while one runs).
    if (this.#state === before) return
    const turn = currentTurn(this.#state)
    if (turn === null || turn.askId !== null || turn.startedAt !== at) return
    if (followUp) this.#followInput.value = ''
    this.#closePicker()
    void this.#start(rootId, turn, followUpOf)
    this.#sheet.focus({ preventScroll: true })
  }

  async #start(rootId: string, turn: AskTurn, followUpOf: string | null): Promise<void> {
    const api = window.flow.ask
    if (api === undefined) {
      this.#dispatch({ type: 'start-failed', sentence: ASK_TIMEOUT_SENTENCE })
      return
    }
    const scope = this.#state.scope
    try {
      const result = await api.start({
        rootId,
        question: turn.question,
        tags: mapTagIds(turn.tags),
        conversationIds: conversationTagIds(turn.tags),
        followUpOf,
        // The Workspace's projects are resolved in main: the tagged ones, or all.
        ...(scope.kind === 'workspace' ? { workspace: { workspace: scope.workspace, projects: [] } } : {}),
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

  #askSuggested(question: string): void {
    this.#textarea.value = question
    this.#dispatch({ type: 'draft', text: question })
    this.#submit(false)
  }

  #continueInConversation(): void {
    const turn = currentTurn(this.#state)
    if (turn === null) return
    document.dispatchEvent(new CustomEvent('flow:compose-prompt', { detail: { text: continuePrompt(turn) } }))
  }

  async #saveConnection(connection: AskSuggestedConnection): Promise<void> {
    const rootId = this.#host.rootId()
    const scope = this.#state.scope
    const api = window.flow.ask
    if (rootId === null || scope.kind !== 'workspace') return
    this.#dispatch({ type: 'connection-saving', id: connection.id })
    if (api === undefined || typeof api.saveConnection !== 'function') {
      this.#dispatch({ type: 'connection-failed', id: connection.id, sentence: SAVE_FAILED_SENTENCE })
      return
    }
    try {
      const result = await api.saveConnection({ rootId, workspace: scope.workspace, connection })
      if (result.ok) {
        this.#dispatch({ type: 'connection-saved', id: connection.id, recorded: result.recorded })
        if (result.recorded) this.#host.onConnectionSaved()
      } else {
        this.#dispatch({ type: 'connection-failed', id: connection.id, sentence: result.detail })
      }
    } catch {
      this.#dispatch({ type: 'connection-failed', id: connection.id, sentence: SAVE_FAILED_SENTENCE })
    }
  }

  /* ── Saved questions ────────────────────────────────────────────────── */

  /**
   * Re-read the saved questions about the tags when they change, in the
   * question box only. On the Workspace, nothing tagged reads the whole
   * Workspace; in a project, nothing tagged reads nothing here — the board's
   * once-per-load list answers it.
   */
  #scheduleAskedBefore(): void {
    if (!this.#state.open || this.#state.view !== 'compose') return
    const ids = mapTagIds(this.#state.tags)
    const workspace = this.#state.scope.kind === 'workspace'
    const key = `${scopeKey(this.#state.scope)}\n${ids.slice().sort().join('\n')}`
    if (key === this.#listedKey) return
    this.#listedKey = key
    this.#clearListTimer()
    if (ids.length === 0 && !workspace) {
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

  /** One read of saved answers in the sheet's scope, with the stale marks when not read yet. */
  async #readSaved(ids: string[], withStale: boolean) {
    const rootId = this.#host.rootId()
    const api = window.flow.ask
    if (rootId === null || api === undefined) return null
    const scope = this.#state.scope
    const workspace = scope.kind === 'workspace' ? scope.workspace : null
    const [list, stale] = await Promise.all([
      api
        .list(workspace !== null ? { rootId, featureIds: [], workspace: { workspace, tags: ids } } : { rootId, featureIds: ids })
        .catch(() => null),
      withStale
        ? api.stale(workspace !== null ? { rootId, workspace: { workspace, tags: [] } } : { rootId }).catch(() => null)
        : Promise.resolve(null),
    ])
    return { list, stale }
  }

  async #readAskedBefore(ids: string[]): Promise<void> {
    const seq = ++this.#listSeq
    const read = await this.#readSaved(ids, !this.#staleRead)
    if (read === null || seq !== this.#listSeq || !this.#state.open) return
    const { list, stale } = read
    if (stale !== null && stale.ok) this.#staleRead = true
    this.#dispatch({
      type: 'asked-before',
      threads: list !== null && list.ok ? list.threads : [],
      stale: stale !== null && stale.ok ? stale.results : [],
    })
  }

  #showHistory(): void {
    this.#closePicker()
    this.#dispatch({ type: 'show-history' })
    void this.#readHistory()
  }

  async #readHistory(openId?: string): Promise<void> {
    const tagged = mapTagIds(this.#state.tags)
    const workspace = this.#state.scope.kind === 'workspace'
    const seq = ++this.#historySeq
    // PROJECT, NOTHING TAGGED: the board's once-per-load list is the whole history.
    if (!workspace && tagged.length === 0) {
      const all = this.#host.savedAll()
      if (all !== null) {
        this.#dispatch({ type: 'history', threads: [...all], stale: [] })
        const wanted = openId === undefined ? undefined : all.find((thread) => thread.id === openId)
        if (wanted !== undefined) this.#dispatch({ type: 'open-saved', thread: wanted })
        if (openId === undefined || wanted !== undefined) return
      }
    }
    // A saved entry asked for by id is looked for in the whole scope.
    const ids = workspace ? (openId !== undefined ? [] : tagged) : tagged.length > 0 ? tagged : this.#host.historyScope()
    if (!workspace && ids.length === 0) {
      this.#dispatch({ type: 'history', threads: [], stale: [] })
      return
    }
    const read = await this.#readSaved(ids, true)
    if (read === null || seq !== this.#historySeq || !this.#state.open) return
    const { list, stale } = read
    if (list === null || !list.ok) {
      this.#dispatch({ type: 'history-failed', sentence: list?.detail ?? "Your questions couldn't be read." })
      return
    }
    this.#dispatch({ type: 'history', threads: list.threads, stale: stale !== null && stale.ok ? stale.results : [] })
    const wanted = openId === undefined ? undefined : list.threads.find((thread) => thread.id === openId)
    if (wanted !== undefined) this.#dispatch({ type: 'open-saved', thread: wanted })
  }

  /** A saved row pressed: a pointer to a Workspace answer opens it in the Workspace. */
  #openSavedRow(thread: AskSavedThread): void {
    this.#resetAnswerChrome()
    const pointer = thread.workspaceAnswer
    if (pointer !== undefined && this.#state.scope.kind !== 'workspace') {
      const workspace = this.#host.workspaceScope()
      if (workspace !== null) {
        this.open({ entryId: pointer.entryId, scope: workspace })
        return
      }
    }
    this.#dispatch({ type: 'open-saved', thread })
    this.#focusSheet()
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
    const suggestions = suggestTags(text, this.#host.graphNodes(this.#state.scope), { exclude })
    this.#dispatch({ type: 'suggest', suggestions })
  }

  /** "+ add a feature with @": an @ at the caret, and the list opens. */
  #startMention(): void {
    const text = this.#textarea.value
    const caret = this.#textarea.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const insert = before === '' || before.endsWith(' ') ? '@' : ' @'
    this.#textarea.value = `${before}${insert}${text.slice(caret)}`
    const at = before.length + insert.length
    this.#textarea.focus({ preventScroll: true })
    this.#textarea.setSelectionRange(at, at)
    this.#dispatch({ type: 'draft', text: this.#textarea.value })
    this.#updatePicker()
  }

  #updatePicker(): void {
    const mention = this.#state.open
      ? activeMention(this.#textarea.value, this.#textarea.selectionStart ?? this.#textarea.value.length)
      : null
    if (mention === null) {
      this.#closePicker()
      return
    }
    if (this.#threadCandidates === null && !this.#threadsLoading) void this.#loadThreads()
    const scope = this.#state.scope
    const candidates = [
      ...this.#host.extraCandidates(scope),
      ...graphCandidates(this.#host.graphNodes(scope)),
      ...(this.#threadCandidates ?? []),
    ]
    const exclude = new Set(this.#state.tags.map((tag) => tag.id))
    const query = mention.query
    if (query !== this.#pickerQuery) this.#pickerIndex = 0
    this.#pickerQuery = query
    this.#pickerRows = pickerMatches(query, candidates, { exclude })
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerRows.length - 1))
    this.#render()
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
        hint: `Your conversation · ${ageLabel(thread.updatedAt, Date.now())}`,
      }))
    } catch {
      this.#threadCandidates = []
    } finally {
      this.#threadsLoading = false
    }
    if (this.#pickerQuery !== null) this.#updatePicker()
  }

  #closePicker(): void {
    const wasOpen = this.#pickerQuery !== null
    this.#pickerRows = []
    this.#pickerIndex = 0
    this.#pickerQuery = null
    if (wasOpen) this.#render()
  }

  #pickerOpen(): boolean {
    return this.#pickerQuery !== null
  }

  #pickRow(row: PickerCandidate): void {
    const text = this.#textarea.value
    const caret = this.#textarea.selectionStart ?? text.length
    const mention = activeMention(text, caret)
    if (mention !== null) {
      const next = `${text.slice(0, mention.start)}${text.slice(caret)}`.replace(/ {2,}/g, ' ')
      this.#textarea.value = next
      this.#textarea.setSelectionRange(mention.start, mention.start)
      this.#dispatch({ type: 'draft', text: next })
    }
    this.#dispatch({
      type: 'add-tag',
      tag: { id: row.id, kind: row.kind, label: row.label, ...(row.project !== undefined ? { project: row.project } : {}) },
    })
    this.#closePicker()
    this.#textarea.focus()
  }

  #onKeydown(event: KeyboardEvent): void {
    const inField = event.target === this.#textarea
    const picking = this.#pickerOpen() && this.#pickerRows.length > 0
    if (inField && picking) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        const step = event.key === 'ArrowDown' ? 1 : -1
        this.#pickerIndex = (this.#pickerIndex + step + this.#pickerRows.length) % this.#pickerRows.length
        this.#renderPicker()
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        const row = this.#pickerRows[this.#pickerIndex]
        if (row !== undefined) this.#pickRow(row)
        return
      }
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      event.preventDefault()
      if (this.#pickerOpen()) this.#closePicker()
      else this.#closeFromKeyboard()
      return
    }
    if (event.key === 'Tab') {
      // THE SHEET HOLDS FOCUS while it is open: Tab cycles inside it.
      this.#trapTab(event)
      return
    }
    if (inField && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      this.#submit(false)
      return
    }
    if (inField && event.key === 'Backspace' && this.#textarea.value === '' && this.#state.view === 'compose') {
      // Backspace in an empty box takes the last chip back, as in any tag field.
      const last = this.#state.tags[this.#state.tags.length - 1]
      if (last !== undefined) {
        event.preventDefault()
        this.#dispatch({ type: 'remove-tag', id: last.id })
      }
    }
    // Typing in the sheet never reaches the board's own shortcuts; the app's
    // modifier shortcuts (the palette and the like) still do.
    if (!event.metaKey && !event.ctrlKey) event.stopPropagation()
  }

  #trapTab(event: KeyboardEvent): void {
    const focusable = [...this.#sheet.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex="0"]')].filter(
      (node) => !(node as HTMLButtonElement).disabled && node.offsetParent !== null,
    )
    event.stopPropagation()
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !this.#sheet.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !this.#sheet.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  /* ── The island field's scope ───────────────────────────────────────── */

  /**
   * THE FIELD ASKS ABOUT ONE THING (a feature's deep view): its placeholder
   * names it and opening the field opens the question already scoped to it.
   * Null is the plain field.
   */
  #fieldScope: { placeholder: string; open: () => void } | null = null

  setFieldScope(scope: { placeholder: string; open: () => void } | null): void {
    this.#fieldScope = scope
    this.#renderField()
  }

  /** Open from the field — scoped when a scope is set, otherwise where it was left. */
  #openFromField(): void {
    if (this.#fieldScope !== null) this.#fieldScope.open()
    else this.open({})
  }

  /* ── Rendering ──────────────────────────────────────────────────────── */

  #render(): void {
    const state = this.#state
    this.#renderField()
    this.element.hidden = !state.open
    if (!state.open) return
    this.#sheet.setAttribute('aria-label', askTitle(state.scope))
    const picking = this.#pickerOpen() && state.view === 'compose'
    const answering = state.view === 'answer'
    this.#sheet.dataset['view'] = state.view
    this.#big.hidden = state.view !== 'compose'
    this.#qhead.hidden = !answering
    this.#meta.hidden = !answering
    this.#scopeLine.hidden = state.view !== 'compose'
    this.#pick.hidden = !picking
    this.#compose.hidden = picking || state.view !== 'compose'
    this.#answer.hidden = !answering
    this.#history.hidden = state.view !== 'history'
    this.#hints.hidden = picking || state.view !== 'compose'
    this.#pickHints.hidden = !picking
    this.#footer.hidden = !answering
    if (this.#textarea.value !== state.draft && state.view !== 'answer') this.#textarea.value = state.draft
    this.#textarea.placeholder = state.tags.length > 0 ? 'Ask about these…' : ASK_SHEET_PLACEHOLDER
    if (state.view === 'compose') this.#renderScope()
    if (picking) this.#renderPicker()
    else if (state.view === 'compose') this.#renderCompose()
    if (answering) {
      this.#renderQuestionHead()
      this.#renderMeta()
      this.#renderAnswer()
    }
    if (state.view === 'history') this.#renderHistory()
  }

  #renderField(): void {
    // Not 'is-open': the island folds its actions for an open field, and the
    // field no longer grows — the sheet is where the question is typed.
    this.field.classList.toggle('is-asking', this.#state.open)
    this.#fieldInput.placeholder = this.#fieldScope?.placeholder ?? ASK_FIELD_PLACEHOLDER
    this.#fieldInput.setAttribute('aria-expanded', String(this.#state.open))
  }

  /** A project's name and colour, as the board knows it. */
  #projectLook(slug: string): { name: string; color: string | null } {
    return this.#host.project(slug) ?? { name: slug, color: null }
  }

  #projectName(slug: string): string {
    return this.#projectLook(slug).name
  }

  /** "jupiter-core ›", in the project's colour — before a feature, part or source. */
  #projectPrefix(slug: string, withArrow = true): HTMLElement {
    const look = this.#projectLook(slug)
    const prefix = el('span', 'fb-ask-proj', withArrow ? `${look.name} ›` : look.name)
    if (look.color !== null) prefix.style.setProperty('--fb-ask-proj', look.color)
    return prefix
  }

  /** A project's colour square. */
  #projectSwatch(slug: string): HTMLElement {
    const look = this.#projectLook(slug)
    const swatch = el('span', 'fb-ask-swatch')
    if (look.color !== null) swatch.style.setProperty('--fb-ask-proj', look.color)
    return swatch
  }

  /** What a tag looks like anywhere: dot, swatch or prefix, then its label. */
  #tagContent(target: HTMLElement, tag: { label: string; kind: AskTagKind | 'scope'; project?: string }): void {
    const workspace = this.#state.scope.kind === 'workspace'
    if (tag.kind === 'conversation') {
      target.append(icon(ICON_CHAT, 11), document.createTextNode(`Conversation: ${tag.label}`))
      return
    }
    if (tag.kind === 'project' && tag.project !== undefined) {
      target.append(this.#projectSwatch(tag.project), document.createTextNode(tag.label))
      return
    }
    if ((tag.kind === 'feature' || tag.kind === 'part') && workspace && tag.project !== undefined) {
      target.append(el('span', 'fb-ask-chip-dot'), this.#projectPrefix(tag.project), document.createTextNode(` ${tag.label}`))
      return
    }
    if (tag.kind === 'feature' || tag.kind === 'part') target.appendChild(el('span', 'fb-ask-chip-dot'))
    target.appendChild(document.createTextNode(tag.label))
  }

  #chip(tag: AskTag, removable: boolean): HTMLElement {
    const chip = el('span', `fb-ask-chip fb-ask-chip-${tag.kind === 'conversation' ? 'conv' : 'map'}`)
    this.#tagContent(chip, tag)
    if (removable) {
      const remove = button('fb-ask-chip-x', '×', () => this.#dispatch({ type: 'remove-tag', id: tag.id }), `Remove ${tag.label}`)
      chip.appendChild(remove)
    }
    return chip
  }

  /** "Asking about" — the whole scope as one chip, or the tags as removable chips; then "+ add". */
  #renderScope(): void {
    const state = this.#state
    this.#scopeLine.replaceChildren()
    this.#scopeLine.appendChild(el('span', 'fb-ask-scope-label', 'Asking about'))
    if (state.tags.length > 0) {
      for (const tag of state.tags) this.#scopeLine.appendChild(this.#chip(tag, true))
    } else {
      const line = askScopeLine(state)
      for (const item of line.items) {
        const pill = el('span', 'fb-ask-chip fb-ask-chip-scope')
        this.#tagContent(pill, item)
        this.#scopeLine.appendChild(pill)
      }
    }
    const add = button('fb-ask-add', '+ add a feature with @', () => this.#startMention())
    add.addEventListener('mousedown', (event) => event.preventDefault())
    this.#scopeLine.appendChild(add)
  }

  #renderPicker(): void {
    const query = this.#pickerQuery ?? ''
    const workspace = this.#state.scope.kind === 'workspace'
    this.#pickHead.textContent =
      query !== ''
        ? `Add “${query}”`
        : workspace
          ? 'Add a project, feature, part, connection or conversation'
          : 'Add a feature, part or conversation'
    this.#pickList.replaceChildren()
    if (this.#pickerRows.length === 0) {
      this.#pickList.appendChild(el('div', 'fb-ask-picker-empty', 'Nothing by that name.'))
      return
    }
    let active: HTMLElement | null = null
    this.#pickerRows.forEach((row, index) => {
      const on = index === this.#pickerIndex
      const item = el('button', `fb-ask-picker-row${on ? ' on' : ''}`)
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(on))
      if (row.kind === 'project' && row.project !== undefined) item.appendChild(this.#projectSwatch(row.project))
      else if (workspace && row.project !== undefined) item.appendChild(this.#projectPrefix(row.project))
      item.append(el('span', 'fb-ask-picker-label', row.label), el('span', 'fb-ask-picker-kind', row.kind))
      if (row.hint !== undefined) item.title = row.hint
      // mousedown, so the field's blur does not close the list first.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        this.#pickRow(row)
      })
      this.#pickList.appendChild(item)
      if (on) active = item
    })
    // THE HIGHLIGHTED ROW STAYS IN VIEW while arrowing.
    ;(active as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
  }

  #renderCompose(): void {
    const state = this.#state

    this.#suggestions.replaceChildren()
    this.#suggestions.hidden = state.suggestions.length === 0
    if (state.suggestions.length > 0) {
      this.#suggestions.appendChild(el('div', 'fb-ask-suggest-head', 'Your message mentions these. Add them?'))
      const chips = el('div', 'fb-ask-suggest-row')
      for (const suggestion of state.suggestions) {
        const chip = button('fb-ask-suggest-chip', '', () => this.#dispatch({ type: 'accept-suggestion', id: suggestion.id }))
        chip.append(document.createTextNode('+ '))
        this.#tagContent(chip, suggestion)
        chips.appendChild(chip)
      }
      const actions = el('div', 'fb-ask-suggest-actions')
      actions.append(
        button('fb-ask-secondary fb-ask-small', 'Add all', () => this.#dispatch({ type: 'accept-all-suggestions' })),
        button('fb-ask-quiet fb-ask-small', 'Dismiss', () => this.#dispatch({ type: 'dismiss-suggestions' })),
      )
      this.#suggestions.append(chips, actions)
    }

    // TRY ASKING | YOUR RECENT QUESTIONS.
    this.#columns.replaceChildren()
    const tryCol = el('div', 'fb-ask-col')
    tryCol.dataset['ask'] = 'try'
    const focusTag = state.tags.find((tag) => tag.kind === 'feature' || tag.kind === 'part')
    tryCol.appendChild(el('div', 'fb-ask-caps', focusTag !== undefined && state.tags.length === 1 ? `Try asking about ${focusTag.label}` : 'Try asking'))
    for (const question of suggestedQuestions(this.#host.suggestInput(state.scope, state.tags))) {
      const row = button('fb-ask-row fb-ask-try', '', () => this.#askSuggested(question))
      row.append(icon(ICON_SPARK, 13, 16), el('span', 'fb-ask-row-q', question))
      tryCol.appendChild(row)
    }

    const recentCol = el('div', 'fb-ask-col')
    recentCol.dataset['ask'] = 'recent'
    const recentHead = el('div', 'fb-ask-col-head')
    recentHead.appendChild(el('span', 'fb-ask-caps', 'Your recent questions'))
    const threads = this.#recentThreads()
    if (threads.length > RECENT_SHOWN) {
      recentHead.append(el('span', 'fb-ask-spacer'), button('fb-ask-link', 'See all', () => this.#showHistory()))
    }
    recentCol.appendChild(recentHead)
    const rows = recentRows(threads, Date.now(), (id) => this.#tagName(id), RECENT_SHOWN)
    if (rows.length === 0) {
      recentCol.appendChild(el('p', 'fb-ask-muted', 'The questions you ask are kept here, for you only.'))
    }
    for (const recent of rows) {
      const row = button('fb-ask-row fb-ask-recent', '', () => this.#openSavedRow(recent.thread))
      row.appendChild(el('span', 'fb-ask-row-q', recent.question))
      const stale = state.staleIds.includes(recent.id)
      row.appendChild(el('em', stale ? 'fb-ask-warn-text' : '', stale ? 'code changed since' : recent.meta))
      recentCol.appendChild(row)
    }
    this.#columns.append(tryCol, recentCol)
  }

  /** The saved questions "Your recent questions" lists: about the tags, else the whole scope. */
  #recentThreads(): readonly AskSavedThread[] {
    const state = this.#state
    if (mapTagIds(state.tags).length > 0 || state.scope.kind === 'workspace') return state.askedBefore
    return this.#host.savedAll() ?? []
  }

  #tagName(id: string): string | null {
    if (id.startsWith('project:')) {
      const look = this.#host.project(id.slice('project:'.length))
      return look?.name ?? null
    }
    return this.#host.featureLabel(id)
  }

  #savedRow(thread: AskSavedThread): HTMLElement {
    const row = button('fb-ask-row fb-ask-saved-row', '', () => this.#openSavedRow(thread))
    row.appendChild(el('span', 'fb-ask-row-q', thread.question))
    const stale = this.#state.staleIds.includes(thread.id)
    const meta = stale
      ? el('em', 'fb-ask-warn-text', 'code changed since')
      : el(
          'em',
          '',
          [thread.workspaceAnswer !== undefined ? 'Workspace' : '', ageLabel(thread.ts, Date.now()), thread.followUps.length > 0 ? `${String(thread.followUps.length)} follow-up${thread.followUps.length === 1 ? '' : 's'}` : '']
            .filter((part) => part !== '')
            .join(' · '),
        )
    row.appendChild(meta)
    return row
  }

  #renderHistory(): void {
    const state = this.#state
    this.#history.replaceChildren()
    const head = el('div', 'fb-ask-history-head')
    const back = button('fb-ask-icon-btn', '', () => this.#newQuestion(), 'Back to the question')
    back.title = 'Back to the question'
    back.appendChild(icon(ICON_BACK))
    const about = state.tags.filter((tag) => tag.kind !== 'conversation').map((tag) => tag.label)
    head.append(back, el('span', 'fb-ask-history-title', about.length === 1 ? `Your questions about ${about[0]}` : 'Your questions'))
    const close = button('fb-ask-icon-btn', '', () => this.#closeFromKeyboard(), 'Close')
    close.title = 'Close'
    close.appendChild(el('kbd', 'fb-ask-esc', 'esc'))
    head.append(el('span', 'fb-ask-spacer'), close)
    this.#history.appendChild(head)
    if (state.historyError !== null) {
      this.#history.appendChild(el('p', 'fb-ask-error', state.historyError))
      return
    }
    if (state.history === null) {
      this.#history.appendChild(el('p', 'fb-ask-muted', 'Reading your questions…'))
      return
    }
    if (state.history.length === 0) {
      this.#history.appendChild(el('p', 'fb-ask-muted', about.length > 0 ? 'You have not asked about this yet.' : 'You have not asked a question yet.'))
      return
    }
    const list = el('div', 'fb-ask-rows')
    for (const thread of state.history) list.appendChild(this.#savedRow(thread))
    this.#history.appendChild(list)
  }

  /* ── The answer ─────────────────────────────────────────────────────── */

  /** The header: the question (the first turn's), then New question and close. */
  #renderQuestionHead(): void {
    const first = this.#state.turns[0]
    this.#qtitle.textContent = first?.question ?? this.#state.draft
  }

  /** The one status row: chips, a dot or a spinner, the words, Show steps, Stop. */
  #renderMeta(): void {
    const state = this.#state
    const turn = currentTurn(state)
    this.#meta.replaceChildren()
    if (turn === null) return
    for (const tag of state.turns[0]?.tags ?? []) this.#meta.appendChild(this.#chip(tag, false))
    const now = Date.now()
    const running = isRunning(turn)
    const live = running && turn.startedAt > 0 ? { ...turn, digElapsedMs: Math.max(turn.digElapsedMs, now - turn.startedAt) } : turn
    const status = askStatusLine(live, now)
    const line = el('span', `fb-ask-status fb-ask-status-${status?.tone ?? 'plain'}`)
    line.dataset['ask'] = 'status'
    if (status !== null) {
      if (status.tone === 'busy') {
        const spin = icon(ICON_SPIN, 12)
        spin.classList.add('fb-ask-spin')
        line.appendChild(spin)
      } else {
        line.appendChild(el('span', 'fb-ask-status-dot'))
      }
      line.appendChild(el('span', 'fb-ask-status-text', status.text))
    } else if (turn.phase === 'error') {
      line.appendChild(el('span', 'fb-ask-status-dot'))
      line.appendChild(el('span', 'fb-ask-status-text', 'Not answered'))
      line.classList.add('fb-ask-status-error')
    }
    this.#meta.appendChild(line)
    this.#meta.appendChild(el('span', 'fb-ask-spacer'))
    if (turn.steps.length > 0) {
      const toggle = button('fb-ask-link', this.#stepsOpen ? 'Hide steps' : 'Show steps', () => {
        this.#stepsOpen = !this.#stepsOpen
        this.#renderMeta()
        this.#renderAnswer()
      })
      toggle.setAttribute('aria-expanded', String(this.#stepsOpen))
      this.#meta.appendChild(toggle)
    }
    if (running && turn.askId !== null) {
      const stop = button('fb-ask-secondary fb-ask-small', turn.stopping ? 'Stopping…' : 'Stop', () => this.#stop(turn))
      stop.disabled = turn.stopping
      this.#meta.appendChild(stop)
    }
  }

  #renderAnswer(): void {
    const state = this.#state
    const scrollTop = this.#body.scrollTop
    this.#answer.replaceChildren()
    state.turns.forEach((turn, index) => {
      this.#answer.appendChild(this.#turnView(turn, index, index === state.turns.length - 1))
    })
    const last = currentTurn(state)
    this.#followInput.disabled = !canFollowUp(state)
    this.#followInput.placeholder =
      last !== null && isRunning(last) ? 'You can follow up when this answer is ready' : 'Ask a follow-up…'
    this.#continueBtn.disabled = last === null || last.answer === null
    // A state event re-renders the answer; the reader's place stays where it was.
    this.#body.scrollTop = scrollTop
  }

  #turnView(turn: AskTurn, index: number, newest: boolean): HTMLElement {
    const wrap = el('div', 'fb-ask-turn')
    wrap.dataset['turn'] = String(index)

    // A FOLLOW-UP shows its question; the first one is the sheet's header.
    if (index > 0) {
      const bubble = el('div', 'fb-ask-bubble')
      bubble.appendChild(el('div', 'fb-ask-bubble-text', turn.question))
      wrap.appendChild(bubble)
      if (!newest || !isRunning(turn)) {
        const status = askStatusLine(turn, Date.now())
        if (status !== null && turn.saved === null) wrap.appendChild(el('div', `fb-ask-turn-status fb-ask-status-${status.tone}`, status.text))
      }
    }
    if (newest && this.#stepsOpen && turn.steps.length > 0) wrap.appendChild(this.#steps(turn))
    if (newest && isRunning(turn) && turn.answer === null) {
      wrap.appendChild(el('p', 'fb-ask-muted fb-ask-waiting', 'The answer appears here as soon as there is one.'))
    }

    const answer = turn.answer
    if (answer !== null) {
      const running = isRunning(turn)
      if (turn.saved !== null && turn.saved.stale) {
        const stale = el('div', 'fb-ask-stale')
        stale.appendChild(el('span', '', 'The code under this answer changed since.'))
        stale.appendChild(button('fb-ask-secondary fb-ask-small', 'Ask again', () => this.#askAgain(turn)))
        wrap.appendChild(stale)
      }
      const doc = parseAnswer(answer.explanation, {
        sources: answer.sources,
        featureName: (id) => this.#host.featureLabel(id),
      })
      const docEl = el('div', 'fb-ask-doc')
      if (doc.lead !== null) docEl.appendChild(this.#inlineInto(el('div', 'fb-ask-lead'), doc.lead))
      for (const block of doc.blocks) docEl.appendChild(this.#block(block))
      wrap.appendChild(docEl)

      // NOT COVERED — everything the answer says it could not check, in one place.
      const gaps: string[] = []
      if (doc.notCovered !== null) gaps.push(doc.notCovered)
      if (!running && answer.couldNotFind !== undefined && answer.couldNotFind.trim() !== '') gaps.push(answer.couldNotFind)
      if (!running && answer.confidence === 'first' && answer.thin) gaps.push('What Flow knows about this is thin, and the code was not checked.')
      if (!running) {
        const knowledge = knowledgeOnlySentence(answer.knowledgeOnly ?? [], (slug) => this.#projectName(slug))
        if (knowledge !== null) gaps.push(knowledge)
      }
      if (gaps.length > 0) {
        const gap = el('div', 'fb-ask-gap')
        gap.append(el('strong', '', 'Not covered: '), document.createTextNode(gaps.join(' ')))
        wrap.appendChild(gap)
      }

      if (answer.verdict !== undefined || answer.branchInProgress !== undefined) wrap.appendChild(this.#verdictCard(answer.verdict, answer.branchInProgress))
      if (answer.sources.length > 0) wrap.appendChild(this.#sourcesList(answer.sources))
      if (answer.reply !== undefined && answer.reply.trim() !== '') wrap.appendChild(this.#replyCard(answer.reply, index))
      if (!running) {
        const suggested = answer.suggestedConnections ?? []
        if (suggested.length > 0 && this.#state.scope.kind === 'workspace') wrap.appendChild(this.#connectionsCard(suggested))
        const foot = this.#answerFoot(turn)
        if (foot !== null) wrap.appendChild(foot)
      }
    }

    if (turn.phase === 'error' && turn.error !== null) wrap.appendChild(el('p', 'fb-ask-error', turn.error))
    return wrap
  }

  #block(block: AnswerBlock): HTMLElement {
    switch (block.kind) {
      case 'heading':
        return this.#inlineInto(el('h4', 'fb-ask-h'), block.inline)
      case 'paragraph':
        return this.#inlineInto(el('p', 'fb-ask-p'), block.inline)
      case 'list': {
        const list = el('ul', 'fb-ask-ul')
        for (const item of block.items) list.appendChild(this.#inlineInto(el('li'), item))
        return list
      }
    }
  }

  /** Inline pieces as DOM — text nodes and chips; model text never becomes markup. */
  #inlineInto<T extends HTMLElement>(target: T, inline: readonly AnswerInline[]): T {
    for (const piece of inline) {
      switch (piece.kind) {
        case 'text':
          target.appendChild(document.createTextNode(piece.text))
          break
        case 'strong':
          target.appendChild(el('strong', '', piece.text))
          break
        case 'code':
          target.appendChild(el('code', 'fb-ask-code', piece.text))
          break
        case 'file':
          target.appendChild(this.#fileChip(piece.text, piece.path, piece.project))
          break
        case 'feature':
          target.appendChild(this.#featureChip(piece.id, piece.label))
          break
        case 'cite':
          target.appendChild(this.#citeMarker(piece.n))
          break
      }
    }
    return target
  }

  /** A file chip: pressing it opens the file in the editor, when it can be found here. */
  #fileChip(text: string, path: string | null, project: string | undefined): HTMLElement {
    if (path === null || !this.#host.canOpenFile(project)) {
      const chip = el('span', 'fb-ask-file', text)
      chip.dataset['ask'] = 'file'
      return chip
    }
    const chip = button('fb-ask-file', text, () => {
      this.close()
      this.#host.openFile(path, project)
    })
    chip.dataset['ask'] = 'file'
    chip.title = `Open ${path}`
    return chip
  }

  /** A feature chip: pressing it closes the sheet and opens that feature on the board. */
  #featureChip(id: string, label: string): HTMLElement {
    const go = this.#host.featureTarget(id)
    const chip = go === null ? el('span', 'fb-ask-feat') : button('fb-ask-feat', '', () => {
      this.close()
      go()
    })
    chip.dataset['ask'] = 'feature'
    chip.dataset['featureId'] = id
    chip.append(el('span', 'fb-ask-feat-dot'), document.createTextNode(label))
    if (go !== null) chip.title = `Open ${label} on the Blueprint`
    return chip
  }

  /** [n] — pressing it scrolls to source n of the same answer. */
  #citeMarker(n: number): HTMLElement {
    const marker = button('fb-ask-cite', String(n), () => this.#focusSource(marker, n), `Source ${String(n)}`)
    marker.dataset['ask'] = 'cite'
    return marker
  }

  #focusSource(from: HTMLElement, n: number): void {
    const turn = from.closest('.fb-ask-turn') ?? this.#answer
    const row = turn.querySelector<HTMLElement>(`[data-source-n="${String(n)}"]`)
    if (row === null) return
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    row.classList.add('is-flash')
    window.setTimeout(() => row.classList.remove('is-flash'), 1200)
    row.focus({ preventScroll: true })
  }

  #steps(turn: AskTurn): HTMLElement {
    const steps = el('div', 'fb-ask-steps')
    steps.dataset['ask'] = 'steps'
    for (const step of turn.steps) {
      const line = el('div', `fb-ask-step fb-ask-step-${step.state}`)
      if (step.state === 'done') line.appendChild(icon(ICON_CHECK, 11))
      else line.appendChild(el('span', 'fb-ask-step-dot'))
      line.appendChild(document.createTextNode(step.label))
      steps.appendChild(line)
    }
    return steps
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

  /** The reply, folded to one row with Show and Copy. */
  #replyCard(reply: string, index: number): HTMLElement {
    const card = el('div', 'fb-ask-reply')
    card.dataset['ask'] = 'reply'
    const head = el('div', 'fb-ask-reply-head')
    const open = this.#repliesOpen.has(index)
    const show = button('fb-ask-secondary fb-ask-small', open ? 'Hide' : 'Show', () => {
      if (this.#repliesOpen.has(index)) this.#repliesOpen.delete(index)
      else this.#repliesOpen.add(index)
      this.#renderAnswer()
    })
    show.setAttribute('aria-expanded', String(open))
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
    head.append(el('span', 'fb-ask-reply-title', 'Reply ready to send to the person who asked'), el('span', 'fb-ask-spacer'), show, copy)
    card.appendChild(head)
    if (open) card.appendChild(el('div', 'fb-ask-reply-text', reply))
    return card
  }

  #sourcesList(sources: AskSource[]): HTMLElement {
    const list = el('div', 'fb-ask-sources')
    list.dataset['ask'] = 'sources'
    list.appendChild(el('div', 'fb-ask-caps', 'Sources'))
    const workspace = this.#state.scope.kind === 'workspace'
    sources.forEach((source, index) => {
      const n = source.n ?? index + 1
      const row = el('div', 'fb-ask-source')
      row.dataset['sourceN'] = String(n)
      row.tabIndex = -1
      row.appendChild(el('span', 'fb-ask-cite fb-ask-cite-static', String(n)))
      if (workspace && source.project !== undefined) row.appendChild(this.#projectPrefix(source.project))
      if (source.featureId !== undefined) {
        const name = this.#host.featureLabel(source.featureId) ?? labelOfId(source.featureId)
        row.appendChild(this.#featureChip(source.featureId, name))
      }
      if (source.file !== undefined) row.appendChild(this.#fileChip(source.file, source.file, source.project))
      const label = source.label.trim()
      if (label !== '') row.appendChild(el('span', 'fb-ask-source-label', label))
      row.appendChild(el('em', 'fb-ask-source-kind', source.file !== undefined ? 'read in the code' : 'from knowledge'))
      list.appendChild(row)
    })
    return list
  }

  /** One end of a suggested connection: "jupiter-app › Connectors", in its project's colour. */
  #connectionEnd(end: AskConnectionEnd): HTMLElement {
    const name = end.featureId === null ? null : this.#host.featureName(end.project, end.featureId)
    const label = name ?? (end.featureId !== null ? labelOfId(end.featureId) : end.ref)
    const look = this.#projectLook(end.project)
    const span = el('span', 'fb-ask-proj', `${look.name} › ${label}`)
    if (look.color !== null) span.style.setProperty('--fb-ask-proj', look.color)
    return span
  }

  #connectionsCard(connections: AskSuggestedConnection[]): HTMLElement {
    const card = el('div', 'fb-ask-connections')
    card.appendChild(el('div', 'fb-ask-caps', connections.length === 1 ? 'Connection found, not yet recorded' : 'Connections found, not yet recorded'))
    for (const connection of connections) {
      const view = connectionView(connection)
      const row = el('div', 'fb-ask-connection')
      const words = el('span', 'fb-ask-connection-words')
      words.append(this.#connectionEnd(view.from), document.createTextNode(` ${view.verb} `), this.#connectionEnd(view.to))
      if (connection.note !== undefined && connection.note.trim() !== '') words.title = connection.note
      const state = connectionButton(this.#state.connections[connection.id])
      const save = button('fb-ask-secondary fb-ask-small fb-ask-save-conn', state.label, () => void this.#saveConnection(connection))
      save.disabled = state.disabled
      save.dataset['connection'] = connection.id
      row.append(words, el('span', 'fb-ask-spacer'), save)
      card.appendChild(row)
      if (state.note !== null) card.appendChild(el('div', 'fb-ask-muted', state.note))
    }
    return card
  }

  #answerFoot(turn: AskTurn): HTMLElement | null {
    const answer = turn.answer
    if (answer === null) return null
    const lines: HTMLElement[] = []
    const facts = factsSentence(turn, (id) => this.#host.featureLabel(id))
    if (facts !== null) {
      const line = el('div', 'fb-ask-learn')
      line.dataset['ask'] = 'learned'
      line.append(icon(ICON_CHECK, 12), document.createTextNode(facts))
      lines.push(line)
    }
    if (!answer.factsSaved) lines.push(el('div', 'fb-ask-warn-text', "The facts this answer found couldn't be saved. The answer stands."))
    const saved = savedSentence(turn, this.#state.scope, (slug) => this.#projectName(slug))
    if (saved !== null) lines.push(el('div', 'fb-ask-saved-line', saved))
    else if (turn.saved !== null && turn.saved.usedConversation) {
      lines.push(el('div', 'fb-ask-saved-line', 'Used one of your conversations (its content stays private).'))
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
 * Draw (or clear, with null) one cell's Ask marks. Since the sheet covers the
 * map, the board passes null for every cell — kept so the decoration path has
 * one clearing step.
 */
export function paintCellMarks(cell: HTMLElement, mark: AskCellMark | null): void {
  cell.classList.remove(...MARK_CLASSES)
  cell.querySelector(':scope > .fb-terr-ask-marks')?.remove()
  if (mark === null) return
  if (mark.role !== null) cell.classList.add(`fb-terr-ask-${mark.role}`)
  const chips: HTMLElement[] = []
  if (mark.live !== null) chips.push(el('span', `fb-terr-ask-chip fb-terr-ask-live-${mark.live}`, LIVE_WORDS[mark.live]))
  for (const { n, label } of mark.numbers) chips.push(el('span', 'fb-terr-ask-chip', `${n} · ${label}`))
  if (chips.length === 0) return
  const box = el('div', 'fb-terr-ask-marks')
  box.setAttribute('aria-hidden', 'true')
  box.append(...chips)
  cell.appendChild(box)
}

/**
 * THE QUESTIONS YOU ASKED, ON THE MAP: a quiet speech-bubble and a count in a
 * cell's footer row (its kicker), for a feature the person has saved
 * questions about. Pressing it opens the sheet on that feature's questions.
 * Null (or 0) removes it. The board calls this once per drawn cell when the
 * sheet is drawn or the saved list was read — never per broadcast.
 */
export function paintQuestionMarker(cell: HTMLElement, count: number, label: string, press: () => void): void {
  cell.querySelector('.fb-terr-asked')?.remove()
  if (count <= 0) return
  const host = cell.querySelector<HTMLElement>(':scope > .fb-terr-cell-kicker') ?? cell
  const marker = document.createElement('button')
  marker.type = 'button'
  marker.className = 'fb-terr-asked'
  marker.dataset['ask'] = 'cell-questions'
  marker.setAttribute('aria-label', label)
  marker.title = label
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', 'message')
  marker.append(glyph, document.createTextNode(String(count)))
  marker.addEventListener('click', (event) => {
    event.stopPropagation()
    press()
  })
  marker.addEventListener('keydown', (event) => event.stopPropagation())
  // The cell's own press handlers never see a press on the marker.
  marker.addEventListener('mousedown', (event) => event.stopPropagation())
  marker.addEventListener('pointerdown', (event) => event.stopPropagation())
  host.appendChild(marker)
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
  /* THE SHEET'S TOKENS — light is the base, dark the one override (as the board's). */
  .flow-board-root {
    --fb-ask-dimmer: rgba(15, 23, 42, 0.32);
    --fb-ask-sheet: #ffffff;
    --fb-ask-border: #d9dde3;
    --fb-ask-rule: #e6e9ee;
    --fb-ask-shadow: 0 18px 48px rgba(15, 23, 42, 0.24);
    --fb-ask-field: #f6f7f9;
    --fb-ask-accent: #1f8fcf;
    --fb-ask-ring: rgba(31, 143, 207, 0.16);
    --fb-ask-ink: #1d2128;
    --fb-ask-body: #353b45;
    --fb-ask-mute: #6b727d;
    --fb-ask-chip-bg: #f1f3f5;
    --fb-ask-chip-border: #d9dde3;
    --fb-ask-chip-ink: #2a2f37;
    --fb-ask-row-bg: #f8f9fb;
    --fb-ask-row-border: #e3e6eb;
    --fb-ask-row-hover: #eef4f9;
    --fb-ask-code-bg: #eef1f4;
    --fb-ask-code-border: #dde2e8;
    --fb-ask-feat-bg: rgba(31, 143, 207, 0.08);
    --fb-ask-feat-border: rgba(31, 143, 207, 0.4);
    --fb-ask-feat-ink: #12699a;
    --fb-ask-cite-bg: #e1eff8;
    --fb-ask-cite-ink: #12699a;
    --fb-ask-gap-border: #c9a24a;
    --fb-ask-gap-bg: rgba(232, 176, 75, 0.1);
    --fb-ask-gap-ink: #7a5610;
    --fb-ask-good: #2f8f5f;
    --fb-ask-good-dot: #34a56d;
    --fb-ask-warn: #b07812;
    --fb-ask-kbd-border: #cfd4db;
  }
  :root[data-theme='dark'] .flow-board-root {
    --fb-ask-dimmer: rgba(6, 10, 14, 0.55);
    --fb-ask-sheet: #151a21;
    --fb-ask-border: #2e333c;
    --fb-ask-rule: #232a33;
    --fb-ask-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
    --fb-ask-field: #0f1216;
    --fb-ask-accent: #6cc3f0;
    --fb-ask-ring: rgba(108, 195, 240, 0.15);
    --fb-ask-ink: #eef0f3;
    --fb-ask-body: #c9cdd3;
    --fb-ask-mute: #7d838d;
    --fb-ask-chip-bg: #1b222b;
    --fb-ask-chip-border: #2c3440;
    --fb-ask-chip-ink: #d6dae0;
    --fb-ask-row-bg: #181e26;
    --fb-ask-row-border: #232a33;
    --fb-ask-row-hover: #1d2530;
    --fb-ask-code-bg: #1e2630;
    --fb-ask-code-border: #2a3440;
    --fb-ask-feat-bg: rgba(108, 195, 240, 0.1);
    --fb-ask-feat-border: rgba(108, 195, 240, 0.35);
    --fb-ask-feat-ink: #9fd8f5;
    --fb-ask-cite-bg: #22303c;
    --fb-ask-cite-ink: #9fd8f5;
    --fb-ask-gap-border: #5a4a2a;
    --fb-ask-gap-bg: rgba(232, 176, 75, 0.06);
    --fb-ask-gap-ink: #e3c48a;
    --fb-ask-good: #7fd3a6;
    --fb-ask-good-dot: #4fbf8a;
    --fb-ask-warn: #e3b25a;
    --fb-ask-kbd-border: #343a45;
  }

  /* THE ISLAND FIELD — the small entry; its island look is the board's. */
  .flow-board-root .fb-askf {
    flex: 0 1 320px;
    width: 320px;
    max-width: 34vw;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    padding: 0 6px 0 10px;
    background: var(--fl-color-surface-sunken, var(--fb-paper));
    border: 1px solid var(--fl-color-border, var(--fb-border));
    border-radius: var(--fl-radius-md, 8px);
    color: var(--fl-color-text-muted, var(--fb-ink-dim));
    font-family: var(--fl-font-ui, system-ui, sans-serif);
    font-size: 13px;
    cursor: text;
  }
  .flow-board-root .fb-askf:hover { border-color: var(--fl-color-border-strong, var(--fb-card-border)); }
  .flow-board-root .fb-askf.is-asking { border-color: var(--fb-ask-accent); }
  .flow-board-root .fb-askf-spark { flex: none; color: var(--fb-accent); }
  .flow-board-root .fb-askf-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 20px;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fl-color-text, var(--fb-ink));
    font: inherit;
    font-size: 13px;
    line-height: 20px;
    resize: none;
    overflow: hidden;
    white-space: pre;
    outline: none;
    cursor: pointer;
    caret-color: transparent;
  }
  .flow-board-root .fb-askf-input::placeholder { color: var(--fl-color-text-muted, var(--fb-ink-dim)); }
  .flow-board-root .fb-askf:focus-within { border-color: var(--fb-ask-accent); }
  .flow-board-root .fb-askf-key {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--fl-color-border, var(--fb-border));
    border-radius: var(--fl-radius-sm, 4px);
    color: var(--fl-color-text-muted, var(--fb-ink-dim));
    font-family: var(--fl-font-mono, ui-monospace, monospace);
    font-size: 11px;
    line-height: 18px;
  }

  /* A project's colour on a chip, a picker row or a source. */
  .flow-board-root .fb-ask-proj { color: var(--fb-ask-proj, var(--fb-ask-mute)); white-space: nowrap; }
  .flow-board-root .fb-ask-swatch {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--fb-ask-proj, var(--fb-ask-mute));
  }

  /* THE DIM LAYER — the whole board, under the sheet. */
  .flow-board-root { position: relative; }
  .flow-board-root .fb-ask-dim {
    position: absolute;
    inset: 0;
    z-index: 60;
    background: var(--fb-ask-dimmer);
  }
  .flow-board-root .fb-ask-dim[hidden] { display: none; }

  /* THE SHEET — 760px, centred, under the island's height. */
  .flow-board-root .fb-ask {
    position: absolute;
    left: 50%;
    top: 56px;
    transform: translateX(-50%);
    width: 760px;
    max-width: calc(100% - 48px);
    max-height: calc(100% - 96px);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--fb-ask-sheet);
    color: var(--fb-ask-ink);
    border: 1px solid var(--fb-ask-border);
    border-radius: 14px;
    box-shadow: var(--fb-ask-shadow);
    font-family: var(--fl-font-ui, Inter, system-ui, sans-serif);
    font-size: 13px;
    overflow: hidden;
    outline: none;
  }
  .flow-board-root .fb-ask [hidden] { display: none !important; }
  .flow-board-root .fb-ask-spacer { flex: 1; }

  .flow-board-root .fb-ask-head {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--fb-ask-rule);
  }
  .flow-board-root .fb-ask[data-view='answer'] .fb-ask-head { gap: 8px; }
  .flow-board-root .fb-ask-big {
    height: 44px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 0 14px;
    background: var(--fb-ask-field);
    border: 1px solid var(--fb-ask-accent);
    box-shadow: 0 0 0 3px var(--fb-ask-ring);
    border-radius: 10px;
    cursor: text;
  }
  .flow-board-root .fb-ask-big-spark { flex: none; color: var(--fb-ask-accent); }
  .flow-board-root .fb-ask-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 22px;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fb-ask-ink);
    font: inherit;
    font-size: 15px;
    line-height: 22px;
    resize: none;
    overflow: hidden;
    white-space: pre;
    outline: none;
  }
  .flow-board-root .fb-ask-input::placeholder { color: var(--fb-ask-mute); opacity: 1; }
  .flow-board-root .fb-ask-esc,
  .flow-board-root .fb-ask-kbd {
    flex: none;
    font-family: var(--fl-font-mono, ui-monospace, monospace);
    font-size: 11px;
    line-height: 18px;
    padding: 0 6px;
    border: 1px solid var(--fb-ask-kbd-border);
    border-radius: 4px;
    color: var(--fb-ask-mute);
    background: transparent;
  }
  .flow-board-root .fb-ask-big .fb-ask-esc { cursor: pointer; }

  .flow-board-root .fb-ask-scope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--fb-ask-mute);
  }
  .flow-board-root .fb-ask-scope-label { margin-right: 2px; }
  .flow-board-root .fb-ask-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    box-sizing: border-box;
    background: var(--fb-ask-chip-bg);
    border: 1px solid var(--fb-ask-chip-border);
    border-radius: 999px;
    color: var(--fb-ask-chip-ink);
    font-size: 12px;
    white-space: nowrap;
  }
  .flow-board-root .fb-ask-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fb-ask-accent); flex: none; }
  .flow-board-root .fb-ask-chip-x {
    background: none;
    border: 0;
    padding: 0 0 0 2px;
    color: var(--fb-ask-mute);
    font: inherit;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-chip-x:hover { color: var(--fb-ask-ink); }
  .flow-board-root .fb-ask-add {
    background: none;
    border: 0;
    padding: 0 4px;
    color: var(--fb-ask-accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-add:hover { text-decoration: underline; }

  .flow-board-root .fb-ask-qhead { display: flex; align-items: flex-start; gap: 10px; }
  .flow-board-root .fb-ask-qtitle {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--fb-ask-ink);
    overflow-wrap: anywhere;
  }
  .flow-board-root .fb-ask-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-height: 26px;
    font-size: 12px;
    color: var(--fb-ask-mute);
  }

  .flow-board-root .fb-ask-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 18px 16px;
  }
  .flow-board-root .fb-ask-compose { display: flex; flex-direction: column; gap: 14px; }
  .flow-board-root .fb-ask-cols { display: flex; gap: 18px; }
  .flow-board-root .fb-ask-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .flow-board-root .fb-ask-col-head { display: flex; align-items: center; gap: 8px; }
  @media (max-width: 640px) {
    .flow-board-root .fb-ask-cols { flex-direction: column; }
  }
  .flow-board-root .fb-ask-caps,
  .flow-board-root .fb-ask-picker-kind {
    font-family: var(--fl-font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--fb-ask-mute);
  }
  .flow-board-root .fb-ask-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    box-sizing: border-box;
    background: var(--fb-ask-row-bg);
    border: 1px solid var(--fb-ask-row-border);
    border-radius: 9px;
    color: var(--fb-ask-chip-ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-row:hover,
  .flow-board-root .fb-ask-row:focus-visible { background: var(--fb-ask-row-hover); border-color: var(--fb-ask-feat-border); outline: none; }
  .flow-board-root .fb-ask-row > svg { flex: none; color: var(--fb-ask-accent); }
  .flow-board-root .fb-ask-row-q { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flow-board-root .fb-ask-row em { flex: none; font-style: normal; color: var(--fb-ask-mute); font-size: 11.5px; }
  .flow-board-root .fb-ask-rows { display: flex; flex-direction: column; gap: 6px; }

  .flow-board-root .fb-ask-hints {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px;
    border-top: 1px solid var(--fb-ask-rule);
    color: var(--fb-ask-mute);
    font-size: 11.5px;
  }
  .flow-board-root .fb-ask-keyhint { display: inline-flex; align-items: center; gap: 6px; }

  .flow-board-root .fb-ask-pick { display: flex; flex-direction: column; gap: 2px; }
  .flow-board-root .fb-ask-pick-head { padding: 0 8px 6px; }
  .flow-board-root .fb-ask-pick-list { display: flex; flex-direction: column; gap: 2px; }
  .flow-board-root .fb-ask-picker-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    flex: none;
    padding: 8px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--fb-ask-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-picker-row:hover { background: var(--fb-ask-row-bg); }
  .flow-board-root .fb-ask-picker-row.on { background: var(--fb-ask-feat-bg); }
  .flow-board-root .fb-ask-picker-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flow-board-root .fb-ask-picker-empty { padding: 6px 8px; color: var(--fb-ask-mute); font-size: 12px; }

  .flow-board-root .fb-ask-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--fb-ask-row-bg);
    border: 1px solid var(--fb-ask-row-border);
    border-radius: 10px;
  }
  .flow-board-root .fb-ask-suggest-head { font-size: 12px; color: var(--fb-ask-ink); }
  .flow-board-root .fb-ask-suggest-row,
  .flow-board-root .fb-ask-suggest-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .flow-board-root .fb-ask-suggest-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    background: transparent;
    border: 1px dashed var(--fb-ask-chip-border);
    border-radius: 6px;
    color: var(--fb-ask-ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-suggest-chip:hover { border-color: var(--fb-ask-accent); color: var(--fb-ask-accent); }

  .flow-board-root .fb-ask-history { display: flex; flex-direction: column; gap: 12px; }
  .flow-board-root .fb-ask-history-head { display: flex; align-items: center; gap: 6px; margin: -4px 0 0 -6px; }
  .flow-board-root .fb-ask-history-title { font-size: 14px; font-weight: 600; color: var(--fb-ask-ink); }

  .flow-board-root .fb-ask-secondary {
    height: 26px;
    padding: 0 10px;
    background: var(--fb-ask-chip-bg);
    border: 1px solid var(--fb-ask-chip-border);
    border-radius: 6px;
    color: var(--fb-ask-chip-ink);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .flow-board-root .fb-ask-secondary:hover:not(:disabled) { border-color: var(--fb-ask-accent); }
  .flow-board-root .fb-ask-secondary:disabled { opacity: 0.5; cursor: default; }
  .flow-board-root .fb-ask-small { height: 24px; padding: 0 9px; }
  .flow-board-root .fb-ask-quiet,
  .flow-board-root .fb-ask-link {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--fb-ask-accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .flow-board-root .fb-ask-quiet { color: var(--fb-ask-mute); }
  .flow-board-root .fb-ask-quiet:hover,
  .flow-board-root .fb-ask-link:hover { text-decoration: underline; }
  .flow-board-root .fb-ask-newq { margin-top: 2px; }
  .flow-board-root .fb-ask-icon-btn {
    flex: none;
    min-width: 28px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 2px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--fb-ask-mute);
    cursor: pointer;
  }
  .flow-board-root .fb-ask-icon-btn:hover { background: var(--fb-ask-row-bg); color: var(--fb-ask-ink); }

  /* STATUS — one row, in the header. */
  .flow-board-root .fb-ask-status { display: inline-flex; align-items: center; gap: 8px; color: var(--fb-ask-mute); }
  .flow-board-root .fb-ask-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fb-ask-mute); flex: none; }
  .flow-board-root .fb-ask-status-good .fb-ask-status-dot { background: var(--fb-ask-good-dot); }
  .flow-board-root .fb-ask-status-warn .fb-ask-status-dot { background: var(--fb-ask-warn); }
  .flow-board-root .fb-ask-status-error .fb-ask-status-dot { background: var(--fb-danger, #d14b4b); }
  .flow-board-root .fb-ask-status-busy { color: var(--fb-ask-body); }
  .flow-board-root .fb-ask-status-busy svg { color: var(--fb-ask-accent); }
  .flow-board-root .fb-ask-spin { animation: fb-ask-spin 1s linear infinite; }
  @keyframes fb-ask-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .flow-board-root .fb-ask-spin { animation: none; } }
  .flow-board-root .fb-ask-turn-status { font-size: 12px; color: var(--fb-ask-mute); }

  .flow-board-root .fb-ask-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--fb-ask-row-border);
    border-radius: 9px;
    background: var(--fb-ask-row-bg);
    font-size: 12px;
    color: var(--fb-ask-mute);
  }
  .flow-board-root .fb-ask-step { display: flex; align-items: center; gap: 8px; }
  .flow-board-root .fb-ask-step-done { color: var(--fb-ask-good); }
  .flow-board-root .fb-ask-step-current { color: var(--fb-ask-ink); }
  .flow-board-root .fb-ask-step-dot { width: 6px; height: 6px; margin: 0 2.5px; border-radius: 50%; background: var(--fb-ask-accent); }

  /* THE ANSWER — a lead, short sections, real lists. */
  .flow-board-root .fb-ask-answer { display: flex; flex-direction: column; gap: 22px; }
  .flow-board-root .fb-ask-turn { display: flex; flex-direction: column; gap: 16px; }
  .flow-board-root .fb-ask-doc { display: flex; flex-direction: column; gap: 12px; }
  .flow-board-root .fb-ask-lead { font-size: 14.5px; line-height: 1.5; font-weight: 500; color: var(--fb-ask-ink); }
  .flow-board-root .fb-ask-h {
    margin: 4px 0 -6px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--fb-ask-ink);
  }
  .flow-board-root .fb-ask-p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--fb-ask-body); }
  .flow-board-root .fb-ask-ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--fb-ask-body); }
  .flow-board-root .fb-ask-ul li + li { margin-top: 2px; }
  .flow-board-root .fb-ask-code {
    font-family: var(--fl-font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 11.5px;
    padding: 0 5px;
    background: var(--fb-ask-code-bg);
    border: 1px solid var(--fb-ask-code-border);
    border-radius: 4px;
    color: var(--fb-ask-chip-ink);
    overflow-wrap: anywhere;
  }
  .flow-board-root .fb-ask-file {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    padding: 1px 6px;
    box-sizing: border-box;
    font-family: var(--fl-font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.45;
    background: var(--fb-ask-chip-bg);
    border: 1px solid var(--fb-ask-chip-border);
    border-radius: 5px;
    color: var(--fb-ask-chip-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: baseline;
  }
  .flow-board-root button.fb-ask-file { cursor: pointer; }
  .flow-board-root button.fb-ask-file:hover { border-color: var(--fb-ask-accent); color: var(--fb-ask-ink); }
  .flow-board-root .fb-ask-feat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 7px;
    font: inherit;
    font-size: 12px;
    line-height: 1.45;
    background: var(--fb-ask-feat-bg);
    border: 1px solid var(--fb-ask-feat-border);
    border-radius: 5px;
    color: var(--fb-ask-feat-ink);
    white-space: nowrap;
    vertical-align: baseline;
  }
  .flow-board-root button.fb-ask-feat { cursor: pointer; }
  .flow-board-root button.fb-ask-feat:hover { border-color: var(--fb-ask-accent); }
  .flow-board-root .fb-ask-feat-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fb-ask-accent); flex: none; }
  .flow-board-root .fb-ask-cite {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 15px;
    height: 15px;
    margin-left: 2px;
    padding: 0 3px;
    box-sizing: border-box;
    border: 0;
    border-radius: 4px;
    background: var(--fb-ask-cite-bg);
    color: var(--fb-ask-cite-ink);
    font-family: var(--fl-font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 10px;
    line-height: 15px;
    vertical-align: 1px;
    cursor: pointer;
  }
  .flow-board-root button.fb-ask-cite:hover { outline: 1px solid var(--fb-ask-accent); }
  .flow-board-root .fb-ask-cite-static { cursor: default; margin-left: 0; flex: none; }

  .flow-board-root .fb-ask-gap {
    padding: 9px 12px;
    border: 1px dashed var(--fb-ask-gap-border);
    background: var(--fb-ask-gap-bg);
    border-radius: 9px;
    color: var(--fb-ask-gap-ink);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .flow-board-root .fb-ask-gap strong { font-weight: 600; }

  .flow-board-root .fb-ask-sources { display: flex; flex-direction: column; gap: 5px; }
  .flow-board-root .fb-ask-source {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 2px 4px;
    margin: 0 -4px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--fb-ask-body);
    outline: none;
    transition: background 0.3s;
  }
  .flow-board-root .fb-ask-source.is-flash { background: var(--fb-ask-feat-bg); }
  .flow-board-root .fb-ask-source-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flow-board-root .fb-ask-source-kind { margin-left: auto; flex: none; font-style: normal; font-size: 11px; color: var(--fb-ask-mute); }

  .flow-board-root .fb-ask-reply {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 9px 12px;
    border: 1px solid var(--fb-ask-row-border);
    background: var(--fb-ask-row-bg);
    border-radius: 9px;
    font-size: 12.5px;
    color: var(--fb-ask-body);
  }
  .flow-board-root .fb-ask-reply-head { display: flex; align-items: center; gap: 8px; }
  .flow-board-root .fb-ask-reply-text { line-height: 1.5; white-space: pre-wrap; color: var(--fb-ask-ink); }

  .flow-board-root .fb-ask-answer-foot { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fb-ask-mute); }
  .flow-board-root .fb-ask-learn { display: flex; align-items: center; gap: 8px; color: var(--fb-ask-good); }
  .flow-board-root .fb-ask-saved-line { color: var(--fb-ask-mute); }
  .flow-board-root .fb-ask-muted { margin: 0; color: var(--fb-ask-mute); font-size: 12px; line-height: 1.5; }
  .flow-board-root .fb-ask-warn-text { color: var(--fb-ask-warn); }
  .flow-board-root .fb-ask-error { margin: 0; color: var(--fb-danger, #d14b4b); font-size: 12px; line-height: 1.5; }
  .flow-board-root .fb-ask-bubble {
    align-self: flex-end;
    max-width: 88%;
    padding: 9px 12px;
    background: var(--fb-ask-row-bg);
    border: 1px solid var(--fb-ask-row-border);
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    color: var(--fb-ask-ink);
  }
  .flow-board-root .fb-ask-stale {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--fb-ask-gap-bg);
    color: var(--fb-ask-gap-ink);
    font-size: 12px;
  }
  .flow-board-root .fb-ask-stale > span { flex: 1; }
  .flow-board-root .fb-ask-verdict {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--fb-ask-feat-bg);
    border: 1px solid var(--fb-ask-feat-border);
    border-radius: 9px;
  }
  .flow-board-root .fb-ask-verdict-head { display: flex; align-items: center; gap: 8px; }
  .flow-board-root .fb-ask-verdict-label { font-size: 12px; font-weight: 600; color: var(--fb-ask-feat-ink); }
  .flow-board-root .fb-ask-verdict-risk { line-height: 1.5; color: var(--fb-ask-body); font-size: 12.5px; }
  .flow-board-root .fb-ask-branch { display: flex; align-items: center; gap: 6px; color: var(--fb-ask-warn); font-size: 12px; }
  .flow-board-root .fb-ask-connections { display: flex; flex-direction: column; gap: 6px; }
  .flow-board-root .fb-ask-connection { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .flow-board-root .fb-ask-connection-words { min-width: 0; line-height: 1.5; }
  .flow-board-root .fb-ask-connection-words .fb-ask-proj { white-space: normal; }

  /* FOOTER — the follow-up field and Continue in a conversation. */
  .flow-board-root .fb-ask-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-top: 1px solid var(--fb-ask-rule);
  }
  .flow-board-root .fb-ask-follow {
    flex: 1;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    padding: 0 11px;
    background: var(--fb-ask-field);
    border: 1px solid var(--fb-ask-chip-border);
    border-radius: 8px;
    color: var(--fb-ask-ink);
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .flow-board-root .fb-ask-follow::placeholder { color: var(--fb-ask-mute); }
  .flow-board-root .fb-ask-follow:focus { border-color: var(--fb-ask-accent); }
  .flow-board-root .fb-ask-follow:disabled { opacity: 0.6; }
  .flow-board-root .fb-ask-foot .fb-ask-secondary { height: 32px; }

  /* THE QUESTIONS YOU ASKED, on a cell: quiet until the cell is pointed at. */
  .flow-board-root .fb-terr-asked {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 18px;
    margin-left: auto;
    padding: 0 5px;
    flex: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 9px;
    color: var(--fb-ink-dim);
    font: inherit;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.8;
    pointer-events: auto;
  }
  .flow-board-root .fb-terr-asked fl-icon { --fl-icon-size: 12px; }
  .flow-board-root .fb-terr-cell:hover .fb-terr-asked,
  .flow-board-root .fb-terr-asked:focus-visible { opacity: 1; color: var(--fb-accent); border-color: var(--fb-card-border); }
  .flow-board-root .fb-terr-asked:hover { background: var(--fb-paper); }

  /* The map's Ask marks — cleared while the sheet is open (it covers the map). */
  .flow-board-root .fb-terr-ask-marks {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    max-width: calc(100% - 12px);
    pointer-events: none;
  }
  .flow-board-root .fb-terr-ask-chip {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--fb-card);
    border: 1px solid var(--fb-border);
    color: var(--fb-ink);
    font-size: 11px;
    line-height: 1.5;
  }
`
