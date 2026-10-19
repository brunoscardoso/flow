/**
 * PLAN CHANGE REVIEW — the DOM of a note: its block under its box (the note's
 * words, Accept / Reject / Comment, the comment's "In context" line, the
 * verdict in Verify), the note strip, and the review bar with Send review.
 *
 * Decides nothing: the words and counts come from `note-review-model.ts` and
 * `storyline-view-model.ts`, the state from the open review
 * (`plan-review-session.ts`). Every element is made once per build; what a
 * decision changes is repainted in place, so an open comment box or a reason
 * being typed survives a note being saved elsewhere.
 */
import type { PlanNoteVerdict, StorylineNote, StorylineNoteFact } from '../../shared/ipc-contract'
import {
  canRecordVerdict,
  decisionLabel,
  decisionOf,
  notesToAcceptAll,
  reviewChips,
  reviewCounts,
  reviewHeadline,
  reviewTally,
  sendBlockedReason,
  stripSentence,
} from './note-review-model'
import type { NoteSaveState, PlanReviewState } from './plan-review-session'
import { noteRows, VERDICT_CHOICES, verdictView, type ReviewMode } from './storyline-view-model'

/** What a note block can ask of the open review. */
export interface NoteBlockActions {
  decide(n: number, pressed: 'accepted' | 'rejected', reason?: string): void
  comment(n: number, text: string): void
  setVerdict(n: number, verdict: PlanNoteVerdict, why: string): void
}

/** A built note block, and how to repaint it from the review's state. */
export interface NoteBlock {
  element: HTMLElement
  paint(state: PlanReviewState): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, press: () => void, title?: string): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  if (title !== undefined) node.title = title
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    press()
  })
  return node
}

/** The label right of a note's actions: its decision, or that a write is in flight or failed. */
function statusText(decision: ReturnType<typeof decisionOf>, save: NoteSaveState | undefined): { text: string; tone: string; title: string } {
  if (save?.state === 'saving') return { text: 'Saving…', tone: 'saving', title: 'Writing this to the plan' }
  if (save?.state === 'failed') return { text: 'Not saved', tone: 'failed', title: save.detail }
  return { text: decisionLabel(decision), tone: decision, title: '' }
}

/**
 * The block under a noted box. Proposal: the note's rows, earlier comments,
 * Accept / Reject (a reason asked inline) / Comment, the comment box and its
 * "In context" line. Verify: the rows, the verdict and a way to change it.
 */
