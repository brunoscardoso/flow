// Digit-shortcut scoping for AskUserQuestion cards (#983/#984). Pure decisions
// behind the one-owner model: at any moment the 1-9 shortcuts belong to exactly
// ONE card — the card the user is working in (focus inside it), else the newest
// visible unanswered card — and a digit only routes to a card at all when it
// would not destroy typing. DOM-free so the routing/scope rules are
// unit-testable; question-key-dispatcher owns the wiring.

/** Whether a keydown key is a 1-9 option shortcut at all. */
export function isShortcutDigit(key: string): boolean {
  return /^[1-9]$/.test(key)
}

export interface DigitRouteInput {
  /** The event target is a text-entry surface (input/textarea/contenteditable). */
  isTextTarget: boolean
  /** The text target is the message composer (as opposed to e.g. a card's "Other" box). */
  isComposerTarget: boolean
  /** The composer holds no draft text. */
  composerEmpty: boolean
}

/**
 * Whether a digit keydown should route to a question card instead of typing.
 *
 * Non-text targets always route to the card. The composer routes ONLY while it
 * is empty — a pending question is the one moment the card owns the keyboard
 * (#983), but a digit must never destroy an in-progress draft. Any other text
 * surface (a card's "Other" textarea, search fields, rename inputs) keeps its
 * keystrokes unconditionally.
 */
export function shouldRouteDigitToCard(input: DigitRouteInput): boolean {
  if (!input.isTextTarget) return true
  return input.isComposerTarget && input.composerEmpty
}

export interface ScopeCandidate {
  /** The card is mounted and on screen. */
  visible: boolean
  /** The card is answered / terminal / mid-submit — no longer interactive. */
  resolved: boolean
  /** Keyboard focus is inside the card. */
  containsFocus: boolean
}

/**
 * The single card (index into `candidates`, which is in feed order — oldest
 * first) that owns a digit shortcut, or -1 when none does. The card the user is
 * working in (focus inside it) wins; otherwise the newest visible unanswered
 * card. Exactly one card ever answers a keystroke (#984) — resolving it
 * naturally moves the scope to the next remaining card.
 */
export function targetCardIndex(candidates: ScopeCandidate[]): number {
  let newestLive = -1
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!candidate.visible || candidate.resolved) continue
    if (candidate.containsFocus) return i
    newestLive = i
  }
  return newestLive
}
