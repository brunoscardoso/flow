// Update chip (#auto-update). A compact titlebar chip in the top-right slot
// (`.fl-titlebar-right`), driven entirely by the main process's
// `updater:status` push. Presentation is decided by the pure, unit-tested
// `bannerFor` in shared/updater — this file is just the DOM + the three
// actions (download / install / retry) and a dismiss.
//
// Originally a floating top-center popup; re-housed into the titlebar
// (user request 2026-07-22 — "embed it in the header, top right corner"):
// the whole chip is the click target, with a small ✕ beside it. Falls back
// to a fixed top-right pill when the titlebar slot doesn't exist (tests /
// headless harnesses).
//
// Lifecycle mapping (bannerFor): available → "Update 1.2.3", downloading →
// progress, downloaded → "Restart to update", error → "Retry". idle/checking/
// up-to-date render nothing. Dismiss hides the current chip until the status
// changes.

import { bannerFor, type UpdateAction, type UpdateStatus } from '../../shared/updater'
import { fetchReleaseNotes, showReleaseNotes } from './release-notes'

const ACTION_LABEL: Record<UpdateAction, string> = {
  download: 'Update',
  install: 'Restart to update',
  retry: 'Retry update',
}

const STYLE_ID = 'fl-update-banner-style'
const STYLE = `
.fl-update-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}
/* Fallback (no titlebar slot): anchored to the window's top-right. */
.fl-update-chip-floating {
  position: fixed;
  top: var(--fl-space-sm, 8px);
  right: var(--fl-space-sm, 8px);
  z-index: 9000;
}
.fl-update-chip-action {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  height: 22px;
  font: var(--fl-text-ui-weight-medium, 500) var(--fl-text-caption-size, 11px) var(--fl-font-ui, system-ui);
  color: #fff;
  background: var(--fl-color-accent, #3b82f6);
  border: none;
  border-radius: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.fl-update-chip-action:hover { filter: brightness(1.08); }
.fl-update-chip-action:disabled { cursor: default; filter: saturate(0.6); }
.fl-update-chip-dismiss {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  color: var(--fl-color-text-secondary, #999);
  background: none;
  border: none;
  border-radius: var(--fl-radius-sm, 5px);
  font-size: 11px;
  cursor: pointer;
}
.fl-update-chip-dismiss:hover {
  color: var(--fl-color-text, #eaeaea);
  background: var(--fl-color-surface-raised, #2a2a2a);
}
.fl-update-chip-notes {
  padding: 2px 8px;
  height: 22px;
  font: var(--fl-text-ui-weight, 400) var(--fl-text-caption-size, 11px) var(--fl-font-ui, system-ui);
  color: var(--fl-color-text-secondary, #999);
  background: none;
  border: var(--fl-border-width, 1px) solid var(--fl-color-border, #444);
  border-radius: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.fl-update-chip-notes:hover { color: var(--fl-color-text, #eaeaea); }
`

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.appendChild(style)
}

/** A stable key for "this is the same chip I already dismissed". */
function statusKey(status: UpdateStatus): string {
  return `${status.phase}:${status.version ?? ''}`
}

/** The chip's action label — the version rides IN the button so the whole
 *  affordance is one obvious click target ("Update 1.2.3"). */
function actionLabel(action: UpdateAction, status: UpdateStatus): string {
  if (action === 'download' && status.version) return `Update ${status.version}`
  return ACTION_LABEL[action]
}

