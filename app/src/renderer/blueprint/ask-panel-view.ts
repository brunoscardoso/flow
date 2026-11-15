// Ask the Blueprint — the header field and the panel under it (plans
// `ask_the_blueprint`, Phase 3, and `ask_the_blueprint_workspace`, Phase 3).
//
// ONE FIELD, ONE PANEL. The question is typed in a search-style field on the
// board's header (mockup G + D). Focusing it — a press, or "/" — widens it and
// opens the panel attached under it, at its width (mockup board 5). The panel
// is no longer a floating window: it grows down from the field, and the map
// stays visible and pressable under a light dim, so a press tags.
//
// THIN ON PURPOSE. Everything this panel decides — what each state says, what
// a follow-up waits for, what the map shows — is `ask-panel-model`'s pure
// reducer and its text helpers; matching pasted text and the @ picker are
// `ask-tag-suggest`'s. This file turns DOM events into model events, model
// state into DOM, and talks to main through `window.flow.ask`.
//
// THE FIELD OUTLIVES THE STRIP. The board rebuilds its header strip on every
// render, so the field is built once here and MOVED into each new strip
// (`mountField`) — the caret, the text and the focus survive a repaint.
//
// PAY ONLY WHILE OPEN (allowed-pattern #17). The `ask:state` subscription, the
// outside-press and resize listeners are taken when the panel opens and
// dropped when it closes; saved-question reads run only for the view on
// screen, and a read nobody is waiting for is dropped.
//
// No commands, paths or settings in its words (forbidden #12): a source shows
// a file NAME as a reference, and every error is main's plain sentence.

import type { AskSavedThread, AskSource, AskSuggestedConnection } from '../../shared/ask-contract'
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

/** What the board lends the panel. */
export interface AskPanelHost {
  /** The project the panel asks from (the Workspace is resolved from it), or null when none is open. */
  rootId: () => string | null
  /** The scope a fresh open asks: the sheet on screen decides. */
  scope: () => AskScope
  /** The Workspace's scope, when the board knows one — a pointer to a Workspace answer opens there. */
  workspaceScope: () => AskScope | null
  /** The features and parts for suggestions and the @ picker, in `scope`'s id grammar. */
  graphNodes: (scope: AskScope) => readonly SuggestNode[]
  /** Workspace scope: projects and connections for the @ picker. */
  extraCandidates: (scope: AskScope) => readonly PickerCandidate[]
  /** Project scope: which features "Saved questions" reads when nothing is tagged. */
  historyScope: () => string[]
  /** A project's name and colour (a CSS colour value), for chips and sources. */
  project: (slug: string) => { name: string; color: string | null } | null
  /** A feature's name in a project, when the board holds it. */
  featureName: (project: string, featureId: string) => string | null
  /** A press on this target tags, so it does not close the panel. */
  isMapTarget: (target: EventTarget | null) => boolean
  /** The state changed — the board redraws the map if what it shows changed. */
  onChange: (state: AskPanelState) => void
  /** Whether a source's file can be opened here: its project is the board's own. */
  canPeek: (project: string | undefined) => boolean
  /** Open a source's file in the board's read-only drawer. */
  peekFile: (relPath: string) => void
  /** A connection was recorded — the Workspace map is read again. */
  onConnectionSaved: () => void
  /** The panel closed from the keyboard — focus goes back to the board. */
  onClosed: () => void
}

const ASK_TIMEOUT_SENTENCE = "Flow couldn't start that question."
const SAVE_FAILED_SENTENCE = "Flow couldn't save that connection."
const LIST_DEBOUNCE_MS = 250
const THREAD_PICKER_LIMIT = 30
/** The panel is never narrower than this, even under a narrow field. */
const PANEL_MIN_WIDTH = 380

export const ASK_FIELD_PLACEHOLDER = 'Ask how something works…'

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

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** A key hint: the key cap, then what it does. */
function keyHint(key: string, what: string): HTMLElement {
  const hint = el('span', 'fb-ask-keyhint')
  hint.append(el('kbd', 'fb-ask-kbd', key), document.createTextNode(` ${what}`))
  return hint
}

/* ── The field and the panel ──────────────────────────────────────────── */

export class AskPanelView {
  /** The panel — placed on the board root, under the field. */
  readonly element: HTMLElement
  /** The header field — moved into each header strip the board builds. */
  readonly field: HTMLElement
  readonly #host: AskPanelHost
  #state: AskPanelState = initialAskState()

  // Persistent pieces — rebuilt never, so focus and the caret survive a repaint.
  readonly #fieldChips: HTMLElement
  readonly #fieldCount: HTMLElement
  readonly #textarea: HTMLTextAreaElement
  readonly #clearBtn: HTMLButtonElement
  readonly #fieldKey: HTMLElement
  readonly #body: HTMLElement
  readonly #pick: HTMLElement
  readonly #pickHead: HTMLElement
  readonly #pickList: HTMLElement
  readonly #compose: HTMLElement
  readonly #scopeLine: HTMLElement
  readonly #suggestions: HTMLElement
  readonly #askedBefore: HTMLElement
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
  #placeFrame: number | null = null

