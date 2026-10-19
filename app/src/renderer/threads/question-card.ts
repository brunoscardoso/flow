/**
 * QuestionCard — renders an AskUserQuestion dialog inline in the conversation
 * so the user picks answers, instead of the agent's silent auto-skip. Each
 * question shows its options (single- or multi-select) plus an "Other" free
 * text; Submit sends the answers back via threads:respondDialog.
 */
import '../components'
import type {
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionRequest,
} from '../../shared/ipc-contract'
import { SessionGoneError, sessionGoneMessage, submitFailureMessage } from './question-submit'
import { carouselView, clampIndex } from './question-carousel'
import { answeredCount, firstUnansweredIndex } from './question-completeness'
import {
  optionIndexForKey,
  optionShortcutKey,
  shouldAdvanceAfterPick,
} from './question-shortcuts'
import { questionKeyDispatcher } from './question-key-dispatcher'
import { parseOptionLabel } from './question-recommendation'

type SubmitHandler = (answers: UserQuestionAnswer[]) => void | Promise<void>

/** Delay before the carousel auto-advances after a single-select pick (#465), so
 *  the selected highlight is visible before the question changes. */
const ADVANCE_DELAY_MS = 180

export class QuestionCard {
  readonly element: HTMLElement
  #request: UserQuestionRequest
  #onSubmit: SubmitHandler
  /** Clear this card from the pane — invoked by the terminal Dismiss control (#301). */
  #onDismiss?: () => void
  #submitBtn: HTMLButtonElement
  #footer: HTMLElement
  #error: HTMLElement
  #done = false
  /** Selected option labels per question header. */
  #picked = new Map<string, Set<string>>()
  /** "Other" free text per question header. */
  #other = new Map<string, string>()
  /** One DOM block per question — shown one at a time as a carousel (#400). */
  #blocks: HTMLElement[] = []
  /** Current carousel position. */
  #index = 0
  #pager?: HTMLElement
  #hint?: HTMLButtonElement
  #backBtn?: HTMLButtonElement
  #nextBtn?: HTMLButtonElement
  #pagerLabel?: HTMLElement

