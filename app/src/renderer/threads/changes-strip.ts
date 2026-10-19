/**
 * `Changes  +1460  −5` — in the conversation's footer row, beside tokens saved.
 *
 * THE MISSING DOOR (#1906). The review has now been built twice and found
 * neither time: as a band in the chat column (which ate the reading column), and
 * as an editor tab (which is the right home, but opens only from the command
 * palette). A user with an open thread and two changed files reported seeing
 * nothing at all, and was right — nothing on screen said there was anything to
 * look at. Cursor puts exactly this line above its composer; pressing it opens
 * the Changes tab, beside Code, Tasks and Blueprint.
 *
 * IT SHIPPED AS A FULL-WIDTH BAND across the pane, and read as a divider
 * between the conversation and the composer rather than as a control belonging
 * to the thread. It is a pill in the pane's footer row now (user, 2026-09-10),
 * on the same line and the same column as the tokens-saved chip — which is the
 * conversation's own text column, not the pane's edge.
 *
 * It is a BUTTON, not a card: one line, one press, no state of its own. Every
 * decision it renders comes from `changesStripState`, which is pure and tested;
 * the numbers come from the shared store, so this and the tab can never
 * disagree about what the thread changed.
 */
import { changesStripState } from './change-review-model'
import { changeReviewStore } from './change-review-store'

export interface ChangesStrip {
  dispose(): void
}

export function mountChangesStrip(host: HTMLElement): ChangesStrip {
  injectStyles()

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-changes-strip'
  button.hidden = true

  const glyph = document.createElement('span')
  glyph.className = 'fl-changes-strip-glyph'
  glyph.textContent = '±'
  glyph.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.className = 'fl-changes-strip-label'

  const added = document.createElement('span')
  added.className = 'fl-changes-strip-added'
  const deleted = document.createElement('span')
  deleted.className = 'fl-changes-strip-deleted'

  button.append(glyph, label, added, deleted)
  host.appendChild(button)

  // One door, dispatched by every surface that opens the review (shell.ts owns
  // what "open" means — allowed-pattern #14).
  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('flow:open-change-review'))
  })

  const unsubscribe = changeReviewStore.subscribe({
    // The control lives in the conversation's footer, so it is on screen
    // whenever the transcript is — which is what funds the store's refetches.
    onScreen: () => button.isConnected && host.getClientRects().length > 0,
    render: (snapshot) => {
      const state = changesStripState(snapshot.review)
      button.hidden = !state.show
      label.textContent = state.label
      added.textContent = state.added
      deleted.textContent = state.deleted
      button.title = state.title
      button.setAttribute('aria-label', state.title)
    },
  })

  return {
    dispose(): void {
      unsubscribe()
      button.remove()
    },
  }
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
/* A PILL IN THE CONVERSATION'S FOOTER ROW, beside the tokens-saved chip and on
   the transcript's own column — not a full-width band across the pane. It was
   the band first, and it read as a section divider between the conversation and
   the composer rather than as a control belonging to the thread. */
.fl-changes-strip {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0; padding: 2px 9px;
  border: var(--fl-border-width, 1px) solid var(--fl-color-border, #2a2a2a);
  border-radius: 999px;
  background: var(--fl-color-surface-raised, #1f1f1f);
  color: var(--fl-color-text-secondary, #aaa);
  font: inherit; font-size: var(--fl-text-caption-size, 12px);
  cursor: pointer; max-width: 100%;
}
.fl-changes-strip:hover { color: var(--fl-color-text, #ddd); border-color: var(--fl-color-accent, #4a9eff); }
.fl-changes-strip:focus-visible { outline: 1px solid var(--fl-color-accent, #4a9eff); outline-offset: 1px; }
.fl-changes-strip-glyph { flex: none; opacity: .7; }
.fl-changes-strip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The two numbers are the point of the control, so they read as numbers:
   tabular, so a growing diff does not jitter the row it sits in. */
.fl-changes-strip-added, .fl-changes-strip-deleted { flex: none; font-variant-numeric: tabular-nums; }
.fl-changes-strip-added { color: #4ec9b0; }
.fl-changes-strip-deleted { color: #f14c4c; }
.fl-changes-strip-added:empty, .fl-changes-strip-deleted:empty { display: none; }
`
  document.head.appendChild(style)
}
