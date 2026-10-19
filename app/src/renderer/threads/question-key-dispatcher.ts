// Single document-level owner of the AskUserQuestion digit shortcuts
// (#983/#984). Cards register on mount and unregister on resolve/removal; ONE
// keydown listener picks the one card that owns the keystroke (focused card,
// else newest visible unanswered — see question-key-scope) and dispatches to it.
// This replaces the old per-card document listeners, which both went dead while
// the composer held focus (#983) and all fired on the same digit when several
// cards were pending (#984), and it removes the listener leak on feed rebuilds.

import { isShortcutDigit, shouldRouteDigitToCard, targetCardIndex } from './question-key-scope'

/** What the dispatcher needs from a question card. */
export interface ShortcutTarget {
  readonly element: HTMLElement
  /** Answered / terminal / mid-submit — no longer interactive. */
  isResolved(): boolean
  /** Apply a digit shortcut to the card. Returns true when it selected an option. */
  handleShortcutKey(key: string): boolean
}

const COMPOSER_SELECTOR = '.fl-composer-input'

function isTextEntry(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

class QuestionKeyDispatcher {
  /** Registered cards in mount (feed) order — newest last. */
  #cards: ShortcutTarget[] = []
  #listening = false

  register(card: ShortcutTarget): void {
    if (this.#cards.includes(card)) return
    this.#cards.push(card)
    if (!this.#listening) {
      document.addEventListener('keydown', this.#onKeydown)
      this.#listening = true
    }
  }

  unregister(card: ShortcutTarget): void {
    this.#cards = this.#cards.filter((c) => c !== card)
    if (this.#cards.length === 0 && this.#listening) {
      document.removeEventListener('keydown', this.#onKeydown)
      this.#listening = false
    }
  }

  #onKeydown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (!isShortcutDigit(event.key)) return

    const target = event.target
    const isTextTarget = isTextEntry(target)
    const isComposerTarget = isTextTarget && target.closest(COMPOSER_SELECTOR) !== null
    const composerEmpty = isComposerTarget && (target as HTMLTextAreaElement).value === ''
    if (!shouldRouteDigitToCard({ isTextTarget, isComposerTarget, composerEmpty })) return

    const active = document.activeElement
    const index = targetCardIndex(
      this.#cards.map((card) => ({
        visible: card.element.isConnected && card.element.offsetParent !== null,
        resolved: card.isResolved(),
        containsFocus: active !== null && card.element.contains(active),
      })),
    )
    const owner = index >= 0 ? this.#cards[index] : undefined
    if (owner?.handleShortcutKey(event.key)) event.preventDefault()
  }
}

/** The app-wide dispatcher — one listener no matter how many cards are pending. */
export const questionKeyDispatcher = new QuestionKeyDispatcher()
