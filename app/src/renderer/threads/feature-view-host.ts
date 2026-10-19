/**
 * The feature view's host — where a DISCOVERY card's "Open artifact" press
 * becomes an editor tab.
 *
 * WHAT PEOPLE WILL SEE. The feature view is the user's perspective on a
 * discovery: its user walkthrough page — a whole agent-authored HTML page
 * (pitch, capabilities, a stepped user flow with a mockup of each screen)
 * written beside the markdown as `<doc>.walkthrough.html`. This tab frames that
 * page under a slim header. Its "Open discovery view" button, which crossed to
 * the board's technical picture, was retired with that view (2026-10-08).
 *
 * THE PAGE NEVER RUNS IN FLOW'S ORIGIN. It is framed from main's `flow-page`
 * scheme (see `shared/walkthrough-page.ts`), whose response carries its own CSP
 * — inline script and style, nothing on the network — inside an iframe
 * sandboxed to `allow-scripts` only. Without `allow-same-origin` the page is an
 * opaque origin: its navigation script runs, and `parent.document` is refused.
 *
 * Same shape as the board, the blueprint and the Changes tab: the thread pane
 * never imports the editor, it dispatches `flow:open-feature-view`, and this
 * host (initialised beside the other editor-area surfaces in `main.ts`) opens
 * the tab. ONE view per project, slug and VERSION — a second press on the same
 * version focuses its tab, and two versions open as two tabs to compare.
 *
 * A VIEW BELONGS TO ITS CONVERSATION. Each thread keeps its own tabs: a feature
 * view opened while a thread is selected is part of that thread's tab set
 * (`persist` below), closed when the thread is switched away from and rebuilt
 * by the restorer registered here when it is switched back to — across restarts
 * too. One with no thread selected belongs to the project's own set.
 *
 * PAY ONLY FOR WHAT SOMEONE CAN SEE (allowed-pattern #17). A page change
 * reloads only a view that is on screen; an open-but-hidden one is marked stale
 * and catches up when it is next drawn. A markdown-only edit reloads nothing.
 * The rules live in `feature-view-refresh.ts`.
 *
 * SHARING SITS BESIDE THE DOOR, AND NEVER IN FRONT OF THE PAGE. The header's
 * Share button publishes this view to planflow.sh as a private page; once
 * shared, a strip under the header says with whom and offers Copy link, Manage,
 * Revoke and who has opened it. What the button says comes from main's answer
 * to `share:get` — never from reading who is signed in — and signed out it
 * reads "Sign in to share" and starts the existing sign-in. The page itself is
 * framed exactly the same either way. Main is asked for the view's share state
 * when a view opens, when its page changes, when its project changes and after
 * a sign-in — only for a view on screen, never on a timer (allowed-pattern
 * #17) — and main asks planflow.sh ONLY about a discovery this computer
 * recorded as shared (review R2-M7). A share made elsewhere appears after the
 * author presses "Check sharing status" in the Share dialog. The rules live
 * in `share-state-model.ts` and `share-dialog-model.ts`.
 */
import type {
  FlowArtifactChangedEvent,
  FlowShareApi,
  ShareLocalFacts,
  ShareSummaryResult,
} from '../../shared/ipc-contract'
import type { ShareSummary } from '../../shared/share-contract'
import { docPathForWalkthrough, walkthroughPageUrl, type WalkthroughTheme } from '../../shared/walkthrough-page'
import type { EditorApi } from '../editor'
import { TAB_SCOPE_EVENT, type TabScopeKey } from '../tab-scope-model'
import { runInWantedScope } from '../tab-scope-gate'
import {
  decideFeatureViewRefresh,
  featureViewPageChange,
  featureViewTabId,
  featureViewTabLabel,
  featureViewsToClose,
  type FeatureViewPageState,
} from './feature-view-refresh'
import { confirmRevoke, openShareDialog, type ShareCheckOutcome, type ShareDialogOutcome } from './share-dialog'
import { buildPublishRequest, buildUpdateRequest, reviewedFiles } from './share-dialog-model'
import {
  SHARE_CHECK_NONE_TEXT,
  SHARE_COPIED_LABEL,
  SHARE_COPY_FAILED_TEXT,
  SHARE_COPY_LABEL,
  SHARE_MANAGE_LABEL,
  SHARE_NO_ANSWER_TEXT,
  SHARE_REVOKE_LABEL,
  SHARE_UNSUPPORTED_TEXT,
  SIGN_IN_FAILED_TEXT,
  SIGNING_IN_HINT,
  UPDATE_BUSY_LABEL,
  UPDATE_CONFIRM_LABEL,
  UPDATE_DISMISS_LABEL,
  VIEWERS_EMPTY_TEXT,
  VIEWERS_LABEL,
  VIEWERS_LOADING_TEXT,
  createRequestSequence,
  dialogAfterSignIn,
  invitesSkippedText,
  isSignInRefusal,
  liveShare,
  shareButtonFor,
  shareStateFrom,
  shareStripFor,
  stepAfterRefusal,
  updatePromptFor,
  viewerRows,
  withDismissed,
  withRevoked,
  withShare,
  type RequestSequence,
  type ShareState,
} from './share-state-model'

/** The header kicker every artifact view carries (the walkthrough page is
 *  called the artifact in the app, 2026-10-08). */