export function buildNoteBlock(note: StorylineNote, mode: ReviewMode, fact: StorylineNoteFact | undefined, actions: NoteBlockActions): NoteBlock {
  const n = note.n
  const block = el('div', 'fb-note')
  block.dataset['note'] = String(n)
  const head = el('div', 'fb-note-head', `Note ${String(n)}`)
  block.appendChild(head)
  for (const row of noteRows(note)) {
    const line = el('div', 'fb-note-row')
    const label = el('b', 'fb-note-label', row.label)
    const text = el('span', 'fb-note-text')
    if (row.code) text.appendChild(el('code', 'fb-note-code', row.text))
    else text.textContent = row.text
    line.append(label, text)
    block.appendChild(line)
  }
  for (const earlier of note.comments) {
    if (earlier.trim() === '') continue
    const line = el('div', 'fb-note-earlier')
    line.append(el('b', '', 'Earlier comment:'), ` ${earlier}`)
    block.appendChild(line)
  }

  if (mode === 'verify') return buildVerdict(block, note, fact, actions)
  if (mode === 'today') return { element: block, paint: () => undefined }

  const acts = el('div', 'fb-note-acts')
  acts.setAttribute('role', 'group')
  acts.setAttribute('aria-label', `Your decision on note ${String(n)}`)
  const accept = button('fb-note-act fb-note-accept', 'Accept', () => actions.decide(n, 'accepted'))
  const reject = button('fb-note-act fb-note-reject', 'Reject', () => {
    if (decisionNow === 'rejected') {
      actions.decide(n, 'rejected')
      return
    }
    reasonRow.hidden = !reasonRow.hidden
    if (!reasonRow.hidden) reasonInput.focus()
  })
  const commentToggle = button('fb-note-act fb-note-comment-btn', 'Comment', () => {
    commentBox.hidden = !commentBox.hidden
    commentToggle.setAttribute('aria-expanded', String(!commentBox.hidden))
    if (!commentBox.hidden) textarea.focus()
  })
  commentToggle.setAttribute('aria-expanded', 'false')
  const status = el('span', 'fb-note-status')
  status.setAttribute('role', 'status')
  acts.append(accept, reject, commentToggle, status)

  // REJECT ASKS WHY — optional, inline, never a dialog.
  const reasonRow = el('div', 'fb-note-reason')
  reasonRow.hidden = true
  const reasonInput = el('input', 'fb-note-input')
  reasonInput.type = 'text'
  reasonInput.placeholder = 'Why reject it? (optional)'
  reasonInput.setAttribute('aria-label', `Why reject note ${String(n)} (optional)`)
  const confirmReject = (): void => {
    reasonRow.hidden = true
    actions.decide(n, 'rejected', reasonInput.value)
    reasonInput.value = ''
  }
  reasonInput.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') confirmReject()
    if (event.key === 'Escape') reasonRow.hidden = true
  })
  reasonRow.append(
    reasonInput,
    button('fb-note-act fb-note-reject', 'Reject', confirmReject),
    button('fb-note-act', 'Cancel', () => {
      reasonRow.hidden = true
    }),
  )

  const commentBox = el('div', 'fb-note-commentbox')
  commentBox.hidden = true
  const textarea = el('textarea', 'fb-note-textarea')
  textarea.placeholder = 'What should change in this note…'
  textarea.setAttribute('aria-label', `Comment on note ${String(n)}`)
  textarea.addEventListener('keydown', (event) => event.stopPropagation())
  const addToContext = button('fb-note-act fb-note-add', 'Add to context', () => {
    const text = textarea.value.trim()
    if (text === '') return
    actions.comment(n, text)
    textarea.value = ''
    commentBox.hidden = true
    commentToggle.setAttribute('aria-expanded', 'false')
  }, 'Kept with this review, and sent with it — nothing is sent now')
  commentBox.append(textarea, addToContext)

  const context = el('div', 'fb-note-context')
  block.append(acts, reasonRow, commentBox, context)

  let decisionNow = decisionOf(note.status)
  const paint = (state: PlanReviewState): void => {
    const current = state.notes.find((entry) => entry.n === n) ?? note
    decisionNow = decisionOf(current.status)
    accept.setAttribute('aria-pressed', String(decisionNow === 'accepted'))
    reject.setAttribute('aria-pressed', String(decisionNow === 'rejected'))
    accept.title = decisionNow === 'accepted' ? 'Take the acceptance back' : 'Build this note as written'
    reject.title = decisionNow === 'rejected' ? 'Take the rejection back' : 'Never build this note'
    const saving = state.saves[n]?.state === 'saving'
    accept.disabled = saving
    reject.disabled = saving
    const shown = statusText(decisionNow, state.saves[n])
    status.textContent = shown.text
    status.className = `fb-note-status fb-note-status-${shown.tone}`
    status.title = shown.title
    if (decisionNow === 'rejected' && current.reason !== undefined && current.reason.trim() !== '' && state.saves[n] === undefined) {
      status.title = `Reason: ${current.reason}`
    }
    const comment = state.drafts[n]
    context.replaceChildren()
    context.hidden = comment === undefined
    if (comment !== undefined) {
      context.append(el('b', '', 'In context:'), ` ${comment}`)
      context.appendChild(button('fb-note-uncontext', 'Remove', () => actions.comment(n, ''), 'Take this comment out of the review'))
    }
  }
  return { element: block, paint }
}

/** Verify's half of a note block: the verdict, and a way to change it with one sentence why. */
function buildVerdict(block: HTMLElement, note: StorylineNote, fact: StorylineNoteFact | undefined, actions: NoteBlockActions): NoteBlock {
  const n = note.n
  const line = el('div', 'fb-note-verdict')
  const text = el('span', 'fb-note-verdict-text')
  const status = el('span', 'fb-note-status')
  status.setAttribute('role', 'status')
  const change = button('fb-note-act', 'Change verdict', () => {
    editor.hidden = !editor.hidden
    if (!editor.hidden) why.focus()
  })
  line.append(text, change, status)

  const editor = el('div', 'fb-note-verdict-edit')
  editor.hidden = true
  let chosen: PlanNoteVerdict | null = null
  const choices = VERDICT_CHOICES.map((choice) => {
    const option = button('fb-note-act fb-note-choice', choice.label, () => {
      chosen = choice.verdict
      for (const other of choices) other.setAttribute('aria-pressed', String(other === option))
      sync()
    })
    option.setAttribute('aria-pressed', 'false')
    return option
  })
  const why = el('input', 'fb-note-input')
  why.type = 'text'
  why.placeholder = 'Why, in one sentence'
  why.setAttribute('aria-label', `Why this verdict for note ${String(n)}`)
  const save = button('fb-note-act fb-note-accept', 'Save verdict', () => {
    if (chosen === null || why.value.trim() === '') return
    actions.setVerdict(n, chosen, why.value)
    editor.hidden = true
    why.value = ''
  })
  const sync = (): void => {
    save.disabled = chosen === null || why.value.trim() === ''
  }
  why.addEventListener('input', sync)
  why.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Enter') save.click()
  })
  sync()
  editor.append(...choices, why, save, button('fb-note-act', 'Cancel', () => {
    editor.hidden = true
  }))
  block.append(line, editor)

  const paint = (state: PlanReviewState): void => {
    const current = state.notes.find((entry) => entry.n === n) ?? note
    const view = verdictView(current, fact)
    text.textContent = view.text
    line.className = `fb-note-verdict fb-note-verdict-${view.tone}`
    const shown = statusText(decisionOf(current.status), state.saves[n])
    status.textContent = state.saves[n] === undefined ? '' : shown.text
    status.className = `fb-note-status fb-note-status-${shown.tone}`
    status.title = shown.title
    // A REJECTED NOTE HAS NO VERDICT: execution leaves it out, so there is nothing to change.
    const recordable = canRecordVerdict(current)
    change.hidden = !recordable
    if (!recordable) editor.hidden = true
  }
  return { element: block, paint }
}

