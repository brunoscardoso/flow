// Refresh gate for the Review panel (#182). A background file change in the
// active project (heartbeat writing flow/log.md, a brain capture touching
// .brain.sqlite, the agent writing a file) triggers a full panel re-render,
// which tears down the DOM. If the user has an inline reject-feedback prompt
// open (mid-typing) or a "Discard all" two-step confirm showing, that transient
// UI — and any typed feedback — is silently destroyed.
//
// The gate DEFERS re-renders while such a transient interaction is open: the
// panel hands each incoming groups update to the gate, which either returns it
// to render now or stores it as the latest pending update. When the interaction
// closes, the gate flushes the newest deferred update. Pure + DOM-free so the
// defer/flush behavior unit-tests directly.

/**
 * Decide whether Review-panel refreshes render immediately or defer while a
 * transient interaction (reject prompt / discard confirm) is open.
 *
 * REF-COUNTED (#188): two transient prompts can overlap (two reject prompts, or
 * a reject prompt plus a discard confirm), because opening one only mutates its
 * own row and leaves the rest of the panel live. A single boolean would let
 * closing the FIRST prompt lower the guard while the SECOND is still open,
 * re-exposing the exact #182 data loss. A depth counter keeps the gate open
 * until EVERY interaction has closed.
 */
export class ReviewRefreshGate<G> {
  #depth = 0
  #pending: G | null = null

  /** True while any transient interaction is open (renders are being deferred). */
  get isOpen(): boolean {
    return this.#depth > 0
  }

  /** Mark a transient interaction (reject prompt / discard confirm) as open. */
  open(): void {
    this.#depth += 1
  }

  /**
   * A full render just happened, which destroys ALL transient UI at once — so no
   * interaction can still be open. Hard-resets the depth to 0 WITHOUT discarding
   * a pending update (the next receive() clears it). Safety net for renders that
   * bypass close() (e.g. the mode toggle), so the gate never stays stuck-open.
   */
  markRendered(): void {
    this.#depth = 0
  }

  /**
   * A groups update arrived. Returns the groups to render NOW, or null to defer
   * (the update is stored as the latest pending, superseding any earlier one).
   */
  receive(groups: G): G | null {
    if (this.#depth > 0) {
      this.#pending = groups
      return null
    }
    this.#pending = null
    return groups
  }

  /**
   * One interaction closed. Decrements the depth; while OTHER interactions remain
   * open it returns null (stay deferred). Only when the last one closes does it
   * return the newest deferred update to render (or null if none was deferred).
   */
  close(): G | null {
    if (this.#depth > 0) this.#depth -= 1
    if (this.#depth > 0) return null // another interaction is still open
    const pending = this.#pending
    this.#pending = null
    return pending
  }

  /**
   * A DESTRUCTIVE action completed (Discard N / Redo) — it invalidates every
   * row, so protecting a sibling prompt's stale DOM no longer makes sense
   * (#1018). Hard-closes ALL interactions (depth → 0) and returns the newest
   * deferred update (or null), so the completion's own refresh renders instead
   * of deferring forever behind a prompt over rows that no longer exist.
   */
  forceClose(): G | null {
    this.#depth = 0
    const pending = this.#pending
    this.#pending = null
    return pending
  }
}