export const FEATURE_VIEW_KICKER = 'ARTIFACT'

/** Said when the page the tab framed has been removed. */
export const WALKTHROUGH_REMOVED_TEXT = 'This discovery no longer has an artifact.'

/** Said when there is no project to show the page from. */
export const FEATURE_VIEW_NO_PROJECT_TEXT = 'Open the project this discovery belongs to, to see its artifact.'

/** What a card's press carries — see `#onArtifactOpenFeatureView`. */
interface OpenFeatureViewDetail {
  rootPath: string | null
  /** The walkthrough page's repo-relative path. */
  path: string
  slug: string
  title: string
}

/** The persisted identity of a feature view in a tab set. */
const FEATURE_VIEW_KIND = 'feature-view'

/** One open (or once-opened) feature view and what it frames. */
interface HostedFeatureView {
  element: HTMLElement
  titleEl: HTMLElement
  frame: HTMLIFrameElement
  empty: HTMLElement
  rootPath: string | null
  /** The conversation whose tab set this view is in (null: the project's). */
  threadId: string | null
  /** The walkthrough page's repo-relative path. */
  path: string
  /** The discovery doc the page belongs to — what the watcher's events name. */
  docPath: string | null
  slug: string
  page: FeatureViewPageState
  /** The page changed while the view was not on screen. */
  stale: boolean
  /** Bumped per load: the frame's cache-buster, so a reload is a new address. */
  loads: number
  share: HostedShare
}

/** The share half of a feature view: its controls and what main last said. */
interface HostedShare {
  button: HTMLButtonElement
  strip: HTMLElement
  /** Which share: its title and project label. */
  subject: HTMLElement
  summary: HTMLElement
  link: HTMLElement
  expiry: HTMLElement
  copy: HTMLButtonElement
  manage: HTMLButtonElement
  revoke: HTMLButtonElement
  viewersToggle: HTMLButtonElement
  viewers: HTMLElement
  prompt: HTMLElement
  promptTitle: HTMLElement
  /** Which share an update goes to: title, project and audience. */
  promptTarget: HTMLElement
  promptDetail: HTMLElement
  update: HTMLButtonElement
  notNow: HTMLButtonElement
  /** One plain sentence under the header — a sign-in or a refusal — or hidden. */
  note: HTMLElement
  state: ShareState
  /** Versions answered "Not now", for this run only. */
  dismissed: ReadonlySet<string>
  /** Only the newest `share:get` answer may be drawn. */
  sequence: RequestSequence
  signingIn: boolean
  /**
   * The person pressed "Sign in to share" and the sign-in succeeded: once main
   * answers this view's share state again, reopen the dialog they were heading
   * for (`dialogAfterSignIn`). Consumed by that answer, whatever it is.
   */
  resumeAfterSignIn: boolean
  updating: boolean
  viewersOpen: boolean
  /** Something changed while the view was off screen: ask again when it returns. */
  stale: boolean
}

/** How long "Copied" stands in for "Copy link" before it goes back. */
const COPIED_FEEDBACK_MS = 1500

/** The share bridge, or null when this window's preload predates it. */
function shareApi(): FlowShareApi | null {
  return window.flow?.share ?? null
}

/**
 * The tab's icon. The set has no screen or mockup glyph; `file` is the honest
 * one — the view is one page, written beside one discovery document.
 */
const FEATURE_VIEW_ICON = 'file'

/**
 * The theme Flow is showing right now. The shell stamps `data-theme="light"` on
 * <html> for the light theme; the base is dark. Passed with the page so the
 * walkthrough matches the app it is framed in.
 */
