/**
 * Full-size image viewer for transcript attachments (#1138).
 *
 * A transcript thumbnail is capped at 220×160 — unreadable for the exact thing
 * the composer's capture button produces, a full-window screenshot. The bytes
 * live under the app's `userData/attachments/`, so the file tree and editor
 * can't reach them either: without this overlay there is NO route to the image
 * a user sent.
 *
 * Deliberately minimal, in the spirit of reveal-menu.ts: one overlay at a time,
 * no chrome beyond a close button, dismissed by Escape / click-outside / the
 * button. It is NOT a general lightbox component — no zoom, pan, or gallery
 * paging — because the job is "let me actually read what I sent".
 *
 * Focus: the overlay takes focus on open (so Escape reaches it without a click)
 * and restores it to the thumbnail on close, so keyboard users land back where
 * they were.
 */

import { markModalOverlay } from '../modal-overlay'

let openViewer: HTMLElement | null = null
let teardown: (() => void) | null = null

/** Close the open viewer, if any, and restore focus to its opener. */
export function closeImageViewer(): void {
  teardown?.()
  teardown = null
  openViewer?.remove()
  openViewer = null
}

export interface ImageViewerOptions {
  /** Image bytes as a data URL — the same value the thumbnail renders. */
  src: string
  /** Accessible name; also the caption under the image. */
  alt: string
  /** Focused again once the viewer closes (the thumbnail that opened it). */
  returnFocusTo?: HTMLElement | null
}

/**
 * Show `src` at full size over the app. Opening a second viewer replaces the
 * first — the overlay is a singleton, so a stray double-click can't stack two.
 */
export function openImageViewer({ src, alt, returnFocusTo }: ImageViewerOptions): void {
  closeImageViewer()

  const overlay = document.createElement('div')
  overlay.className = 'fl-image-viewer'
  overlay.tabIndex = -1
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', alt)
  // While the viewer owns the screen, global panel shortcuts must be inert,
  // the terminal must not steal focus, and Tab must stay inside (#1430).
  markModalOverlay(overlay)
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1200',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:12px',
    'padding:32px',
    'background:rgba(0,0,0,0.72)',
    'cursor:zoom-out',
  ].join(';')

  const img = document.createElement('img')
  img.src = src
  img.alt = alt
  // Fit the viewport in BOTH axes — a tall screenshot must not run off the
  // bottom, which would put the thing back out of reach.
  img.style.cssText = [
    'max-width:100%',
    'max-height:calc(100% - 48px)',
    'object-fit:contain',
    'border-radius:var(--fl-radius-md)',
    'box-shadow:var(--fl-shadow-md)',
    'cursor:default',
  ].join(';')
  // Clicks on the image itself must not dismiss (only the backdrop does).
  img.addEventListener('click', (event) => event.stopPropagation())

  const caption = document.createElement('div')
  caption.className = 'fl-image-viewer-caption'
  caption.textContent = alt
  caption.style.cssText = [
    'color:#fff',
    'font-size:var(--fl-text-ui-size)',
    'opacity:0.85',
    'max-width:100%',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap',
  ].join(';')

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'fl-image-viewer-close'
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Close image')
  close.title = 'Close image (Esc)'
  close.style.cssText = [
    'position:absolute',
    'top:16px',
    'right:16px',
    'width:32px',
    'height:32px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:rgba(0,0,0,0.4)',
    'color:#fff',
    'border:var(--fl-border-width) solid rgba(255,255,255,0.3)',
    'border-radius:var(--fl-radius-sm)',
    'cursor:pointer',
    'font-size:14px',
    'line-height:1',
  ].join(';')
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    closeImageViewer()
  })

  overlay.append(close, img, caption)
  // Backdrop click closes — the cursor already advertises `zoom-out`.
  overlay.addEventListener('click', () => closeImageViewer())

  document.body.appendChild(overlay)
  openViewer = overlay
  overlay.focus()

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // Scoped like the other overlays: this Escape belongs to the viewer, so it
    // must not also reach whatever is behind it (#1161's lesson).
    event.stopPropagation()
    event.preventDefault()
    closeImageViewer()
  }
  document.addEventListener('keydown', onKey, true)

  teardown = () => {
    document.removeEventListener('keydown', onKey, true)
    // Remove the overlay BEFORE restoring focus: while it is attached it is
    // the topmost registered modal, and the document focus trap would pull
    // focus straight back inside it — the thumbnail would never receive it.
    overlay.remove()
    if (returnFocusTo?.isConnected) returnFocusTo.focus()
  }
}
