/**
 * A MENU THAT OPENS ON THE THING IT IS ABOUT — the lifecycle, once.
 *
 * The branch rename wrote this out (now `branch-rename-popover.ts`, opened from
 * the Changes toolbar rather than the header it started on),
 * and it got four things right that are easy to get wrong and invisible when
 * they are wrong. Phase 4 needs the same shell twice more — the composer's
 * branch chip and the carry question — so the shell moved here rather than
 * being typed a third and fourth time.
 *
 * THE FOUR THINGS:
 *
 *  1. It settles exactly once and always removes itself. A popover that can
 *     resolve twice is a promise that lies; one that can be left behind is a
 *     live field floating over whatever took its place.
 *  2. It is marked modal even though it takes none of the screen. While a text
 *     field inside it holds the caret, the terminal must not take the caret
 *     back and a panel shortcut must not run (#525, #683, #1002).
 *  3. Its Escape is stopped at the capture phase. Further down, a panel
 *     shortcut would close the whole conversation surface instead, and
 *     abandoning a menu is not a reason to lose the thing it was opened from.
 *  4. It watches a HOST that outlives redraws, not the anchor. The anchor is an
 *     element its owner rebuilds whenever the label changes, and a `threads:
 *     updated` batch arrives every 50ms while an agent is talking — watching
 *     the anchor closes the menu a few milliseconds after it opens, for as long
 *     as the agent is streaming (#1400's lesson, learned once).
 *
 * WHAT IT IS NOT. It has no backdrop, no centring and no title bar: changing
 * one setting should not look like the same event as being asked a question.
 * It also decides nothing about its contents — the caller fills `panel` and
 * owns every word in it.
 */

import { markModalOverlay } from '../modal-overlay'

export interface AnchoredPopoverOptions {
  /** The element the menu opens on. Its rectangle decides where. */
  anchor: HTMLElement
  /**
   * The element whose disappearance closes the menu. Defaults to the anchor —
   * pass the anchor's stable HOST whenever the anchor itself gets rebuilt.
   */
  watch?: HTMLElement
  /** The panel's styling class. The overlay gets the same name plus '-overlay'. */
  className: string
  /** What a screen reader calls it. */
  ariaLabel: string
  /** Called exactly once, whichever way the menu went. */
  onClose: () => void
}

export interface AnchoredPopover {
  /** Fill this. It is empty and positioned; everything inside it is yours. */
  readonly panel: HTMLElement
  /** Close it. Safe to call more than once; the second call does nothing. */
  close(): void
  /** Re-measure and re-place, after the panel's contents changed height. */
  reposition(): void
}

