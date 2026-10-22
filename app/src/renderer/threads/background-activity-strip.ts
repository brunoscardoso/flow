/**
 * `4 running · 1 queued · 1 failed` — in the conversation's footer row, beside
 * Changes (plan_mid-run-subtasks FR-9; it read `Sub-agents activity  3`).
 *
 * The report behind it (#1931, and `thread-sidebar.ts`'s header before it): a
 * thread launches sub-agents and runs terminal commands while it keeps talking,
 * and once the turn ends nothing on screen says that work is still out. Changes
 * got a footer pill that opens its tab; this is its sibling — a pill that says
 * how many background runs the thread has, and opens the list of them ABOVE the
 * composer when pressed. Each item there opens its own detail tab on the right.
 *
 * It is a BUTTON, not a card: one line, one press. Every number it renders comes
 * from `backgroundActivityStore`, the one reader, so this and the popover can
 * never disagree about what the thread ran. It hides itself when there is
 * nothing, so the new-thread page needs no special case.
 */
import { activityStripState } from './background-activity-model'
import { backgroundActivityStore } from './background-activity-store'
import { backgroundWorkView } from './background-work-model'
import {
  openBackgroundActivityPopover,
  type BackgroundActivityPopoverHandle,
} from './background-activity-popover'

export interface BackgroundActivityStrip {
  dispose(): void
}

export function mountBackgroundActivityStrip(host: HTMLElement): BackgroundActivityStrip {
  injectStyles()

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-bgactivity-strip'
  button.hidden = true

  const glyph = document.createElement('span')
  glyph.className = 'fl-bgactivity-strip-glyph'
  glyph.textContent = '◴'
  glyph.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.className = 'fl-bgactivity-strip-label'

  button.append(glyph, label)
  host.appendChild(button)

  // Toggle: a control that opens a menu closes it on the second press. The
  // popover clears this back to null when it settles by ANY route (Escape, an
  // outside click, a close of its own), so the state here can never get stuck
  // "open" over a menu that is gone.
  let popover: BackgroundActivityPopoverHandle | null = null
  button.addEventListener('click', () => {
    if (popover) {
      popover.close()
      return
    }
    popover = openBackgroundActivityPopover(button, () => {
      popover = null
    })
  })

  const unsubscribe = backgroundActivityStore.subscribe({
    onScreen: () => button.isConnected && host.getClientRects().length > 0,
    render: (snapshot) => {
      // The counts come from the panel's own model, so the pill and the panel
      // it opens never disagree (plan_mid-run-subtasks FR-9).
      const state = activityStripState(backgroundWorkView({ ...snapshot, now: Date.now() }).counts)
      button.hidden = !state.show
      // A thread that just cleared its last background work must not leave an
      // empty list floating over the composer.
      if (!state.show && popover) popover.close()
      label.replaceChildren()
      state.segments.forEach((segment, index) => {
        if (index > 0) {
          const dot = document.createElement('span')
          dot.className = 'fl-bgactivity-strip-sep'
          dot.setAttribute('aria-hidden', 'true')
          dot.textContent = '·'
          label.append(dot)
        }
        const part = document.createElement('span')
        part.className = segment.failed ? 'fl-bgactivity-strip-failed' : 'fl-bgactivity-strip-part'
        part.textContent = segment.text
        label.append(part)
      })
      button.classList.toggle('is-running', state.running > 0)
      button.title = state.title
      button.setAttribute('aria-label', state.title)
    },
  })

  return {
    dispose(): void {
      unsubscribe()
      if (popover) popover.close()
      button.remove()
    },
  }
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // A pill, twin to the Changes strip it sits beside — same shape, same tokens.
  style.textContent = `
.fl-bgactivity-strip {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0; padding: 2px 9px;
  border: var(--fl-border-width, 1px) solid var(--fl-color-border, #2a2a2a);
  border-radius: 999px;
  background: var(--fl-color-surface-raised, #1f1f1f);
  color: var(--fl-color-text-secondary, #aaa);
  font: inherit; font-size: var(--fl-text-caption-size, 12px);
  cursor: pointer; max-width: 100%;
}
.fl-bgactivity-strip:hover { color: var(--fl-color-text, #ddd); border-color: var(--fl-color-accent, #4a9eff); }
.fl-bgactivity-strip:focus-visible { outline: 1px solid var(--fl-color-accent, #4a9eff); outline-offset: 1px; }
.fl-bgactivity-strip-glyph { flex: none; opacity: .7; }
/* The glyph spins only while something is actually running. */
.fl-bgactivity-strip.is-running .fl-bgactivity-strip-glyph { animation: fl-bgactivity-spin 1.6s linear infinite; }
@media (prefers-reduced-motion: reduce) { .fl-bgactivity-strip.is-running .fl-bgactivity-strip-glyph { animation: none; } }
@keyframes fl-bgactivity-spin { to { transform: rotate(360deg); } }
.fl-bgactivity-strip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fl-bgactivity-strip-sep { padding: 0 4px; opacity: .6; }
.fl-bgactivity-strip.is-running .fl-bgactivity-strip-part:first-child { color: var(--fl-color-accent, #4a9eff); }
.fl-bgactivity-strip-failed { color: var(--fl-color-error, #f14c4c); }
`
  document.head.appendChild(style)
}