  constructor(host: AskPanelHost) {
    this.#host = host
    injectAskStyles()

    // ── THE FIELD ──────────────────────────────────────────────────────────
    this.field = el('div', 'fb-askf')
    this.field.dataset['ask'] = 'field'
    this.field.setAttribute('role', 'search')
    this.field.appendChild(icon(ICON_SPARK, 14, 16)).classList.add('fb-askf-spark')
    this.#fieldChips = el('span', 'fb-askf-chips')
    this.#fieldCount = el('span', 'fb-askf-count')
    this.#textarea = el('textarea', 'fb-askf-input')
    this.#textarea.rows = 1
    // One line, scrolling sideways: the field is a search field, not a page.
    this.#textarea.wrap = 'off'
    this.#textarea.placeholder = ASK_FIELD_PLACEHOLDER
    this.#textarea.setAttribute('aria-label', 'Ask how something works, or whether it can be built')
    this.#textarea.spellcheck = false
    this.#textarea.addEventListener('focus', () => {
      if (!this.#state.open) this.open({})
    })
    // A press on a field already focused (focus fires no event) opens it too.
    this.#textarea.addEventListener('mousedown', () => {
      if (!this.#state.open && document.activeElement === this.#textarea) this.open({})
    })
    this.#textarea.addEventListener('input', (event) => this.#onInput(event as InputEvent))
    this.#textarea.addEventListener('blur', () =>
      window.setTimeout(() => {
        if (document.activeElement !== this.#textarea) this.#closePicker()
      }, 150),
    )
    this.#textarea.addEventListener('keydown', (event) => this.#onKeydown(event))
    this.#clearBtn = button('fb-askf-clear', '×', () => this.#clear(), 'Clear the question')
    this.#clearBtn.title = 'Clear the question'
    this.#fieldKey = el('kbd', 'fb-askf-key', '/')
    this.#fieldKey.addEventListener('mousedown', (event) => {
      if (!this.#state.open) return
      event.preventDefault()
      event.stopPropagation()
      this.#closeFromKeyboard()
    })
    this.field.append(this.#fieldChips, this.#fieldCount, this.#textarea, this.#clearBtn, this.#fieldKey)
    // A press anywhere on the field puts the cursor in the question.
    this.field.addEventListener('mousedown', (event) => {
      const target = event.target as Element
      if (target === this.#textarea || target.closest('button') !== null) return
      if (target === this.#fieldKey && this.#state.open) return
      event.preventDefault()
      this.#focusField()
    })
    this.field.addEventListener('click', (event) => event.stopPropagation())

    // ── THE PANEL ──────────────────────────────────────────────────────────
    this.element = el('div', 'fb-ask')
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Ask the Blueprint')
    this.element.hidden = true
    // Clicks and keys inside the panel are the panel's, never the sheet's.
    this.element.addEventListener('click', (event) => event.stopPropagation())
    this.element.addEventListener('dblclick', (event) => event.stopPropagation())
    this.element.addEventListener('keydown', (event) => this.#onKeydown(event))

    this.#body = el('div', 'fb-ask-body')

    // THE @ LIST — the panel's whole body while a tag is being typed, so it
    // is never clipped by a scroll box it sits inside (user report, 2026-11-15).
    this.#pick = el('div', 'fb-ask-pick')
    this.#pickHead = el('div', 'fb-ask-caps fb-ask-pick-head')
    this.#pickList = el('div', 'fb-ask-pick-list')
    this.#pickList.setAttribute('role', 'listbox')
    this.#pickList.setAttribute('aria-label', 'Tags')
    this.#pick.append(this.#pickHead, this.#pickList)

    // COMPOSE — what is asked about, suggestions, asked before.
    this.#compose = el('div', 'fb-ask-compose')
    this.#scopeLine = el('div', 'fb-ask-scope')
    this.#suggestions = el('div', 'fb-ask-card fb-ask-suggest')
    this.#askedBefore = el('div', 'fb-ask-before')
    this.#compose.append(this.#scopeLine, this.#suggestions, this.#askedBefore)

    this.#answer = el('div', 'fb-ask-answer')
    this.#history = el('div', 'fb-ask-history')
    this.#body.append(this.#pick, this.#compose, this.#answer, this.#history)

    // KEY HINTS — the question box's, and the @ list's.
    this.#hints = el('div', 'fb-ask-hints')
    this.#hints.append(
      keyHint('↵', 'ask'),
      keyHint('@', 'tag'),
      keyHint('esc', 'close'),
      el('span', 'fb-ask-spacer'),
      button('fb-ask-quiet', 'Saved questions', () => this.#showHistory()),
    )
    this.#pickHints = el('div', 'fb-ask-hints')
    this.#pickHints.append(keyHint('↑↓', 'move'), keyHint('↵', 'add tag'), keyHint('esc', 'back to the question'))

    // FOOTER — the follow-up box and Continue in a conversation.
    this.#footer = el('div', 'fb-ask-foot')
    const followLabel = el('label', 'fb-ask-caps', 'Follow-up')
    this.#followInput = el('input', 'fb-ask-follow')
    this.#followInput.type = 'text'
    this.#followInput.id = `fb-ask-follow-${String(Math.random()).slice(2, 8)}`
    followLabel.htmlFor = this.#followInput.id
    this.#followInput.placeholder = 'Ask more about this answer…'
    this.#followInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      event.stopPropagation()
      this.#submit(true)
    })
    this.#continueBtn = button('fb-ask-secondary', 'Continue in a conversation', () => this.#continueInConversation())
    const followRow = el('div', 'fb-ask-follow-row')
    followRow.append(this.#followInput, this.#continueBtn)
    this.#footer.append(followLabel, followRow)

    this.element.append(this.#body, this.#hints, this.#pickHints, this.#footer)
    this.#render()
  }

  get state(): AskPanelState {
    return this.#state
  }

  get isOpen(): boolean {
    return this.#state.open
  }

  /**
   * Put the field in a header strip. The strip is rebuilt on every render, so
   * this MOVES the one field: a question being typed keeps its caret, and the
   * panel is placed again once the strip is on screen.
   */
  mountField(parent: HTMLElement): void {
    const focused = this.field.contains(document.activeElement)
    parent.appendChild(this.field)
    if (!focused && !this.#state.open) return
    window.requestAnimationFrame(() => {
      if (focused && this.field.isConnected) this.#textarea.focus({ preventScroll: true })
      this.#place()
    })
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
    this.#subscribe()
    this.#dispatch({ type: 'open', ...fresh, scope: nextScope })
    if (entryId !== undefined) {
      // A saved answer: the list is read (for its stale marks too) and the
      // entry opens in place of a question.
      this.#dispatch({ type: 'show-history' })
      void this.#readHistory(entryId)
      this.#focusField()
      return
    }
    if (view === 'history') {
      this.#showHistory()
      this.#focusField()
      return
    }
    if (submit === true && input.text !== undefined) {
      this.#textarea.value = input.text
      this.#submit(false)
      return
    }
    if (input.text !== undefined) this.#suggestFrom(input.text)
    this.#focusField()
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
   * A map piece pressed while the panel is open. In the question box it
   * becomes a chip; on an answer it starts a new question with that answer's
   * tags plus this one, keeping the question. While an answer is still coming
   * nothing changes, and false says so — the board then leaves the press alone.
   */
  addTagFromMap(tag: AskTag): boolean {
    const turn = currentTurn(this.#state)
    if (this.#state.view === 'answer' && turn !== null) {
      if (isRunning(turn)) return false
      const tags = [...turn.tags]
      if (!tags.some((existing) => existing.id === tag.id)) tags.push(tag)
      const question = turn.question
      this.#dispatch({ type: 'new-question' })
      for (const existing of tags) this.#dispatch({ type: 'add-tag', tag: existing })
      this.#dispatch({ type: 'draft', text: question })
      this.#focusField()
      return true
    }
    if (this.#state.view === 'history') this.#dispatch({ type: 'new-question' })
    this.#dispatch({ type: 'add-tag', tag })
    this.#focusField()
    return true
  }

  /** Place the panel under the field again — the board resized or re-laid its header. */
  reposition(): void {
    this.#place()
  }

  dispose(): void {
    this.close()
    if (this.#copyTimer !== null) window.clearTimeout(this.#copyTimer)
    if (this.#placeFrame !== null) window.cancelAnimationFrame(this.#placeFrame)
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
  }

  #subscribe(): void {
    if (this.#unsubscribe !== null) return
    const off =
      window.flow.ask?.onState((event) => {
        if (event.rootId !== this.#host.rootId()) return
        if (!this.#state.turns.some((turn) => turn.askId === event.askId)) return
        this.#dispatch({ type: 'state', event, at: Date.now() })
      }) ?? null
    // WHILE OPEN ONLY: an outside press closes, a resize re-places.
    document.addEventListener('pointerdown', this.#onOutsidePress, true)
    window.addEventListener('resize', this.#onResize)
    this.#unsubscribe = () => {
      off?.()
      document.removeEventListener('pointerdown', this.#onOutsidePress, true)
      window.removeEventListener('resize', this.#onResize)
    }
  }

  #unsubscribeState(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  readonly #onOutsidePress = (event: PointerEvent): void => {
    if (!this.#state.open) return
    const target = event.target
    if (target instanceof Node && (this.element.contains(target) || this.field.contains(target))) return
    // THE MAP STAYS PRESSABLE: a press on it tags, it does not dismiss.
    if (this.#host.isMapTarget(target)) return
    this.close()
  }

  readonly #onResize = (): void => {
    this.#place()
  }

  #focusField(): void {
    this.#textarea.focus({ preventScroll: true })
    const end = this.#textarea.value.length
    this.#textarea.setSelectionRange(end, end)
  }

  #closeFromKeyboard(): void {
    this.close()
    this.#textarea.blur()
    this.#host.onClosed()
  }

  /** The field's ×: the question goes, the tags stay. */
  #clear(): void {
    this.#closePicker()
    this.#dispatch({ type: 'new-question' })
    this.#textarea.value = ''
    if (this.#state.open) this.#focusField()
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
    this.#closePicker()
    void this.#start(rootId, turn, followUpOf)
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
   * Re-read "asked before" when the tags change, in the question box only. On
   * the Workspace, nothing tagged reads the whole Workspace; in a project it
   * reads nothing until a feature is tagged.
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

  /** One read of saved answers in the panel's scope, with the stale marks when not read yet. */
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
    // A saved entry asked for by id is looked for in the whole scope.
    const ids = workspace ? (openId !== undefined ? [] : tagged) : tagged.length > 0 ? tagged : this.#host.historyScope()
    const seq = ++this.#historySeq
    if (!workspace && ids.length === 0) {
      this.#dispatch({ type: 'history', threads: [], stale: [] })
      return
    }
    const read = await this.#readSaved(ids, true)
    if (read === null || seq !== this.#historySeq || !this.#state.open) return
    const { list, stale } = read
    if (list === null || !list.ok) {
      this.#dispatch({ type: 'history-failed', sentence: list?.detail ?? "Saved questions couldn't be read." })
      return
    }
    this.#dispatch({ type: 'history', threads: list.threads, stale: stale !== null && stale.ok ? stale.results : [] })
    const wanted = openId === undefined ? undefined : list.threads.find((thread) => thread.id === openId)
    if (wanted !== undefined) this.#dispatch({ type: 'open-saved', thread: wanted })
  }

  /** A saved row pressed: a pointer to a Workspace answer opens it in the Workspace. */
  #openSavedRow(thread: AskSavedThread): void {
    const pointer = thread.workspaceAnswer
    if (pointer !== undefined && this.#state.scope.kind !== 'workspace') {
      const workspace = this.#host.workspaceScope()
      if (workspace !== null) {
        this.open({ entryId: pointer.entryId, scope: workspace })
        return
      }
    }
    this.#dispatch({ type: 'open-saved', thread })
  }

  /* ── Typing, pasting and the @ picker ───────────────────────────────── */

  #onInput(event: InputEvent): void {
    const text = this.#textarea.value
    this.#dispatch({ type: 'draft', text })
    if (event.inputType === 'insertFromPaste') this.#suggestFrom(text)
    this.#updatePicker()
    this.#fitField()
  }

  #suggestFrom(text: string): void {
    const exclude = new Set(this.#state.tags.map((tag) => tag.id))
    const suggestions = suggestTags(text, this.#host.graphNodes(this.#state.scope), { exclude })
    this.#dispatch({ type: 'suggest', suggestions })
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
    // Typing in the panel never reaches the board's own shortcuts; the app's
    // modifier shortcuts (the palette and the like) still do.
    if (!event.metaKey && !event.ctrlKey) event.stopPropagation()
  }

  /* ── Placing the panel under the field ──────────────────────────────── */

  #place(): void {
    if (!this.#state.open || this.element.hidden) return
    const parent = (this.element.offsetParent as HTMLElement | null) ?? this.element.parentElement
    const style = this.element.style
    if (parent === null || !this.field.isConnected) {
      // No field on this sheet: the panel keeps its resting corner.
      style.left = ''
      style.top = ''
      style.width = ''
      style.maxHeight = ''
      this.element.classList.add('fb-ask-floating')
      return
    }
    const fieldRect = this.field.getBoundingClientRect()
    const box = parent.getBoundingClientRect()
    if (fieldRect.width === 0 || box.width === 0) return
    this.element.classList.remove('fb-ask-floating')
    const gutter = 8
    const width = Math.min(Math.max(fieldRect.width, PANEL_MIN_WIDTH), box.width - gutter * 2)
    // Right edges line up, so a field near the edge never pushes the panel off it.
    let left = fieldRect.right - box.left - width
    left = Math.max(gutter, Math.min(left, box.width - width - gutter))
    const top = fieldRect.bottom - box.top + 6
    style.left = `${String(Math.round(left))}px`
    style.top = `${String(Math.round(top))}px`
    style.right = 'auto'
    style.width = `${String(Math.round(width))}px`
    style.maxHeight = `${String(Math.max(160, Math.round(box.height - top - 12)))}px`
  }

  /** The field is one line in every state; keep the newest chip and the caret in view. */
  #fitField(): void {
    this.#fieldChips.scrollLeft = this.#fieldChips.scrollWidth
  }

  /* ── Rendering ──────────────────────────────────────────────────────── */

  #render(): void {
    const state = this.#state
    this.#renderField()
    this.element.hidden = !state.open
    if (!state.open) return
    this.element.setAttribute('aria-label', askTitle(state.scope))
    const picking = this.#pickerOpen() && state.view === 'compose'
    this.#pick.hidden = !picking
    this.#compose.hidden = picking || state.view !== 'compose'
    this.#answer.hidden = state.view !== 'answer'
    this.#history.hidden = state.view !== 'history'
    this.#hints.hidden = picking || state.view !== 'compose'
    this.#pickHints.hidden = !picking
    this.#footer.hidden = state.view !== 'answer'
    if (picking) this.#renderPicker()
    else if (state.view === 'compose') this.#renderCompose()
    if (state.view === 'answer') this.#renderAnswer()
    if (state.view === 'history') this.#renderHistory()
    this.#schedulePlace()
  }

  #schedulePlace(): void {
    this.#place()
    // Once more after layout settles: the field widens with the open class.
    if (this.#placeFrame !== null) return
    this.#placeFrame = window.requestAnimationFrame(() => {
      this.#placeFrame = null
      this.#place()
    })
  }

  #renderField(): void {
    const state = this.#state
    const composing = state.open && state.view === 'compose'
    this.field.classList.toggle('is-open', state.open)
    this.field.classList.toggle('is-answer', state.open && state.view !== 'compose')
    if (this.#textarea.value !== state.draft) this.#textarea.value = state.draft
    // CHIPS IN THE FIELD while composing; a count once the question is asked.
    this.#fieldChips.replaceChildren()
    if (composing) for (const tag of state.tags) this.#fieldChips.appendChild(this.#chip(tag, true))
    this.#fieldChips.hidden = !composing || state.tags.length === 0
    const count = state.tags.length
    this.#fieldCount.textContent = `${String(count)} tag${count === 1 ? '' : 's'} ·`
    this.#fieldCount.hidden = composing || count === 0
    this.#clearBtn.hidden = state.draft === '' && state.turns.length === 0
    this.#fieldKey.textContent = state.open ? 'esc' : '/'
    this.#fieldKey.title = state.open ? 'Close' : 'Press / to ask'
    this.#textarea.placeholder = composing && count > 0 ? 'Ask about these…' : ASK_FIELD_PLACEHOLDER
    this.#fitField()
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

  /** What a tag looks like anywhere: swatch or prefix, then its label. */
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
      target.append(this.#projectPrefix(tag.project), document.createTextNode(` ${tag.label}`))
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

  #renderPicker(): void {
    const query = this.#pickerQuery ?? ''
    const workspace = this.#state.scope.kind === 'workspace'
    this.#pickHead.textContent =
      query !== ''
        ? `Tag “${query}”`
        : workspace
          ? 'Tag a project, feature, part, connection or conversation'
          : 'Tag a feature, part or conversation'
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

    // WHAT IS ASKED ABOUT — the whole scope, or the tags.
    const line = askScopeLine(state)
    this.#scopeLine.replaceChildren()
    this.#scopeLine.appendChild(el('div', 'fb-ask-caps', 'Asking about'))
    const row = el('div', 'fb-ask-scope-row')
    for (const item of line.items) {
      const pill = el('span', 'fb-ask-scope-pill')
      this.#tagContent(pill, item)
      row.appendChild(pill)
    }
    row.appendChild(el('span', 'fb-ask-muted', line.hint))
    this.#scopeLine.appendChild(row)

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

    this.#askedBefore.replaceChildren()
    this.#askedBefore.hidden = state.askedBefore.length === 0
    if (state.askedBefore.length > 0) {
      this.#askedBefore.appendChild(el('div', 'fb-ask-caps', 'Asked before'))
      for (const thread of state.askedBefore.slice(0, 5)) this.#askedBefore.appendChild(this.#savedRow(thread))
    }
  }

  #savedRow(thread: AskSavedThread): HTMLElement {
    const row = button('fb-ask-saved-row', '', () => this.#openSavedRow(thread))
    row.appendChild(el('span', 'fb-ask-saved-q', thread.question))
    const stale = this.#state.staleIds.includes(thread.id)
    const meta = stale
      ? el('span', 'fb-ask-saved-meta fb-ask-warn-text', 'code changed since')
      : el(
          'span',
          'fb-ask-saved-meta',
          [thread.workspaceAnswer !== undefined ? 'Workspace' : '', thread.author, ageLabel(thread.ts, Date.now())]
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
    const back = button('fb-ask-icon-btn', '', () => this.#dispatch({ type: 'new-question' }), 'Back to the question')
    back.title = 'Back to the question'
    back.appendChild(icon(ICON_BACK))
    head.append(back, el('span', 'fb-ask-caps', 'Saved questions'))
    this.#history.appendChild(head)
    if (state.historyError !== null) {
      this.#history.appendChild(el('p', 'fb-ask-error', state.historyError))
      return
    }
    if (state.history === null) {
      this.#history.appendChild(el('p', 'fb-ask-muted', 'Reading saved questions…'))
      return
    }
    if (state.history.length === 0) {
      const empty =
        state.scope.kind === 'workspace' && state.tags.length === 0
          ? 'Nobody has asked this Workspace a question yet.'
          : 'Nobody has asked about these yet.'
      this.#history.appendChild(el('p', 'fb-ask-muted', empty))
      return
    }
    for (const thread of state.history) this.#history.appendChild(this.#savedRow(thread))
  }

  #renderAnswer(): void {
    const state = this.#state
    this.#answer.replaceChildren()
    state.turns.forEach((turn, index) => {
      this.#answer.appendChild(this.#turnView(turn, index, index === state.turns.length - 1))
    })
    const last = currentTurn(state)
    this.#followInput.disabled = !canFollowUp(state)
    this.#followInput.placeholder =
      last !== null && isRunning(last) ? 'You can follow up when this answer is ready' : 'Ask more about this answer…'
    this.#continueBtn.disabled = last === null || last.answer === null
  }

  #turnView(turn: AskTurn, index: number, newest: boolean): HTMLElement {
    const wrap = el('div', 'fb-ask-turn')

    // A FOLLOW-UP shows its question; the first one is in the field above.
    if (index > 0) {
      const bubble = el('div', 'fb-ask-bubble')
      bubble.appendChild(el('div', 'fb-ask-bubble-text', turn.question))
      wrap.appendChild(bubble)
    }

    const status = askStatusLine(turn, Date.now())
    if (status !== null) {
      const line = el('div', `fb-ask-status fb-ask-status-${status.tone}`)
      if (status.tone === 'busy') {
        const spin = icon(ICON_SPIN, 11)
        spin.classList.add('fb-ask-spin')
        line.appendChild(spin)
      } else {
        line.appendChild(el('span', 'fb-ask-status-dot'))
      }
      line.appendChild(el('span', 'fb-ask-status-text', status.text))
      if (newest && isRunning(turn) && turn.askId !== null) {
        line.appendChild(el('span', 'fb-ask-spacer'))
        const stop = button('fb-ask-secondary fb-ask-small', turn.stopping ? 'Stopping…' : 'Stop here', () => this.#stop(turn))
        stop.disabled = turn.stopping
        line.appendChild(stop)
      }
      wrap.appendChild(line)
    }
    if (newest && turn.phase === 'digging' && turn.steps.length > 0) wrap.appendChild(this.#steps(turn))

    const answer = turn.answer
    if (answer !== null) {
      if (turn.saved !== null && turn.saved.stale) {
        const stale = el('div', 'fb-ask-stale')
        stale.appendChild(el('span', '', 'The code under this answer changed since.'))
        stale.appendChild(button('fb-ask-secondary fb-ask-small', 'Ask again', () => this.#askAgain(turn)))
        wrap.appendChild(stale)
      }
      wrap.appendChild(this.#explanation(answer.explanation, answer.thin && answer.confidence === 'first' && isRunning(turn)))
      if (answer.couldNotFind !== undefined && !isRunning(turn)) wrap.appendChild(el('p', 'fb-ask-muted', answer.couldNotFind))
      if (answer.verdict !== undefined || answer.branchInProgress !== undefined) wrap.appendChild(this.#verdictCard(answer.verdict, answer.branchInProgress))
      if (answer.reply !== undefined && answer.reply.trim() !== '') wrap.appendChild(this.#replyCard(answer.reply))
      if (answer.sources.length > 0) wrap.appendChild(this.#sourcesList(answer.sources))
      if (!isRunning(turn)) {
        const knowledge = knowledgeOnlySentence(answer.knowledgeOnly ?? [], (slug) => this.#projectName(slug))
        if (knowledge !== null) wrap.appendChild(el('div', 'fb-ask-knowledge', knowledge))
        const suggested = answer.suggestedConnections ?? []
        if (suggested.length > 0 && this.#state.scope.kind === 'workspace') wrap.appendChild(this.#connectionsCard(suggested))
        const foot = this.#answerFoot(turn)
        if (foot !== null) wrap.appendChild(foot)
      }
    }

    if (turn.phase === 'error' && turn.error !== null) wrap.appendChild(el('p', 'fb-ask-error', turn.error))
    return wrap
  }

  #steps(turn: AskTurn): HTMLElement {
    const steps = el('div', 'fb-ask-steps')
    for (const step of turn.steps) {
      const line = el('div', `fb-ask-step fb-ask-step-${step.state}`)
      if (step.state === 'done') line.appendChild(icon(ICON_CHECK, 11))
      line.appendChild(document.createTextNode(step.label))
      steps.appendChild(line)
    }
    steps.appendChild(
      el('div', 'fb-ask-dig-note', turn.answer !== null ? 'The answer below updates when this finishes.' : 'The answer appears here when this finishes.'),
    )
    return steps
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
    const workspace = this.#state.scope.kind === 'workspace'
    sources.forEach((source, index) => {
      const n = source.n ?? null
      const row = el('button', 'fb-ask-source')
      row.type = 'button'
      if (n !== null) row.dataset['sourceN'] = String(n)
      row.appendChild(el('span', 'fb-ask-source-n', n === null ? '·' : String(n)))
      if (workspace && source.project !== undefined) row.appendChild(this.#projectPrefix(source.project))
      row.appendChild(el('span', 'fb-ask-source-label', source.label))
      if (source.file !== undefined && this.#host.canPeek(source.project)) {
        row.appendChild(el('span', 'fb-ask-source-file', baseName(source.file)))
        row.title = `Open ${baseName(source.file)}`
        const file = source.file
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#host.peekFile(file)
        })
      } else if (source.file !== undefined) {
        row.appendChild(el('span', 'fb-ask-source-file', baseName(source.file)))
        row.tabIndex = n === null ? -1 : 0
      } else {
        row.appendChild(el('span', 'fb-ask-source-know', 'from knowledge'))
        row.tabIndex = n === null ? -1 : 0
      }
      row.dataset['index'] = String(index)
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
    if (answer.factsLearned > 0) {
      const line = el('div')
      line.append(
        el('span', 'fb-ask-good-text', `${String(answer.factsLearned)} fact${answer.factsLearned === 1 ? '' : 's'} learned`),
        document.createTextNode(', now part of what Flow knows.'),
      )
      lines.push(line)
    }
    if (!answer.factsSaved) lines.push(el('div', 'fb-ask-warn-text', "The facts this answer found couldn't be saved. The answer stands."))
    const saved = savedSentence(turn, this.#state.scope, (slug) => this.#projectName(slug))
    if (saved !== null) lines.push(el('div', 'fb-ask-saved-line', saved))
    else if (turn.saved !== null && turn.saved.usedConversation) {
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
  /* THE HEADER FIELD — search-style, about 320px at rest, wider while open
     (mockup G + D, board 5). It sits in the header strip, before the tiles. */
  .flow-board-root .fb-askf {
    flex: 0 1 320px;
    width: 320px;
    max-width: 34vw;
    min-width: 180px;
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
  .flow-board-root .fb-askf.is-open {
    flex-basis: 520px;
    width: 520px;
    max-width: 48vw;
    border-color: var(--fb-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--fb-accent) 18%, transparent);
  }
  .flow-board-root .fb-askf [hidden] { display: none !important; }
  .flow-board-root .fb-askf-spark { flex: none; color: var(--fb-accent); }
  /* ONE LINE, like the search field it is: chips scroll sideways before the text. */
  .flow-board-root .fb-askf-chips {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 60%;
    display: flex;
    flex-wrap: nowrap;
    gap: var(--fl-space-xs, 4px);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .flow-board-root .fb-askf-chips::-webkit-scrollbar { display: none; }
  .flow-board-root .fb-askf .fb-ask-chip { flex: none; white-space: nowrap; }
  .flow-board-root .fb-askf .fb-ask-chip { height: 22px; padding: 0 6px; font-size: 12px; }
  .flow-board-root .fb-askf-count { flex: none; color: var(--fl-color-text-muted, var(--fb-ink-dim)); font-size: 12px; white-space: nowrap; }
  .flow-board-root .fb-askf-input {
    flex: 1 1 auto;
    min-width: 60px;
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
  }
  .flow-board-root .fb-askf-input::placeholder { color: var(--fl-color-text-muted, var(--fb-ink-dim)); }
  .flow-board-root .fb-askf-clear {
    flex: none;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-sm, 4px);
    color: var(--fl-color-text-muted, var(--fb-ink-dim));
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .flow-board-root .fb-askf-clear:hover { color: var(--fl-color-text, var(--fb-ink)); background: var(--fb-paper); }
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
  .flow-board-root .fb-askf.is-open .fb-askf-key { cursor: pointer; }

  /* A project's colour on a chip, a picker row or a source. */
  .flow-board-root .fb-ask-proj { color: var(--fb-ask-proj, var(--fb-ink-dim)); white-space: nowrap; }
  .flow-board-root .fb-ask-swatch {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--fb-ask-proj, var(--fb-ink-dim));
  }

  /* THE PANEL — attached under the field, at its width; placed in script. */
  .flow-board-root { position: relative; }
  .flow-board-root .fb-ask {
    --fb-ask-good: var(--fb-learn-known);
    --fb-ask-warn: var(--fb-warn);
    position: absolute;
    top: 46px;
    right: var(--fl-space-lg, 16px);
    width: 520px;
    max-width: calc(100% - 16px);
    max-height: calc(100% - 60px);
    z-index: 13;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--fb-card);
    color: var(--fb-ink);
    border: 1px solid var(--fb-card-border);
    border-radius: 10px;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
    font-family: var(--fl-font-ui, system-ui, sans-serif);
    font-size: 13px;
    overflow: hidden;
  }
  .flow-board-root .fb-ask[hidden] { display: none; }
  .flow-board-root .fb-ask [hidden] { display: none !important; }
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
    padding: 14px;
  }
  .flow-board-root .fb-ask-hints {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 14px;
    border-top: 1px solid var(--fb-border);
    color: var(--fb-ink-dim);
    font-size: 11px;
  }
  .flow-board-root .fb-ask-kbd { font-family: var(--fl-font-mono, ui-monospace, monospace); color: var(--fb-ink); }
  .flow-board-root .fb-ask-scope { display: flex; flex-direction: column; gap: var(--fl-space-sm, 8px); }
  .flow-board-root .fb-ask-scope-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .flow-board-root .fb-ask-scope-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border: 1px solid var(--fb-card-border);
    border-radius: 999px;
    font-size: 12px;
  }
  .flow-board-root .fb-ask-pick { display: flex; flex-direction: column; gap: 2px; margin: -8px -8px 0; }
  .flow-board-root .fb-ask-pick-head { padding: 0 8px 4px; }
  .flow-board-root .fb-ask-pick-list { display: flex; flex-direction: column; gap: 2px; }
  .flow-board-root .fb-ask-history-head { display: flex; align-items: center; gap: var(--fl-space-xs, 4px); margin: -6px 0 0 -6px; }
  .flow-board-root .fb-ask-status {
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    min-height: 24px;
    color: var(--fb-ink-dim);
    font-family: var(--fl-font-mono, ui-monospace, monospace);
    font-size: 11px;
  }
  .flow-board-root .fb-ask-status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .flow-board-root .fb-ask-status-good .fb-ask-status-dot { background: var(--fb-ask-good); }
  .flow-board-root .fb-ask-status-warn .fb-ask-status-dot { background: var(--fb-ask-warn); }
  .flow-board-root .fb-ask-status-busy { color: var(--fb-accent); }
  .flow-board-root .fb-ask-status-text { color: var(--fb-ink-dim); }
  .flow-board-root .fb-ask-knowledge {
    padding: var(--fl-space-sm, 8px) 10px;
    border-radius: var(--fl-radius-row, 6px);
    background: color-mix(in srgb, var(--fb-ask-warn) 12%, transparent);
    color: var(--fb-ask-warn);
    font-size: 12px;
    line-height: 1.5;
  }
  .flow-board-root .fb-ask-connections {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--fb-border);
  }
  .flow-board-root .fb-ask-connection { display: flex; align-items: center; gap: var(--fl-space-sm, 8px); font-size: 12px; }
  .flow-board-root .fb-ask-connection-words { min-width: 0; line-height: 1.5; }
  .flow-board-root .fb-ask-connection-words .fb-ask-proj { white-space: normal; }
  .flow-board-root .fb-ask-follow-row { display: flex; gap: var(--fl-space-sm, 8px); }
  .flow-board-root .fb-ask-compose,
  .flow-board-root .fb-ask-answer,
  .flow-board-root .fb-ask-history,
  .flow-board-root .fb-ask-turn {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-md, 12px);
  }
  .flow-board-root .fb-ask-answer { gap: var(--fl-space-lg, 16px); }
  .flow-board-root .fb-ask-muted { margin: 0; color: var(--fb-ink-dim); font-size: 12px; line-height: 1.5; }
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
  .flow-board-root .fb-ask-picker-row {
    display: flex;
    align-items: center;
    gap: var(--fl-space-sm, 8px);
    width: 100%;
    flex: none;
    padding: var(--fl-space-sm, 8px);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-row, 6px);
    color: var(--fb-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .flow-board-root .fb-ask-picker-row:hover { background: var(--fb-paper); }
  .flow-board-root .fb-ask-picker-row.on { background: color-mix(in srgb, var(--fb-accent) 22%, var(--fb-card)); }
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
    flex-direction: column;
    gap: 6px;
    padding: 10px 14px var(--fl-space-md, 12px);
    border-top: 1px solid var(--fb-border);
  }
  .flow-board-root .fb-ask-follow {
    flex: 1;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    padding: 0 10px;
    background: var(--fb-paper);
    border: 1px solid var(--fb-border);
    border-radius: var(--fl-radius-md, 8px);
    color: var(--fb-ink);
    font: inherit;
    outline: none;
  }
  .flow-board-root .fb-ask-follow:focus { border-color: var(--fb-accent); }
  .flow-board-root .fb-ask-follow:disabled { opacity: 0.6; }
  .flow-board-root .fb-ask-foot .fb-ask-secondary { height: 32px; }

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

  /* A LIGHT DIM over the map while Ask is open: still visible, still pressable. */
  .flow-board-root.fb-ask-active .fb-stage::after {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.12);
    pointer-events: none;
    z-index: 3;
  }

  /* ── The Workspace sheet while the panel is open (note 8) ── */
  .flow-board-root .fb-ws-ask-open .fb-ws-cell,
  .flow-board-root .fb-ws-ask-open .fb-ws-country.fb-ws-zoomable { cursor: copy; }
  .flow-board-root .fb-ws-ask-open .fb-ws-cell.fb-ws-ask-dim { opacity: 0.35; }
  .flow-board-root .fb-ws-ask-open .fb-ws-country.fb-ws-ask-dim { opacity: 0.45; }
  .flow-board-root .fb-ws-country.fb-ws-ask-tagged {
    border-color: var(--fb-ws-hue, var(--fb-learn-known));
    box-shadow: inset 0 0 0 2px var(--fb-ws-hue, var(--fb-learn-known));
  }
  .flow-board-root .fb-ws-country.fb-ws-ask-mentioned {
    outline: 2px dashed var(--fb-accent);
    outline-offset: -2px;
  }
  .flow-board-root .fb-ws-ask-note { color: var(--fb-warn); font-size: 12px; white-space: nowrap; }
  .flow-board-root .fb-ws-ask-open svg.fb-ws-links .fb-ws-ribbon { pointer-events: stroke; cursor: copy; }
  .flow-board-root .fb-ws-ask-open svg.fb-ws-links .fb-ws-bridge,
  .flow-board-root .fb-ws-ask-open svg.fb-ws-links .fb-ws-pill { pointer-events: all; cursor: copy; }
`