  constructor(request: UserQuestionRequest, onSubmit: SubmitHandler, onDismiss?: () => void) {
    this.#request = request
    this.#onSubmit = onSubmit
    this.#onDismiss = onDismiss
    injectQuestionStyles()

    this.element = document.createElement('div')
    this.element.className = 'fl-qcard'

    /**
     * A titled bar with a minimize — the card is a thing that ARRIVED, not part
     * of the transcript it sits in, and it needs to say so and be foldable.
     * Folding hides the questions and the footer, never the title: a card that
     * collapses to nothing is a question you can lose.
     */
    const bar = document.createElement('div')
    bar.className = 'fl-qcard-bar'
    const barTitle = document.createElement('span')
    barTitle.className = 'fl-qcard-title'
    barTitle.textContent = request.questions.length > 1 ? 'Questions' : 'Question'
    const fold = document.createElement('button')
    fold.type = 'button'
    fold.className = 'fl-qcard-fold'
    fold.textContent = '—'
    fold.title = 'Minimize'
    fold.setAttribute('aria-label', 'Minimize this question')
    fold.setAttribute('aria-expanded', 'true')
    fold.addEventListener('click', () => {
      const folded = this.element.classList.toggle('is-folded')
      fold.textContent = folded ? '+' : '—'
      fold.title = folded ? 'Show the question' : 'Minimize'
      fold.setAttribute('aria-label', folded ? 'Show this question' : 'Minimize this question')
      fold.setAttribute('aria-expanded', String(!folded))
    })
    bar.append(barTitle, fold)
    this.element.appendChild(bar)

    for (const question of request.questions) {
      this.#picked.set(question.header, new Set())
      const block = this.#renderQuestion(question)
      this.#blocks.push(block)
      this.element.appendChild(block)
    }

    this.#error = document.createElement('div')
    this.#error.className = 'fl-qcard-error'
    this.#error.setAttribute('role', 'alert')
    this.#error.hidden = true
    this.element.appendChild(this.#error)

    this.#footer = document.createElement('div')
    this.#footer.className = 'fl-qcard-footer'

    // Carousel pager (#400) — one question at a time when there are 2+, with a
    // Back / "i of N" / Next control. Hidden entirely for a single question.
    this.#pager = document.createElement('div')
    this.#pager.className = 'fl-qcard-pager'
    this.#backBtn = document.createElement('button')
    this.#backBtn.type = 'button'
    this.#backBtn.className = 'fl-qcard-nav'
    // Arrows alone: the count between them already says what they move through,
    // and "Back"/"Next ›" on a three-question card was more words than answers.
    this.#backBtn.textContent = '‹'
    this.#backBtn.setAttribute('aria-label', 'Previous question')
    this.#backBtn.addEventListener('click', () => this.#go(this.#index - 1))
    this.#pagerLabel = document.createElement('span')
    this.#pagerLabel.className = 'fl-qcard-pager-label'
    this.#nextBtn = document.createElement('button')
    this.#nextBtn.type = 'button'
    this.#nextBtn.className = 'fl-qcard-nav'
    this.#nextBtn.textContent = '›'
    this.#nextBtn.setAttribute('aria-label', 'Next question')
    this.#nextBtn.addEventListener('click', () => this.#go(this.#index + 1))
    this.#pager.append(this.#backBtn, this.#pagerLabel, this.#nextBtn)
    this.#footer.appendChild(this.#pager)

    // Completeness cue (#414): names the first unanswered HIDDEN question (with
    // progress) and jumps to it on click, so a carousel's disabled Submit isn't
    // a mystery. Hidden for single-question cards / when complete.
    this.#hint = document.createElement('button')
    this.#hint.type = 'button'
    this.#hint.className = 'fl-qcard-hint'
    this.#hint.setAttribute('aria-live', 'polite')
    this.#hint.hidden = true
    this.#hint.addEventListener('click', () => {
      const idx = firstUnansweredIndex(this.#answeredFlags())
      if (idx >= 0) this.#go(idx)
    })
    this.#footer.appendChild(this.#hint)

    // SKIP — the way out, named. The card could already be dismissed, but only
    // by whatever mounted it; from inside there was no way to say "not this one"
    // and a question with no exit is a modal wearing a card's clothes.
    if (onDismiss) {
      const skip = document.createElement('button')
      skip.type = 'button'
      skip.className = 'fl-qcard-nav'
      skip.textContent = 'Skip'
      skip.addEventListener('click', () => this.#onDismiss?.())
      this.#footer.appendChild(skip)
    }

    this.#submitBtn = document.createElement('button')
    this.#submitBtn.type = 'button'
    this.#submitBtn.className = 'fl-qcard-submit'
    this.#submitBtn.textContent = 'Continue'
    this.#submitBtn.addEventListener('click', () => void this.#submit())
    this.#footer.appendChild(this.#submitBtn)
    this.element.appendChild(this.#footer)

    this.#renderCarousel()
    this.#syncSubmit()

    // Keyboard shortcuts (#465, reworked for #983/#984): register with the shared
    // dispatcher, which owns the single document keydown listener and routes each
    // digit to exactly ONE card — the card holding focus, else the newest visible
    // unanswered one — and only when the keystroke would not destroy typing (it
    // fires from the EMPTY composer, but never over a draft or an "Other" box).
    questionKeyDispatcher.register(this)
  }

  /** Dispatcher contract — answered / terminal / mid-submit cards take no digits. */
  isResolved(): boolean {
    return this.#done
  }

  /** Dispatcher contract — apply a digit shortcut. True when an option was picked. */
  handleShortcutKey(key: string): boolean {
    return this.#pickByKey(key)
  }

  /** Release the shortcut registration. Safe to call more than once. MUST be
   *  called when the card is removed outside its own lifecycle (dialog cancel,
   *  feed rebuild) so no detached card lingers in the dispatcher (#984). */
  dispose(): void {
    this.#teardownKeys()
  }

  /** Take shortcuts again after a feed rebuild re-mounts this same card — the
   *  picks, "Other" text and carousel position it holds are the user's work. */
  resume(): void {
    questionKeyDispatcher.register(this)
  }

  #teardownKeys(): void {
    questionKeyDispatcher.unregister(this)
  }

  /** Select the visible question's option for a digit key. Returns true if handled. */
  #pickByKey(key: string): boolean {
    const question = this.#request.questions[this.#index]
    const block = this.#blocks[this.#index]
    if (!question || !block) return false
    const optionIndex = optionIndexForKey(key, question.options.length)
    if (optionIndex === null) return false
    const option = question.options[optionIndex]
    const btn = block.querySelectorAll<HTMLElement>('.fl-qcard-option')[optionIndex]
    if (!option || !btn) return false
    this.#pick(question, option.label, btn, block)
    return true
  }