/** The dot class of a note in the strip. */
function dotTone(state: PlanReviewState, n: number, status: StorylineNote['status']): string {
  const save = state.saves[n]
  if (save?.state === 'failed') return 'failed'
  const decision = decisionOf(status)
  if (decision === 'accepted') return 'ok'
  if (decision === 'rejected') return 'no'
  return 'wait'
}

/** The note strip: every note with its state; pressing one brings it into view. */
export function paintNoteStrip(host: HTMLElement, state: PlanReviewState, shown: ReadonlySet<number>, onPress: (n: number) => void): void {
  host.replaceChildren()
  const strip = el('div', 'fb-nr-strip')
  strip.appendChild(el('span', 'fb-story-rail-label', 'Notes'))
  for (const note of [...state.notes].sort((a, b) => a.n - b.n)) {
    const pill = button(
      'fb-nr-pill',
      '',
      () => onPress(note.n),
      shown.has(note.n) ? `Show note ${String(note.n)}` : `Note ${String(note.n)} is not drawn in this view`,
    )
    pill.disabled = !shown.has(note.n)
    pill.dataset['note'] = String(note.n)
    const dot = el('i', `fb-nr-dot fb-nr-dot-${dotTone(state, note.n, note.status)}`)
    dot.setAttribute('aria-hidden', 'true')
    pill.append(dot, `${String(note.n)} · ${decisionLabel(decisionOf(note.status))}`)
    strip.appendChild(pill)
  }
  strip.appendChild(el('span', 'fb-story-spacer'))
  strip.appendChild(el('span', 'fb-nr-strip-sum', stripSentence(reviewCounts(state.notes, state.drafts))))
  host.appendChild(strip)
}

/**
 * The review bar (Proposal): the tally, a chip per decided or commented note,
 * and Send review — disabled until every note is reviewed, absent when the
 * review has no conversation to go to.
 */
export function paintReviewBar(
  host: HTMLElement,
  state: PlanReviewState,
  mode: ReviewMode,
  onSend: () => void,
  onAcceptAll: () => void = () => undefined,
): void {
  host.replaceChildren()
  if (state.error !== null) {
    host.appendChild(el('span', 'fb-nr-error', state.error))
    return
  }
  if (mode !== 'proposal' || state.notes.length === 0) return
  const bar = el('div', 'fb-nr-bar')
  if (state.sent) {
    bar.appendChild(el('span', 'fb-nr-sum', 'Review sent. The agent is revising the plan.'))
    host.appendChild(bar)
    return
  }
  const counts = reviewCounts(state.notes, state.drafts)
  const sum = el('span', 'fb-nr-sum', reviewHeadline(counts))
  sum.appendChild(el('span', 'fb-nr-tally', ` · ${reviewTally(counts)}`))
  bar.appendChild(sum)
  // ACCEPT ALL — beside Send, secondary: only while a note is left to review.
  const saving = new Set(
    Object.entries(state.saves)
      .filter(([, save]) => save.state === 'saving')
      .map(([n]) => Number(n)),
  )
  const left = notesToAcceptAll(state.notes, saving)
  if (left.length > 0) {
    const all = button(
      'fb-nr-accept-all',
      'Accept all',
      onAcceptAll,
      left.length === 1 ? 'Accept the one note not reviewed yet' : `Accept the ${String(left.length)} notes not reviewed yet — rejected ones stay rejected`,
    )
    // ONE Accept all at a time: pressed again while it writes, it does nothing.
    all.disabled = state.acceptingAll
    if (state.acceptingAll) all.title = 'Accepting the notes not reviewed yet…'
    if (state.request.threadId === null) all.classList.add('fb-nr-accept-all-end')
    bar.appendChild(all)
  }
  if (state.request.threadId !== null) {
    const blocked = sendBlockedReason(state.notes, state.saves)
    const send = button('fb-nr-send', 'Send review to the agent', onSend, blocked ?? 'One message with every decision and comment, into the plan’s conversation')
    send.disabled = blocked !== null
    bar.appendChild(send)
  }
  const chips = reviewChips(state.notes, state.drafts)
  if (chips.length > 0) {
    const row = el('div', 'fb-nr-chips')
    for (const chip of chips) {
      const node = el('span', `fb-nr-chip fb-nr-chip-${chip.decision}`)
      node.append(el('b', '', chip.title), chip.text.slice(chip.title.length))
      node.title = `Note ${String(chip.n)}`
      row.appendChild(node)
    }
    bar.appendChild(row)
  }
  host.appendChild(bar)
}