export function openAnchoredPopover(options: AnchoredPopoverOptions): AnchoredPopover {
  const overlay = document.createElement('div')
  overlay.className = `${options.className}-overlay`
  markModalOverlay(overlay)

  const panel = document.createElement('div')
  panel.className = options.className
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', options.ariaLabel)
  // Focusable without being a tab stop: the menu takes the caret on open so a
  // keyboard reader lands inside it, and Escape reaches the capture handler.
  panel.tabIndex = -1

  const watched = options.watch ?? options.anchor

  let settled = false
  let outsideTimer = 0
  const close = (): void => {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', onKey, true)
    window.clearTimeout(outsideTimer)
    document.removeEventListener('mousedown', onOutside)
    watcher.disconnect()
    overlay.remove()
    options.onClose()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close()
  }
  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node
    // THE ANCHOR IS NOT "OUTSIDE". A control that opens a menu is a control
    // that should close it again on the second press, and treating its own
    // click as a dismissal makes that impossible: the menu would close on
    // mousedown and the click handler would immediately reopen it, so the
    // toggle would look broken in exactly the way nobody can reproduce.
    if (panel.contains(target) || options.anchor.contains(target)) return
    close()
  }
  const watcher = new MutationObserver(() => {
    if (!watched.isConnected) close()
  })

  const reposition = (): void => {
    place(panel, options.anchor)
  }

  // POSITIONING IS THE SHELL'S JOB, NOT THE CALLER'S STYLESHEET.
  //
  // `place()` writes `left`/`top`, which do nothing at all on a statically
  // positioned element — so a caller whose `className` had no CSS behind it got
  // a menu appended to the end of <body>, below a full-height shell, off the
  // bottom of the window. On screen that is indistinguishable from a control
  // that does nothing, and it is exactly what the worktree panel did for a day:
  // it asked for `fl-anchored-menu`, every other caller asks for `fl-fmenu`,
  // and only the second one is a class this file defines (user, 2026-09-17:
  // "STILL NOT THERE"). Set here, the positioning cannot be lost by naming a
  // class nobody wrote — the class is left to decide how the menu LOOKS.
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.zIndex = '1000'
  panel.style.position = 'fixed'

  overlay.appendChild(panel)
  document.body.appendChild(overlay)
  reposition()
  watcher.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('keydown', onKey, true)
  // Deferred, or the very click that opened the menu closes it again.
  // A DISMISS CLOSED BEFORE THIS TIMER FIRES MUST NOT LEAVE ITS LISTENER BEHIND.
  // The add is deferred so the opening click cannot close the menu; the teardown
  // only ever removed a listener, so closing inside that one tick (Escape right
  // after opening, which is what a poll of this menu does) let the timer attach
  // `onOutside` for a panel that was already gone. Nothing could remove it, and
  // its closure tests a DETACHED element — so `!contains(target)` was true for
  // every later press, and the NEXT menu was dismissed on mousedown before the
  // click reached the item. Measured: the item's handler never ran, no write
  // happened, and the menu closed anyway.
  outsideTimer = window.setTimeout(() => document.addEventListener('mousedown', onOutside), 0)

  return { panel, close, reposition }
}

/**
 * Put the panel under its anchor, inside the window.
 *
 * Left-aligned to the anchor rather than right-aligned like a row menu: these
 * open from controls that sit at the start of a line, so the menu grows the way
 * the line reads. Flipped above only when there is genuinely no room below.
 */
function place(panel: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const margin = 8
  const width = panel.offsetWidth
  let left = rect.left
  if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin
  if (left < margin) left = margin
  let top = rect.bottom + 4
  if (top + panel.offsetHeight + margin > window.innerHeight) {
    top = Math.max(margin, rect.top - panel.offsetHeight - 4)
  }
  panel.style.left = `${String(Math.round(left))}px`
  panel.style.top = `${String(Math.round(top))}px`
}

// ── Styles ─────────────────────────────────────────────────────────────────

let stylesInjected = false

/**
 * The look of an anchored menu, injected once and shared by everything that
 * opens one.
 *
 * ONE STYLESHEET FOR ONE KIND OF SURFACE. Two menus that open the same way and
 * mean the same thing must not drift apart because they were styled in
 * different files; the chip's menu and the carry question are the same object
 * at two moments, and they look it.
 *
 * Existing tokens only — no new design language (a plan constraint). The CSS is
 * an array of lines rather than a template literal because a backtick inside
 * one breaks this repo's build with a misleading parse error.
 */
