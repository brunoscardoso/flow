// Release-notes surface (#auto-update, user request 2026-07-22):
//  - BEFORE updating: the titlebar chip offers "What's new" — fetches the
//    pending release's notes so the user can read the changes before accepting.
//  - AFTER updating: on the first launch of a new version (updater:whatsNew
//    reports the change exactly once), the same modal opens automatically with
//    that version's notes.
// Notes come from the public releases repo's GitHub API, fetched in MAIN over
// IPC (the renderer's CSP blocks external connects by design); a fetch failure
// degrades to a "see the release page" line — never an error.

import { renderMarkdown } from '../threads/markdown-renderer'
import { markModalOverlay } from '../modal-overlay'

const STYLE_ID = 'fl-release-notes-style'
const STYLE = `
.fl-relnotes-overlay {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.fl-relnotes-panel {
  display: flex;
  flex-direction: column;
  gap: var(--fl-space-sm, 8px);
  width: min(560px, 92vw);
  max-height: 70vh;
  padding: var(--fl-space-lg, 16px);
  background: var(--fl-color-surface, #1e1e1e);
  border: var(--fl-border-width, 1px) solid var(--fl-color-border, #444);
  border-radius: var(--fl-radius-lg, 10px);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.4);
}
.fl-relnotes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fl-space-sm, 8px);
}
.fl-relnotes-title {
  font: var(--fl-text-ui-weight-medium, 500) var(--fl-text-ui-size, 13px) var(--fl-font-ui, system-ui);
  color: var(--fl-color-text, #eaeaea);
}
.fl-relnotes-close {
  padding: 0 6px;
  color: var(--fl-color-text-secondary, #999);
  background: none;
  border: none;
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--fl-radius-sm, 5px);
}
.fl-relnotes-close:hover { color: var(--fl-color-text, #eaeaea); background: var(--fl-color-surface-raised, #2a2a2a); }
.fl-relnotes-body {
  overflow-y: auto;
  font-size: var(--fl-text-ui-size, 13px);
  color: var(--fl-color-text, #eaeaea);
  line-height: 1.5;
}
.fl-relnotes-body a { color: var(--fl-color-accent, #3b82f6); }
`

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.appendChild(style)
}

/**
 * Fetch a release's markdown body (null on any failure). Routed through MAIN
 * over IPC: the renderer's CSP is connect-src 'self' by design, so a direct
 * fetch to api.github.com was silently blocked and mis-read as "offline".
 */
export async function fetchReleaseNotes(repo: string, version: string): Promise<string | null> {
  try {
    const result = await window.flow.updater.releaseNotes?.({ repo, version })
    return result?.notes ?? null
  } catch {
    return null
  }
}

/** Open the notes modal. `notes` null → a fallback line linking the releases page. */
export function showReleaseNotes(title: string, notes: string | null, repo: string | null): void {
  ensureStyles()
  // One at a time — a re-open replaces the previous modal.
  document.querySelector('.fl-relnotes-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.className = 'fl-relnotes-overlay'
  // #1456: join the registry the three shared guards ask — the shell's shortcut
  // isolation (#525), the terminal's focus guard (#683) and the overlay Tab
  // trap. This surface built the whole modal apparatus (fixed inset:0 backdrop
  // at z-index 9500, backdrop-click dismiss, its own document-level Escape) and
  // then never registered, so `[data-fl-modal]` matched nothing and no guard
  // could see it: ⌘B dropped the sidebar behind it, ⌃` opened a focused
  // terminal behind the backdrop and took the keyboard with it, and Escape then
  // reached the terminal rather than this modal. modal-overlay.ts's own comment
  // already lists release notes among the registered overlays — the invariant's
  // documentation was right and only this call was missing.
  //
  // It matters more here than almost anywhere: this is the surface that opens
  // BY ITSELF on the first launch after every update, when the user has the
  // least context for a shell that has started behaving strangely.
  markModalOverlay(overlay)
  const panel = document.createElement('div')
  panel.className = 'fl-relnotes-panel'
  // The keyboard claim, alongside the assistive-tech one — the pair that
  // modal-overlay.test.ts polices repo-wide.
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', 'Release notes')

  const head = document.createElement('div')
  head.className = 'fl-relnotes-head'
  const heading = document.createElement('div')
  heading.className = 'fl-relnotes-title'
  heading.textContent = title
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'fl-relnotes-close'
  close.textContent = '✕'
  close.setAttribute('aria-label', 'Close release notes')
  head.append(heading, close)

  const body = document.createElement('div')
  body.className = 'fl-relnotes-body'
  if (notes !== null) {
    body.appendChild(renderMarkdown(notes))
  } else {
    const fallback = document.createElement('div')
    fallback.textContent =
      repo !== null
        ? `Couldn't load the notes — see github.com/${repo}/releases for the full changelog.`
        : 'No release notes available.'
    body.appendChild(fallback)
  }

  const dismiss = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKeydown)
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dismiss()
  }
  close.addEventListener('click', dismiss)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss()
  })
  document.addEventListener('keydown', onKeydown)

  panel.append(head, body)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)
}