export function initUpdateBanner(root: HTMLElement = document.body): void {
  const api = window.flow?.updater
  if (!api) return

  ensureStyles()
  const el = document.createElement('div')
  el.className = 'fl-update-chip'
  el.hidden = true
  el.setAttribute('role', 'status')

  const actionBtn = document.createElement('button')
  actionBtn.className = 'fl-update-chip-action'
  actionBtn.type = 'button'

  // "What's new" beside the action — read the changes BEFORE accepting.
  const notesBtn = document.createElement('button')
  notesBtn.className = 'fl-update-chip-notes'
  notesBtn.type = 'button'
  notesBtn.textContent = "What's new"
  notesBtn.hidden = true

  const dismissBtn = document.createElement('button')
  dismissBtn.className = 'fl-update-chip-dismiss'
  dismissBtn.type = 'button'
  dismissBtn.textContent = '✕'
  dismissBtn.title = 'Dismiss'
  dismissBtn.setAttribute('aria-label', 'Dismiss update notice')

  el.append(notesBtn, actionBtn, dismissBtn)
  // Prefer the titlebar's right slot; fall back to a fixed top-right pill.
  const slot = document.querySelector<HTMLElement>('.fl-titlebar-right')
  if (slot) {
    // PREPEND, not append: the settings gear already sits in this slot and is
    // the window's top-right corner. Appending put the chip outside it, which
    // shifted the gear left the moment an update appeared — furniture that
    // moves when news arrives is furniture you stop aiming at.
    slot.insertBefore(el, slot.firstChild)
  } else {
    el.classList.add('fl-update-chip-floating')
    root.appendChild(el)
  }

  let dismissedKey: string | null = null
  // Public releases repo ("owner/name") for note fetches — resolved by the
  // whatsNew boot call below; null in dev.
  let releasesRepo: string | null = null

  const openNotes = (version: string, title: string): void => {
    if (releasesRepo === null) {
      showReleaseNotes(title, null, null)
      return
    }
    const repo = releasesRepo
    void fetchReleaseNotes(repo, version).then((notes) => showReleaseNotes(title, notes, repo))
  }

  const runAction = (action: UpdateAction): void => {
    // download / retry return promises; install quits the app. Fire-and-forget
    // with a console fallback — errors also surface via the next status push.
    const call =
      action === 'install'
        ? api.install()
        : action === 'download'
          ? api.download()
          : api.check()
    void Promise.resolve(call).catch((error) => console.error('flow: update action failed', error))
  }

  const render = (status: UpdateStatus): void => {
    const banner = bannerFor(status)
    const key = statusKey(status)
    if (!banner || dismissedKey === key) {
      el.hidden = true
      return
    }
    if (banner.action) {
      actionBtn.disabled = false
      actionBtn.textContent = actionLabel(banner.action, status)
      actionBtn.title = banner.text
      actionBtn.onclick = () => runAction(banner.action as UpdateAction)
      // Pre-accept notes only make sense while the update is still pending.
      const showNotes = banner.action === 'download' && typeof status.version === 'string'
      notesBtn.hidden = !showNotes
      notesBtn.onclick = showNotes
        ? () => openNotes(status.version as string, `What's new in Flow ${status.version}`)
        : null
    } else {
      // No action (downloading) — the chip itself reports progress.
      actionBtn.disabled = true
      actionBtn.textContent = banner.text
      actionBtn.title = banner.text
      actionBtn.onclick = null
      notesBtn.hidden = true
    }
    dismissBtn.hidden = !banner.dismissible
    dismissBtn.onclick = () => {
      dismissedKey = key
      el.hidden = true
    }
    el.hidden = false
  }

  api.onStatus(render)

  // Post-update "What's new" (user request 2026-07-22): on the first launch of
  // a new version, open that version's notes automatically — exactly once (the
  // main process stamps the version on report).
  void api
    .whatsNew()
    .then((result) => {
      releasesRepo = result.repo
      if (result.changedTo === null) return
      const version = result.changedTo
      if (result.repo === null) {
        showReleaseNotes(`Flow updated to ${version}`, null, null)
        return
      }
      const repo = result.repo
      void fetchReleaseNotes(repo, version).then((notes) =>
        showReleaseNotes(`What's new in Flow ${version}`, notes, repo),
      )
    })
    .catch(() => undefined)
}