  /** Navigate the carousel to a (clamped) question index. */
  #go(index: number): void {
    this.#index = clampIndex(index, this.#blocks.length)
    this.#renderCarousel()
  }

  /** Show only the current question (when 2+), and sync the pager controls. */
  #renderCarousel(): void {
    const view = carouselView(this.#index, this.#blocks.length)
    this.#index = view.index
    this.#blocks.forEach((block, i) => {
      block.hidden = view.isCarousel && i !== view.index
    })
    if (this.#pager) this.#pager.hidden = !view.isCarousel
    if (this.#pagerLabel) this.#pagerLabel.textContent = view.position
    if (this.#backBtn) this.#backBtn.disabled = view.atStart
    if (this.#nextBtn) this.#nextBtn.disabled = view.atEnd
  }

  #renderQuestion(question: UserQuestion): HTMLElement {
    const block = document.createElement('div')
    block.className = 'fl-qcard-q'

    const header = document.createElement('div')
    header.className = 'fl-qcard-header'
    header.textContent = question.header + (question.multiSelect ? '  (select any)' : '')
    const prompt = document.createElement('div')
    prompt.className = 'fl-qcard-prompt'
    prompt.textContent = question.question
    block.appendChild(header)
    block.appendChild(prompt)

    question.options.forEach((option, optionIndex) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'fl-qcard-option'
      // Keyboard shortcut badge (1..9) — pressing the digit selects this option (#465).
      const shortcut = optionShortcutKey(optionIndex)
      if (shortcut) {
        const key = document.createElement('span')
        key.className = 'fl-qcard-option-key'
        key.textContent = shortcut
        key.setAttribute('aria-hidden', 'true')
        btn.appendChild(key)
      }
      // The agent marks its recommendation by appending "(Recommended)" to the
      // label — there is no structured field. Lift it out of the label text and
      // render it as a badge, so the cue reads at a glance instead of trailing
      // off the end of a sentence. The ORIGINAL label is still what gets
      // submitted (see #pick below) — the agent matches on what it sent.
      const parsed = parseOptionLabel(option.label)
      const label = document.createElement('div')
      label.className = 'fl-qcard-option-label'
      label.textContent = parsed.label
      btn.appendChild(label)
      if (parsed.recommended) {
        const badge = document.createElement('span')
        badge.className = 'fl-qcard-option-badge'
        badge.textContent = 'Recommended'
        // A sibling of the label, never a child: the label node's textContent is
        // read as "the option the user chose" (e2e selection assertions).
        btn.appendChild(badge)
      }
      if (option.description) {
        const desc = document.createElement('div')
        desc.className = 'fl-qcard-option-desc'
        desc.textContent = option.description
        btn.appendChild(desc)
      }
      btn.addEventListener('click', () => this.#pick(question, option.label, btn, block))
      block.appendChild(btn)
    })

    // "Other" free-text — the AskUserQuestion tool always offers this. A textarea
    // (not a one-line input) so a longer custom answer is comfortable to type (#564).
    const other = document.createElement('textarea')
    other.className = 'fl-qcard-other'
    other.rows = 2
    other.placeholder = 'Other…'
    other.addEventListener('input', () => {
      const value = other.value.trim()
      if (value) this.#other.set(question.header, value)
      else this.#other.delete(question.header)
      if (!question.multiSelect && value) {
        // Single-select: a free-text answer clears the option picks.
        this.#picked.get(question.header)?.clear()
        block.querySelectorAll('.fl-qcard-option.selected').forEach((el) => el.classList.remove('selected'))
      }
      this.#syncSubmit()
    })
    block.appendChild(other)
    return block
  }

  #pick(question: UserQuestion, label: string, btn: HTMLElement, block: HTMLElement): void {
    const set = this.#picked.get(question.header)
    if (!set) return
    if (question.multiSelect) {
      if (set.has(label)) {
        set.delete(label)
        btn.classList.remove('selected')
      } else {
        set.add(label)
        btn.classList.add('selected')
      }
    } else {
      set.clear()
      set.add(label)
      block.querySelectorAll('.fl-qcard-option.selected').forEach((el) => el.classList.remove('selected'))
      btn.classList.add('selected')
      // A concrete pick supersedes any typed "Other".
      const other = block.querySelector('.fl-qcard-other') as HTMLTextAreaElement | null
      if (other) other.value = ''
      this.#other.delete(question.header)
    }
    this.#syncSubmit()
    // Single-select: advance to the next question automatically (#465). A short
    // delay lets the selected highlight register before the carousel moves; on the
    // last question we stay put (Submit is next) and focus it so ⏎ submits.
    if (shouldAdvanceAfterPick(question.multiSelect === true, this.#index >= this.#blocks.length - 1)) {
      window.setTimeout(() => {
        if (!this.#done) this.#go(this.#index + 1)
      }, ADVANCE_DELAY_MS)
    } else if (!question.multiSelect && !this.#submitBtn.disabled) {
      this.#submitBtn.focus()
    }
  }

  #answerFor(question: UserQuestion): string[] {
    const selected = [...(this.#picked.get(question.header) ?? [])]
    const other = this.#other.get(question.header)
    return other ? [...selected, other] : selected
  }

  /** Per-question answered flags, in question order. */
  #answeredFlags(): boolean[] {
    return this.#request.questions.map((q) => this.#answerFor(q).length > 0)
  }

  #syncSubmit(): void {
    const flags = this.#answeredFlags()
    const complete = flags.every(Boolean)
    this.#submitBtn.disabled = !complete || this.#done

    // Point the user at the first unanswered HIDDEN question (#414). Only for a
    // multi-question carousel that's still incomplete and not yet submitted — a
    // single-question card shows its question, so a disabled Submit is obvious.
    if (this.#hint) {
      const idx = firstUnansweredIndex(flags)
      const show = this.#blocks.length > 1 && idx >= 0 && !this.#done
      this.#hint.hidden = !show
      if (show) {
        const header = this.#request.questions[idx]?.header ?? ''
        this.#hint.textContent = `Answer “${header}” (${answeredCount(flags)}/${flags.length})`
      }
    }
  }

  async #submit(): Promise<void> {
    if (this.#done) return
    // Optimistically lock while the answer is in flight, but DON'T commit the
    // terminal "Answered" state until the send actually lands — otherwise a
    // rejected respondDialog leaves the card lying "Answered" with the agent
    // parked forever (#278). Mirror PermissionCard.#resolve: on failure roll
    // back to the interactive state and surface an inline error to retry.
    this.#done = true
    this.#submitBtn.disabled = true
    this.#submitBtn.textContent = 'Sending…'
    this.#error.hidden = true
    const answers: UserQuestionAnswer[] = this.#request.questions.map((q) => ({
      header: q.header,
      selected: this.#answerFor(q),
    }))
    try {
      await this.#onSubmit(answers)
      this.#submitBtn.textContent = 'Answered'
      this.element.classList.add('fl-qcard-answered')
      this.#teardownKeys() // resolved — stop listening for shortcuts (#465)
    } catch (error) {
      console.error('flow: failed to submit question answers', error)
      // A gone session is TERMINAL: retrying can never succeed, so drop the
      // "Try again" affordance and offer a Dismiss instead of an infinite dead-end (#301).
      if (error instanceof SessionGoneError) {
        this.#renderTerminal()
        return
      }
      this.#done = false
      this.#submitBtn.textContent = 'Continue'
      this.#error.textContent = submitFailureMessage(error)
      this.#error.hidden = false
      // Selections are untouched — re-enable Submit if the answers are still complete.
      this.#syncSubmit()
    }
  }

  /** Render the unrecoverable "session gone" dead-end: terminal copy (no retry),
   *  Submit removed, and a Dismiss that clears the card from the pane (#301). */
  #renderTerminal(): void {
    this.#done = true
    this.#teardownKeys() // terminal — stop listening for shortcuts (#465)
    this.#submitBtn.hidden = true
    this.element.classList.add('fl-qcard-answered')
    this.#error.textContent = sessionGoneMessage()
    this.#error.hidden = false
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'fl-qcard-submit'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', () => {
      this.element.remove()
      this.#onDismiss?.()
    })
    this.#footer.appendChild(dismiss)
  }
}