function flowTheme(): WalkthroughTheme {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

export function initFeatureViewHost(editorApi: EditorApi): void {
  injectFeatureViewStyles()
  const hosted = new Map<string, HostedFeatureView>()
  /** The tab set on screen — whose conversation a press opens a view into. */
  let scope: TabScopeKey | null = null

  /** Whether the view is actually drawn right now: in the document, not hidden
   *  by the editor (a hidden view or a hidden editor has no offsetParent), and
   *  the window itself visible. */
  function isOnScreen(entry: HostedFeatureView): boolean {
    return (
      entry.element.isConnected &&
      entry.element.offsetParent !== null &&
      document.visibilityState === 'visible'
    )
  }

  /** Show the page, or the sentence that stands in for it. */
  function showPage(entry: HostedFeatureView): void {
    entry.stale = false
    if (entry.rootPath === null || !entry.page.present) {
      entry.frame.hidden = true
      entry.frame.removeAttribute('src')
      entry.empty.textContent = entry.rootPath === null ? FEATURE_VIEW_NO_PROJECT_TEXT : WALKTHROUGH_REMOVED_TEXT
      entry.empty.hidden = false
      if (entry.rootPath === null) {
        console.warn('flow: feature view has no project to frame its page from', { path: entry.path })
      }
      return
    }
    entry.loads += 1
    entry.empty.hidden = true
    entry.frame.hidden = false
    entry.frame.src = walkthroughPageUrl(entry.rootPath, entry.path, entry.page.mtime ?? entry.loads, flowTheme())
  }

  /** Catch a stale view up the moment it is drawn again — tab switch, editor
   *  revealed, or the window coming back. */
  function showIfStale(entry: HostedFeatureView): void {
    if (!isOnScreen(entry)) return
    if (entry.stale) showPage(entry)
    if (entry.share.stale) void askShare(entry)
  }

  // ── Sharing ───────────────────────────────────────────────────────────────

  /** The discovery this view would share, or null when it has no project. */
  function docRef(entry: HostedFeatureView): { rootPath: string; docPath: string } | null {
    if (entry.rootPath === null || entry.docPath === null) return null
    return { rootPath: entry.rootPath, docPath: entry.docPath }
  }

  /** Ask main what this view's share is now, and draw the answer. */
  async function askShare(entry: HostedFeatureView): Promise<void> {
    const share = entry.share
    share.stale = false
    const doc = docRef(entry)
    if (doc === null) {
      share.state = { kind: 'no-project' }
      drawShare(entry)
      return
    }
    const api = shareApi()
    if (api === null) {
      share.state = { kind: 'refused', reason: 'sharing-unavailable', message: SHARE_UNSUPPORTED_TEXT }
      drawShare(entry)
      return
    }
    const ticket = share.sequence.next()
    // Keep what is known on screen while asking again; only a first ask shows
    // the checking state.
    if (share.state.kind === 'idle') {
      share.state = { kind: 'loading' }
      drawShare(entry)
    }
    let next: ShareState
    try {
      next = shareStateFrom(await api.get(doc))
    } catch (error) {
      console.warn('flow: share state could not be read', { slug: entry.slug, error })
      next = { kind: 'refused', reason: 'unreachable', message: SHARE_NO_ANSWER_TEXT }
    }
    if (!share.sequence.isCurrent(ticket)) return
    share.state = next
    drawShare(entry)
    resumeAfterSignIn(entry)
  }

  /**
   * After a sign-in started from this view's Share button: open the dialog the
   * person was heading for. A dialog, never a publish — they still press
   * Share inside it.
   */
  function resumeAfterSignIn(entry: HostedFeatureView): void {
    const share = entry.share
    if (!share.resumeAfterSignIn) return
    share.resumeAfterSignIn = false
    const dialog = dialogAfterSignIn(true, share.state)
    if (dialog === 'publish') publish(entry)
    else if (dialog === 'manage') {
      const live = liveShare(share.state)
      if (live !== null) manage(entry, live)
    }
  }

  /** Ask now when the view is on screen; otherwise when it next is. */
  function askShareWhenSeen(entry: HostedFeatureView): void {
    if (isOnScreen(entry)) void askShare(entry)
    else entry.share.stale = true
  }

  /** One sentence under the header, or none. */
  function note(entry: HostedFeatureView, text: string | null): void {
    entry.share.note.textContent = text ?? ''
    entry.share.note.hidden = text === null
  }

  /** Draw the button, the shared strip and the update question from the state. */
  function drawShare(entry: HostedFeatureView): void {
    const share = entry.share
    const button = shareButtonFor(share.state, share.signingIn)
    share.button.textContent = button.label
    share.button.title = button.title
    share.button.disabled = button.disabled
    share.button.dataset['action'] = button.action

    const strip = shareStripFor(share.state, Date.now())
    share.strip.hidden = strip === null
    if (strip === null) {
      share.viewersOpen = false
    } else {
      share.subject.textContent = strip.subject
      share.subject.title = strip.subject
      share.summary.textContent = strip.summary
      share.link.textContent = strip.url
      share.link.title = strip.url
      share.expiry.textContent = strip.expiry ?? ''
      share.expiry.hidden = strip.expiry === null
    }
    share.viewers.hidden = !share.viewersOpen
    share.viewersToggle.setAttribute('aria-expanded', String(share.viewersOpen))

    const prompt = updatePromptFor(share.state, share.dismissed)
    share.prompt.hidden = prompt === null
    if (prompt !== null) {
      share.promptTitle.textContent = prompt.title
      share.promptTarget.textContent = prompt.target
      share.promptDetail.textContent = prompt.detail
    }
    share.update.disabled = share.updating
    share.update.textContent = share.updating ? UPDATE_BUSY_LABEL : UPDATE_CONFIRM_LABEL
  }

  /** A publish, update or revoke answered: keep the new summary, or say why not. */
  function applySummary(entry: HostedFeatureView, result: ShareSummaryResult): string | null {
    if (result.ok) {
      entry.share.state = withShare(entry.share.state, result.share)
      drawShare(entry)
      // Some people asked for were not emailed (sending limits): say so, so the
      // author can send them the link themselves (review R2-L5).
      const skipped = invitesSkippedText(result.invitesSkipped)
      if (skipped !== null) note(entry, skipped)
      return null
    }
    if (isSignInRefusal(result.reason)) {
      entry.share.state = { kind: 'signed-out', message: result.message }
      drawShare(entry)
    }
    return result.message
  }

  /** Re-read the local facts after main said the files changed since review. */
  async function freshLocal(entry: HostedFeatureView): Promise<ShareLocalFacts | undefined> {
    await askShare(entry)
    return entry.share.state.kind === 'ready' ? entry.share.state.local : undefined
  }

  function signIn(entry: HostedFeatureView): void {
    const settings = window.flow?.settings
    if (settings === undefined || typeof settings.signIn !== 'function') {
      note(entry, SHARE_UNSUPPORTED_TEXT)
      return
    }
    entry.share.signingIn = true
    drawShare(entry)
    note(entry, SIGNING_IN_HINT)
    const finish = (text: string | null, signedIn: boolean): void => {
      entry.share.signingIn = false
      // The press was a Share press: pick up where the person was once main
      // has answered this view again (never an automatic publish).
      entry.share.resumeAfterSignIn = signedIn
      note(entry, text)
      // Every view's answer may have changed, not only this one's. This view
      // is asked directly: it is on screen, its button was just pressed.
      void askShare(entry)
      for (const other of hosted.values()) if (other !== entry) askShareWhenSeen(other)
    }
    void settings
      .signIn()
      .then((result) => finish(result.ok ? null : result.reason, result.ok))
      .catch((error: unknown) => {
        console.warn('flow: sign-in from the feature view did not complete', { error })
        finish(SIGN_IN_FAILED_TEXT, false)
      })
  }

  function publish(entry: HostedFeatureView): void {
    const api = shareApi()
    const doc = docRef(entry)
    const state = entry.share.state
    if (api === null || doc === null || state.kind !== 'ready') return
    let local = state.local
    let reopen = false
    void openShareDialog({
      mode: 'publish',
      share: state.share,
      local,
      checkStatus: async (): Promise<ShareCheckOutcome> => {
        const found = await checkSharing(entry)
        if (found.kind === 'message') return { close: false, message: found.message }
        // Found a share: this dialog was about publishing a new one, so it
        // closes. A revoked share reopens as the re-share dialog, list filled in.
        reopen = found.kind === 'revoked'
        return { close: true }
      },
      submit: async (form): Promise<ShareDialogOutcome> => {
        const built = buildPublishRequest(doc, local, form, Date.now())
        if (!built.ok) return { ok: false, message: built.message }
        const result = await api.publish(built.request)
        const refused = applySummary(entry, result)
        if (refused === null) return { ok: true }
        if (!result.ok && result.reason === 'changed-since-review') {
          const fresh = await freshLocal(entry)
          if (fresh !== undefined) {
            local = fresh
            return { ok: false, message: refused, local: fresh }
          }
        }
        return { ok: false, message: refused }
      },
    }).then(() => {
      if (reopen) publish(entry)
    })
  }

  /**
   * "Check sharing status" was pressed: ask main to ask the share host about
   * this discovery, record what it finds, and draw it. The ONLY path that asks
   * about a discovery this computer never shared (review R2-M7).
   */
  async function checkSharing(
    entry: HostedFeatureView,
  ): Promise<{ kind: 'live' | 'revoked' } | { kind: 'message'; message: string }> {
    const api = shareApi()
    const doc = docRef(entry)
    if (api === null || typeof api.check !== 'function' || doc === null) {
      return { kind: 'message', message: SHARE_UNSUPPORTED_TEXT }
    }
    const ticket = entry.share.sequence.next()
    let next: ShareState
    try {
      next = shareStateFrom(await api.check(doc))
    } catch (error) {
      console.warn('flow: share status could not be checked', { slug: entry.slug, error })
      return { kind: 'message', message: SHARE_NO_ANSWER_TEXT }
    }
    if (next.kind !== 'ready') {
      if (next.kind === 'signed-out' && entry.share.sequence.isCurrent(ticket)) {
        entry.share.state = next
        drawShare(entry)
      }
      const said = next.kind === 'signed-out' || next.kind === 'refused' ? next.message : null
      return { kind: 'message', message: said ?? SHARE_NO_ANSWER_TEXT }
    }
    if (entry.share.sequence.isCurrent(ticket)) {
      entry.share.state = next
      drawShare(entry)
    }
    if (next.share === null) return { kind: 'message', message: SHARE_CHECK_NONE_TEXT }
    return { kind: next.share.revokedAt === null ? 'live' : 'revoked' }
  }

  function manage(entry: HostedFeatureView, share: ShareSummary): void {
    const api = shareApi()
    if (api === null) return
    let reshareNeeded = false
    void openShareDialog({
      mode: 'manage',
      share,
      local: null,
      submit: async (form): Promise<ShareDialogOutcome> => {
        const built = buildUpdateRequest(share.id, form, Date.now())
        if (!built.ok) return { ok: false, message: built.message }
        const result = await api.update(built.request)
        const refused = applySummary(entry, result)
        if (refused === null) return { ok: true }
        if (!result.ok && stepAfterRefusal(result.reason) === 'reshare') {
          // Revoked elsewhere: this dialog's change is not retried. It closes,
          // and the re-share dialog — which asks who it is for — opens instead.
          reshareNeeded = true
          return { ok: true }
        }
        return { ok: false, message: refused }
      },
    }).then(() => {
      if (reshareNeeded) reshareRevoked(entry)
    })
  }

  /**
   * The server said this share is revoked (another window revoked it). Mark it
   * so here, and open the RE-SHARE dialog: it sends the list explicitly, with
   * "Email them" off. Never a silent retry of the update (review H4).
   */
  function reshareRevoked(entry: HostedFeatureView): void {
    entry.share.state = withRevoked(entry.share.state, new Date().toISOString())
    drawShare(entry)
    publish(entry)
  }

  function revoke(entry: HostedFeatureView, share: ShareSummary): void {
    const api = shareApi()
    if (api === null) return
    // `confirmed: true` is sent only from inside the confirmation a person
    // answered — revoking is never anybody's default (forbidden-pattern #15).
    void confirmRevoke(async () => applySummary(entry, await api.revoke({ id: share.id, confirmed: true })))
  }

  /** Republish what is on disk now to the same link — only on the author's press. */
  async function updateShared(entry: HostedFeatureView): Promise<void> {
    const api = shareApi()
    const doc = docRef(entry)
    const state = entry.share.state
    if (api === null || doc === null || state.kind !== 'ready' || entry.share.updating) return
    entry.share.updating = true
    drawShare(entry)
    note(entry, null)
    let refused: string | null
    let changed = false
    let revoked = false
    try {
      // No `access`, no `expiresAt`: a later publish keeps the list and the
      // expiry as they are. Nobody new is emailed by an update.
      const result = await api.publish({ ...doc, reviewed: reviewedFiles(state.local), notify: false })
      refused = applySummary(entry, result)
      const step = result.ok ? 'show' : stepAfterRefusal(result.reason)
      changed = step === 'reread'
      revoked = step === 'reshare'
    } catch (error) {
      console.warn('flow: shared page update failed', { slug: entry.slug, error })
      refused = SHARE_NO_ANSWER_TEXT
    }
    entry.share.updating = false
    drawShare(entry)
    // Revoked elsewhere: NOT retried — the re-share dialog asks who it is for.
    if (revoked) {
      note(entry, null)
      reshareRevoked(entry)
      return
    }
    note(entry, refused)
    // The question is redrawn from what is really on disk now.
    if (changed) void askShare(entry)
  }

  async function copyLink(entry: HostedFeatureView): Promise<void> {
    const share = liveShare(entry.share.state)
    if (share === null) return
    try {
      await navigator.clipboard.writeText(share.url)
      entry.share.copy.textContent = SHARE_COPIED_LABEL
      setTimeout(() => {
        entry.share.copy.textContent = SHARE_COPY_LABEL
      }, COPIED_FEEDBACK_MS)
    } catch (error) {
      console.warn('flow: share link could not be copied', { error })
      note(entry, SHARE_COPY_FAILED_TEXT)
    }
  }

  /** Who has opened it — read when the list is opened, never in the background. */
  async function toggleViewers(entry: HostedFeatureView): Promise<void> {
    const share = liveShare(entry.share.state)
    const api = shareApi()
    entry.share.viewersOpen = !entry.share.viewersOpen
    drawShare(entry)
    if (!entry.share.viewersOpen || share === null || api === null) return
    const list = entry.share.viewers
    list.replaceChildren(viewersLine(VIEWERS_LOADING_TEXT))
    let rows: HTMLElement[]
    try {
      const result = await api.views({ id: share.id })
      if (!result.ok) rows = [viewersLine(result.message)]
      else if (result.views.length === 0) rows = [viewersLine(VIEWERS_EMPTY_TEXT)]
      else {
        rows = viewerRows(result.views, Date.now()).map((row) => {
          const item = document.createElement('li')
          const email = document.createElement('span')
          email.className = 'fl-feature-viewer-email'
          email.textContent = row.email
          const when = document.createElement('span')
          when.className = 'fl-feature-viewer-when'
          when.textContent = row.lastViewed
          item.append(email, when)
          return item
        })
      }
    } catch (error) {
      console.warn('flow: share viewers could not be read', { error })
      rows = [viewersLine(SHARE_NO_ANSWER_TEXT)]
    }
    list.replaceChildren(...rows)
  }

  function onShareButton(entry: HostedFeatureView): void {
    note(entry, null)
    const action = entry.share.button.dataset['action']
    if (action === 'sign-in') signIn(entry)
    else if (action === 'retry') void askShare(entry)
    else if (action === 'publish') publish(entry)
    else if (action === 'manage') {
      const share = liveShare(entry.share.state)
      if (share !== null) manage(entry, share)
    }
  }

  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((records) => {
          for (const record of records) {
            if (!record.isIntersecting) continue
            for (const entry of hosted.values()) {
              if (entry.element === record.target) showIfStale(entry)
            }
          }
        })
      : null

  function build(detail: OpenFeatureViewDetail, threadId: string | null): HostedFeatureView {
    const element = document.createElement('div')
    element.className = 'fl-feature-view'
    element.setAttribute('role', 'document')
    element.setAttribute('aria-label', 'Artifact')

    const bar = document.createElement('header')
    bar.className = 'fl-feature-bar'
    const kicker = document.createElement('span')
    kicker.className = 'fl-feature-kicker'
    kicker.textContent = FEATURE_VIEW_KICKER
    const titleEl = document.createElement('span')
    titleEl.className = 'fl-feature-title'
    titleEl.textContent = detail.title
    const shareButton = document.createElement('button')
    shareButton.type = 'button'
    shareButton.className = 'fl-feature-btn fl-feature-share-btn'
    bar.append(kicker, titleEl, shareButton)

    const share = buildShareParts(shareButton)

    const frame = document.createElement('iframe')
    frame.className = 'fl-feature-frame'
    // Scripts only: never allow-same-origin, so the page is an opaque origin
    // that cannot reach this window. The page's own CSP keeps it off the network.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.title = `What people will see: ${detail.title}`

    const empty = document.createElement('p')
    empty.className = 'fl-feature-empty'
    empty.hidden = true

    element.append(bar, share.note, share.prompt, share.strip, share.viewers, frame, empty)
    const entry: HostedFeatureView = {
      element,
      titleEl,
      frame,
      empty,
      rootPath: detail.rootPath,
      threadId,
      path: detail.path,
      docPath: docPathForWalkthrough(detail.path),
      slug: detail.slug,
      // The card offers the door only when the watcher saw the page.
      page: { present: true },
      stale: false,
      loads: 0,
      share,
    }
    shareButton.addEventListener('click', () => onShareButton(entry))
    share.copy.addEventListener('click', () => void copyLink(entry))
    share.manage.addEventListener('click', () => {
      const live = liveShare(entry.share.state)
      if (live !== null) manage(entry, live)
    })
    share.revoke.addEventListener('click', () => {
      const live = liveShare(entry.share.state)
      if (live !== null) revoke(entry, live)
    })
    share.viewersToggle.addEventListener('click', () => void toggleViewers(entry))
    share.update.addEventListener('click', () => void updateShared(entry))
    share.notNow.addEventListener('click', () => {
      const prompt = updatePromptFor(entry.share.state, entry.share.dismissed)
      if (prompt === null) return
      entry.share.dismissed = withDismissed(entry.share.dismissed, prompt.key)
      drawShare(entry)
    })
    drawShare(entry)
    return entry
  }

  /**
   * Open (or focus) a view. A press opens it into the conversation on screen
   * and reveals the editor; a tab-set restore (`restored`) names the
   * conversation it belongs to and reveals nothing.
   */
  function open(
    detail: OpenFeatureViewDetail,
    restored: { threadId: string | null } | null = null,
  ): string {
    // Reveal first: this press comes from the CHAT pane, where the editor may be
    // hidden, and a tab opened into a hidden host reads as a dead button.
    if (restored === null) document.dispatchEvent(new CustomEvent('flow:show-editor'))
    const threadId = restored !== null ? restored.threadId : (scope?.threadId ?? null)
    const id = featureViewTabId(detail.rootPath, detail.slug, detail.path, threadId)
    let entry = hosted.get(id)
    if (entry === undefined) {
      entry = build(detail, threadId)
      hosted.set(id, entry)
      observer?.observe(entry.element)
    } else {
      // Same project, slug and version (the id says so) — only the title can
      // have changed since it was opened.
      entry.titleEl.textContent = detail.title
      entry.frame.title = `What people will see: ${detail.title}`
      entry.page = { present: true }
    }
    // A press always frames the page as it is NOW. A restore frames it when
    // it is next drawn (#17): a set may bring back several views at once.
    if (restored === null) showPage(entry)
    else entry.stale = true
    const persisted = entry
    editorApi.openView({
      id,
      label: featureViewTabLabel(detail.slug, detail.path),
      icon: FEATURE_VIEW_ICON,
      element: entry.element,
      persist: {
        kind: FEATURE_VIEW_KIND,
        state: () => ({
          rootPath: persisted.rootPath,
          path: persisted.path,
          slug: persisted.slug,
          title: persisted.titleEl.textContent ?? persisted.slug,
        }),
      },
    })
    // Opening is the moment someone looks: ask what its share is now.
    if (restored === null) void askShare(entry)
    else askShareWhenSeen(entry)
    return id
  }

  // A conversation's tab set coming back: rebuild its feature views lazily.
  editorApi.registerViewRestorer(FEATURE_VIEW_KIND, (state, restoreScope) => {
    const { rootPath, path, slug, title } = state
    if (typeof slug !== 'string' || slug.length === 0) return null
    if (typeof path !== 'string' || path.length === 0) return null
    return open(
      {
        rootPath: typeof rootPath === 'string' ? rootPath : null,
        path,
        slug,
        title: typeof title === 'string' ? title : slug,
      },
      { threadId: restoreScope.threadId },
    )
  })

  document.addEventListener('flow:open-feature-view', (event) => {
    const detail = (event as CustomEvent<OpenFeatureViewDetail>).detail
    if (!detail || typeof detail.slug !== 'string' || detail.slug.length === 0) return
    if (typeof detail.path !== 'string' || detail.path.length === 0) return
    // Opened into the conversation it was pressed in — held while a switch is
    // still bringing that conversation's set on screen, so the view is never
    // tagged with the conversation being left (and then closed as not its).
    void runInWantedScope(() => open(detail))
  })

  // A page rewritten on disk (an agent redrafting it) reloads only a view
  // someone is looking at; the rest wait until they are looked at.
  window.flow?.flow?.onArtifactChanged((event: FlowArtifactChangedEvent) => {
    for (const [id, entry] of hosted) {
      if (entry.docPath !== event.path || entry.rootPath !== event.rootId) continue
      const change = featureViewPageChange(entry.page, event)
      if (change === 'none') continue
      entry.page = change === 'gone' ? { present: false } : { present: true, mtime: event.walkthroughMtime }
      const decision = decideFeatureViewRefresh({ tabOpen: editorApi.hasTab(id), onScreen: isOnScreen(entry) })
      if (decision === 'now') showPage(entry)
      else if (decision === 'defer') entry.stale = true
      // A new page may be newer than the shared one — that is when
      // "update it?" is asked, so the share is asked again with it.
      if (decision !== 'skip') askShareWhenSeen(entry)
    }
  })

  // ONE SIGN-IN STATE. Signing in or out anywhere — Settings, another view,
  // or main clearing a session the share host refused — re-asks every view's
  // share state, so the Share button never disagrees with Settings. Only the
  // views on screen ask now; the rest when they are next drawn (#17).
  window.flow?.settings?.onAuthChanged?.(() => {
    for (const entry of hosted.values()) askShareWhenSeen(entry)
  })

  document.addEventListener('visibilitychange', () => {
    for (const entry of hosted.values()) showIfStale(entry)
  })

  // FLOW'S THEME FLIPS, THE PAGE FOLLOWS. The theme rides in the page URL, so
  // a flip reloads what is on screen and marks the rest stale — the same rule
  // as a page rewritten on disk.
  new MutationObserver(() => {
    for (const [id, entry] of hosted) {
      const decision = decideFeatureViewRefresh({ tabOpen: editorApi.hasTab(id), onScreen: isOnScreen(entry) })
      if (decision === 'now') showPage(entry)
      else if (decision === 'defer') entry.stale = true
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  editorApi.onTabsChanged(() => {
    for (const entry of hosted.values()) showIfStale(entry)
  })

  /**
   * Let go of a view that belongs to a set no longer on screen: its page is
   * unloaded, it is no longer observed, and the editor forgets its element.
   * The set it belongs to rebuilds it fresh (the restorer) when it comes back.
   * Without this every view ever opened — per project × slug × version ×
   * conversation — kept a live page in a hidden iframe for the life of the
   * window, including the views of conversations that were since deleted.
   */
  function release(id: string): void {
    const entry = hosted.get(id)
    if (entry === undefined) return
    observer?.unobserve(entry.element)
    entry.frame.removeAttribute('src')
    editorApi.disposeView(id)
    hosted.delete(id)
  }

  // The tab set on screen changed (a conversation or a project switch). The
  // switch itself already closed the outgoing set's views; this releases them
  // (and any opened while it ran), and re-asks the share of the views that stay.
  document.addEventListener(TAB_SCOPE_EVENT, (event) => {
    scope = (event as CustomEvent<TabScopeKey | null>).detail ?? null
    const views = [...hosted].map(([id, entry]) => ({
      id,
      rootPath: entry.rootPath,
      threadId: entry.threadId,
    }))
    const closing = new Set(featureViewsToClose(views, scope?.rootPath ?? null, scope?.threadId ?? null))
    for (const id of closing) release(id)
    for (const [id, entry] of hosted) {
      if (!closing.has(id) && editorApi.hasTab(id)) askShareWhenSeen(entry)
    }
  })
}

/**
 * The share controls under the header: a note line, the "update it?"
 * question, the shared strip and the viewers list — all hidden until the
 * state says otherwise. Built empty; `drawShare` fills them.
 */
function buildShareParts(button: HTMLButtonElement): HostedShare {
  const note = document.createElement('p')
  note.className = 'fl-feature-share-note'
  note.setAttribute('role', 'status')
  note.hidden = true

  const prompt = document.createElement('div')
  prompt.className = 'fl-feature-share-prompt'
  prompt.setAttribute('role', 'region')
  prompt.setAttribute('aria-label', 'Shared page update')
  prompt.hidden = true
  const promptText = document.createElement('div')
  promptText.className = 'fl-feature-share-prompt-text'
  const promptTitle = document.createElement('strong')
  const promptTarget = document.createElement('span')
  promptTarget.className = 'fl-feature-share-prompt-target'
  const promptDetail = document.createElement('span')
  promptText.append(promptTitle, promptTarget, promptDetail)
  const notNow = shareButton(UPDATE_DISMISS_LABEL)
  const update = shareButton(UPDATE_CONFIRM_LABEL)
  update.classList.add('fl-feature-share-primary')
  prompt.append(promptText, notNow, update)

  const strip = document.createElement('div')
  strip.className = 'fl-feature-share-strip'
  strip.setAttribute('role', 'region')
  strip.setAttribute('aria-label', 'Sharing')
  strip.hidden = true
  const subject = document.createElement('span')
  subject.className = 'fl-feature-share-subject'
  const summary = document.createElement('span')
  summary.className = 'fl-feature-share-summary'
  const link = document.createElement('span')
  link.className = 'fl-feature-share-link'
  const expiry = document.createElement('span')
  expiry.className = 'fl-feature-share-expiry'
  const copy = shareButton(SHARE_COPY_LABEL)
  const manage = shareButton(SHARE_MANAGE_LABEL)
  const revoke = shareButton(SHARE_REVOKE_LABEL)
  const viewersToggle = shareButton(VIEWERS_LABEL)
  viewersToggle.setAttribute('aria-expanded', 'false')
  strip.append(subject, summary, link, expiry, copy, viewersToggle, manage, revoke)

  const viewers = document.createElement('ul')
  viewers.className = 'fl-feature-share-viewers'
  viewers.setAttribute('aria-label', 'Who has opened this page')
  viewers.hidden = true

  return {
    button,
    strip,
    subject,
    summary,
    link,
    expiry,
    copy,
    manage,
    revoke,
    viewersToggle,
    viewers,
    prompt,
    promptTitle,
    promptTarget,
    promptDetail,
    update,
    notNow,
    note,
    state: { kind: 'idle' },
    dismissed: new Set<string>(),
    sequence: createRequestSequence(),
    signingIn: false,
    resumeAfterSignIn: false,
    updating: false,
    viewersOpen: false,
    stale: false,
  }
}

function shareButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-feature-share-action'
  button.textContent = label
  return button
}

/** One line in the viewers list that is not a viewer: loading, empty, or why not. */
function viewersLine(text: string): HTMLElement {
  const item = document.createElement('li')
  item.className = 'fl-feature-viewer-note'
  item.textContent = text
  return item
}

let stylesInjected = false

function injectFeatureViewStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  // Flow's own tokens for the chrome only: the bar is Flow's, and everything
  // below it is the target app's look, drawn by the page itself.
  style.textContent = `
    .fl-feature-view {
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--fl-color-bg);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-feature-bar {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-xs) var(--fl-space-md);
      border-bottom: var(--fl-border-width, 1px) solid var(--fl-color-border);
      background: var(--fl-color-surface);
      min-width: 0;
    }
    .fl-feature-kicker {
      flex: none;
      font-size: var(--fl-text-caption-size);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--fl-color-text-secondary);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-feature-title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-feature-btn {
      flex: none;
      border: var(--fl-border-width, 1px) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      cursor: pointer;
      padding: 4px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      transition: border-color var(--fl-transition-fast);
    }
    .fl-feature-btn:hover { border-color: var(--fl-color-accent); }
    .fl-feature-btn:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }
    .fl-feature-frame {
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      border: 0;
      display: block;
      background: var(--fl-color-bg);
    }
    .fl-feature-frame[hidden], .fl-feature-empty[hidden] { display: none; }
    .fl-feature-empty {
      margin: 0;
      padding: var(--fl-space-xl) var(--fl-space-lg);
      font-size: var(--fl-text-prose-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-feature-btn:disabled { opacity: 0.55; cursor: default; }
    .fl-feature-btn:disabled:hover { border-color: var(--fl-color-border); }
    /* Share is the header's one primary action once it can act. */
    .fl-feature-share-btn[data-action='publish'] {
      background: var(--fl-color-accent);
      border-color: transparent;
      color: #fff;
    }
    .fl-feature-share-note[hidden], .fl-feature-share-prompt[hidden],
    .fl-feature-share-strip[hidden], .fl-feature-share-viewers[hidden],
    .fl-feature-share-expiry[hidden] { display: none; }
    .fl-feature-share-note {
      flex: none;
      margin: 0;
      padding: var(--fl-space-xs) var(--fl-space-md);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      border-bottom: var(--fl-border-width, 1px) solid var(--fl-color-border);
      background: var(--fl-color-surface);
    }
    .fl-feature-share-prompt, .fl-feature-share-strip {
      flex: none;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-xs) var(--fl-space-md);
      border-bottom: var(--fl-border-width, 1px) solid var(--fl-color-border);
      background: var(--fl-color-surface);
      font-size: var(--fl-text-caption-size);
      min-width: 0;
    }
    .fl-feature-share-prompt { border-left: 2px solid var(--fl-color-warning); }
    .fl-feature-share-prompt-text {
      flex: 1 1 260px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      line-height: var(--fl-line-height-dense);
    }
    .fl-feature-share-prompt-text strong { font-weight: var(--fl-text-ui-weight-medium); }
    .fl-feature-share-prompt-text span { color: var(--fl-color-text-secondary); }
    .fl-feature-share-subject {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-feature-share-summary { color: var(--fl-color-text-secondary); }
    .fl-feature-share-prompt-text .fl-feature-share-prompt-target { color: var(--fl-color-text); }
    .fl-feature-share-link {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--fl-font-mono);
      color: var(--fl-color-text-secondary);
      user-select: text;
    }
    .fl-feature-share-expiry { color: var(--fl-color-text-secondary); }
    .fl-feature-share-action {
      flex: none;
      border: var(--fl-border-width, 1px) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      cursor: pointer;
      padding: 2px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      transition: border-color var(--fl-transition-fast);
    }
    .fl-feature-share-action:hover { border-color: var(--fl-color-accent); }
    .fl-feature-share-action:disabled { opacity: 0.55; cursor: default; }
    .fl-feature-share-action:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }
    .fl-feature-share-primary {
      background: var(--fl-color-accent);
      border-color: transparent;
      color: #fff;
    }
    .fl-feature-share-viewers {
      flex: none;
      list-style: none;
      margin: 0;
      padding: var(--fl-space-xs) var(--fl-space-md);
      max-height: 160px;
      overflow-y: auto;
      border-bottom: var(--fl-border-width, 1px) solid var(--fl-color-border);
      background: var(--fl-color-surface);
      font-size: var(--fl-text-caption-size);
    }
    .fl-feature-share-viewers li {
      display: flex;
      justify-content: space-between;
      gap: var(--fl-space-sm);
      padding: 2px 0;
    }
    .fl-feature-viewer-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-feature-viewer-when, .fl-feature-viewer-note { color: var(--fl-color-text-secondary); }
    @media (prefers-reduced-motion: reduce) {
      .fl-feature-btn, .fl-feature-share-action { transition: none; }
    }
  `
  document.head.appendChild(style)
}