export function injectAnchoredMenuStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    /* The overlay takes no screen: it only catches the click that dismisses
       the menu, so what is behind stays readable and stays lit. */
    '.fl-fmenu-overlay { position: fixed; inset: 0; z-index: 1000; }',
    '.fl-fmenu {',
    '  position: fixed;',
    '  width: min(340px, calc(100vw - var(--fl-space-xl)));',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: var(--fl-space-xs);',
    '  padding: var(--fl-space-md);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-md);',
    '  background: var(--fl-color-surface);',
    '  box-shadow: var(--fl-shadow-md);',
    '  font-family: var(--fl-font-ui);',
    '  color: var(--fl-color-text);',
    '  max-height: 70vh;',
    '  overflow-y: auto;',
    '}',
    /* The worktree panel brings its own width, padding and inner rules; what
       it needs from the menu shell is the surface it floats on. */
    '.fl-anchored-menu {',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-md);',
    '  background: var(--fl-color-surface);',
    '  box-shadow: var(--fl-shadow-md);',
    '  font-family: var(--fl-font-ui);',
    '  color: var(--fl-color-text);',
    '}',
    '.fl-anchored-menu:focus { outline: none; }',
    '.fl-fmenu:focus { outline: none; }',
    '.fl-fmenu-title {',
    '  font-size: var(--fl-text-ui-size);',
    '  font-weight: var(--fl-text-ui-weight-medium);',
    '}',
    '.fl-fmenu-body {',
    '  margin: 0;',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '  color: var(--fl-color-text-secondary);',
    '}',
    '.fl-fmenu-body[hidden] { display: none; }',
    '.fl-fmenu-item {',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 2px;',
    '  width: 100%;',
    '  min-width: 0;',
    '  padding: var(--fl-space-xs) var(--fl-space-sm);',
    '  text-align: left;',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  background: var(--fl-color-surface-raised);',
    '  color: inherit;',
    '  font: inherit;',
    '  cursor: pointer;',
    '}',
    '.fl-fmenu-item:hover { border-color: var(--fl-color-accent); }',
    '.fl-fmenu-item:focus-visible {',
    '  outline: 2px solid var(--fl-color-focus-ring);',
    '  outline-offset: 1px;',
    '}',
    /* The chosen rung is lit, the same accent the header chip uses for the
       branch a conversation owns. */
    '.fl-fmenu-item.is-on {',
    '  border-color: var(--fl-color-accent-muted);',
    '  background: var(--fl-color-accent-muted);',
    '}',
    '.fl-fmenu-item-head { display: flex; align-items: baseline; gap: var(--fl-space-xs); min-width: 0; }',
    '.fl-fmenu-item-label {',
    '  flex: none;',
    '  font-size: var(--fl-text-ui-size);',
    '  font-weight: var(--fl-text-ui-weight-medium);',
    '}',
    /* A name, so it shortens; the role word beside it stays whole. */
    '.fl-fmenu-item-branch {',
    '  min-width: 0;',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '  white-space: nowrap;',
    '  font-family: var(--fl-font-mono);',
    '  font-size: var(--fl-text-caption-size);',
    '  color: var(--fl-color-text-secondary);',
    '}',
    '.fl-fmenu-item-detail {',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '  color: var(--fl-color-text-secondary);',
    '}',
    '.fl-fmenu-row { display: flex; gap: var(--fl-space-xs); align-items: center; }',
    '.fl-fmenu-input {',
    '  flex: 1;',
    '  min-width: 0;',
    '  padding: var(--fl-space-xs) var(--fl-space-sm);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  background: var(--fl-color-surface-raised);',
    '  color: var(--fl-color-text);',
    '  font-family: var(--fl-font-mono);',
    '  font-size: var(--fl-text-ui-size);',
    '}',
    '.fl-fmenu-input:focus-visible {',
    '  outline: 2px solid var(--fl-color-focus-ring);',
    '  outline-offset: 1px;',
    '}',
    /* The refusal sits under the field the reader is still looking at. */
    '.fl-fmenu-problem {',
    '  margin: 0;',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '  color: var(--fl-color-error);',
    '}',
    '.fl-fmenu-problem[hidden] { display: none; }',
    '.fl-fmenu-back {',
    '  align-self: flex-start;',
    '  padding: 0;',
    '  border: none;',
    '  background: none;',
    '  color: var(--fl-color-text-secondary);',
    '  font-family: var(--fl-font-ui);',
    '  font-size: var(--fl-text-caption-size);',
    '  cursor: pointer;',
    '}',
    '.fl-fmenu-back:hover { color: var(--fl-color-text); }',
  ].join('\n')
  document.head.appendChild(style)
}