let stylesInjected = false

function injectQuestionStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-qcard { display: flex; flex-direction: column; gap: var(--fl-space-md); padding: var(--fl-space-md); background: var(--fl-color-surface-raised); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-lg); }
    /* The title bar. Its own row, so the card announces what it is before it
       asks anything. */
    .fl-qcard-bar { display: flex; align-items: center; gap: var(--fl-space-sm); margin-bottom: calc(-1 * var(--fl-space-xs)); }
    .fl-qcard-title { flex: 1; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-qcard-fold { flex: none; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: var(--fl-radius-sm); background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; font-size: 13px; line-height: 1; }
    .fl-qcard-fold:hover { background: var(--fl-color-bg); color: var(--fl-color-text); }
    /* Folded: the questions and the footer go, the bar stays. A card that
       collapses to nothing is a question you can lose. */
    .fl-qcard.is-folded .fl-qcard-q,
    .fl-qcard.is-folded .fl-qcard-footer,
    .fl-qcard.is-folded .fl-qcard-error { display: none; }
    .fl-qcard-answered { opacity: 0.7; }
    .fl-qcard-q { display: flex; flex-direction: column; gap: 4px; }
    /* Class display:flex outranks the UA [hidden]{display:none}, so the carousel
       couldn't hide off-screen questions without this higher-specificity rule. */
    .fl-qcard-q[hidden] { display: none; }
    .fl-qcard-header { font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); letter-spacing: 0.06em; text-transform: uppercase; color: var(--fl-color-text-secondary); }
    .fl-qcard-prompt { font-size: var(--fl-text-prose-size); color: var(--fl-color-text); margin-bottom: 2px; }
    /* A row, not a boxed button: the list reads as choices in one panel rather
       than as five outlined objects stacked on each other. The key badge moves
       to the LEFT edge, where the eye scans for it, and the row indents to clear
       it — the same shape the reference uses. */
    .fl-qcard-option { position: relative; display: block; width: 100%; text-align: left; border: var(--fl-border-width) solid transparent; background: var(--fl-color-bg); border-radius: var(--fl-radius-md); padding: 7px var(--fl-space-sm) 7px 30px; cursor: pointer; color: var(--fl-color-text); font-family: var(--fl-font-ui); }
    .fl-qcard-option:hover { background: var(--fl-color-surface); }
    .fl-qcard-option.selected { border-color: var(--fl-color-accent, var(--fl-color-focus-ring)); background: var(--fl-color-accent-muted); }
    /* Shortcut key badge (#465) — top-right corner of each option. */
    .fl-qcard-option-key { position: absolute; top: 7px; left: 7px; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; text-align: center; font-size: var(--fl-text-caption-size); font-variant-numeric: tabular-nums; color: var(--fl-color-text-secondary); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); line-height: 1; }
    .fl-qcard-option.selected .fl-qcard-option-key { color: var(--fl-color-accent); border-color: var(--fl-color-accent); }
    /* inline-block so the Recommended badge sits on the label's line (the badge
       is a SIBLING, not a child — the label node's text is the chosen option). */
    .fl-qcard-option-label { display: inline-block; font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); }
    /* The agent's recommendation, lifted out of the label text (#question-recommendation).
       Deliberately NOT the selection accent — an unpicked option must never read
       as picked; this is a quieter, outline-only cue. */
    .fl-qcard-option-badge { display: inline-block; margin-left: 6px; font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); letter-spacing: 0.04em; color: var(--fl-color-accent, var(--fl-color-focus-ring)); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: 999px; padding: 0 7px; line-height: 1.6; white-space: nowrap; }
    .fl-qcard-option:hover .fl-qcard-option-badge, .fl-qcard-option.selected .fl-qcard-option-badge { border-color: var(--fl-color-accent); }
    .fl-qcard-option-desc { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); margin-top: 1px; }
    .fl-qcard-other { width: 100%; box-sizing: border-box; min-height: 3.4em; resize: vertical; padding: 5px var(--fl-space-sm); background: var(--fl-color-bg); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); color: var(--fl-color-text); font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); line-height: 1.4; outline: none; }
    .fl-qcard-other:focus { border-color: var(--fl-color-focus-ring); }
    .fl-qcard-error { font-size: var(--fl-text-caption-size); color: var(--fl-color-error); }
    .fl-qcard-footer { display: flex; align-items: center; gap: var(--fl-space-sm); justify-content: flex-end; }
    .fl-qcard-pager { display: flex; align-items: center; gap: var(--fl-space-xs); margin-right: auto; }
    .fl-qcard-pager[hidden] { display: none; }
    .fl-qcard-pager-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); font-variant-numeric: tabular-nums; }
    .fl-qcard-nav { border: none; background: transparent; color: var(--fl-color-text-secondary); cursor: pointer; padding: 4px var(--fl-space-sm); border-radius: var(--fl-radius-sm); font-size: var(--fl-text-caption-size); }
    .fl-qcard-nav:hover:not(:disabled) { background: var(--fl-color-bg); color: var(--fl-color-text); }
    .fl-qcard-nav:disabled { opacity: 0.4; cursor: default; }
    .fl-qcard-hint { border: none; background: none; padding: 0; cursor: pointer; color: var(--fl-color-accent, var(--fl-color-focus-ring)); font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); text-align: right; }
    .fl-qcard-hint[hidden] { display: none; }
    .fl-qcard-hint:hover { text-decoration: underline; }
    .fl-qcard-submit { border: var(--fl-border-width) solid var(--fl-color-border); background: var(--fl-color-accent-muted); color: var(--fl-color-text); cursor: pointer; padding: 5px var(--fl-space-md); border-radius: var(--fl-radius-sm); font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-qcard-submit:hover:not(:disabled) { border-color: var(--fl-color-focus-ring); }
    .fl-qcard-submit:disabled { opacity: 0.5; cursor: default; }
  `
  document.head.appendChild(style)
}
