/**
 * What a feature view shows about its share — PURE, no DOM, clock injected, so
 * node-env jest can hold the rules (allowed-pattern #17: one helper, not the
 * same decision restated at each call site).
 *
 * THE RENDERER KNOWS SHARE STATE, NOT WHO YOU ARE. Whether the button reads
 * "Sign in to share" is decided by main's answer to `share:get` — a refusal
 * whose reason says nobody is signed in — never by reading the identity here.
 * The renderer may display a name; it may not branch on one
 * (`identity-is-not-a-gate.test.ts`). And the answer only ever changes the
 * Share button: the page above it is the same signed in or out.
 *
 * "THIS PAGE IS SHARED — UPDATE IT?" is asked when what is on disk is newer
 * than what people with the link see: a later discovery `_vN`, or the same
 * version with a walkthrough page written after the published one. Nothing
 * republishes on its own (FR-05). "Not now" is remembered for exactly that
 * version and page — in memory, for this run — so the next rewrite asks again.
 */
import type {
  ShareClientRefusalReason,
  ShareGetResult,
  ShareLocalFacts,
} from '../../shared/ipc-contract'
import type { ShareAccess, ShareSummary, ShareView } from '../../shared/share-contract'
import { formatBytes, formatDate } from './share-dialog-model'

// ── State ─────────────────────────────────────────────────────────────────

export type ShareState =
  /** Nothing has been asked yet. */
  | { kind: 'idle' }
  /** A `share:get` is in flight and nothing was known before it. */
  | { kind: 'loading' }
  /** The view has no project to share from. */
  | { kind: 'no-project' }
  /** Main says nobody is signed in, or the sign-in has run out. */
  | { kind: 'signed-out'; message: string }
  /** Main refused for another reason; `message` is its sentence, shown as-is. */
  | { kind: 'refused'; reason: ShareClientRefusalReason; message: string }
  /** Main answered: the share (null = never shared) and what would be sent. */
  | { kind: 'ready'; share: ShareSummary | null; local: ShareLocalFacts }

/** The refusals a sign-in would answer. Anything else, signing in would not fix. */
const SIGN_IN_REASONS: ReadonlySet<ShareClientRefusalReason> = new Set<ShareClientRefusalReason>([
  'signed-out',
  'session-expired',
  'unauthenticated',
])

/**
 * Refusals pressing Share again cannot change: the build has no share host,
 * the account may not share, or this view has nothing shareable. Everything
 * else (offline, the service having trouble) is worth another try.
 */
const FINAL_REASONS: ReadonlySet<ShareClientRefusalReason> = new Set<ShareClientRefusalReason>([
  'sharing-unavailable',
  'identity-disabled',
  'not-a-discovery',
  'page-missing',
])

export function isSignInRefusal(reason: ShareClientRefusalReason): boolean {
  return SIGN_IN_REASONS.has(reason)
}

/** Main's answer to `share:get`, as the state a view draws. */
export function shareStateFrom(result: ShareGetResult): ShareState {
  if (result.ok) return { kind: 'ready', share: result.share, local: result.local }
  if (isSignInRefusal(result.reason)) return { kind: 'signed-out', message: result.message }
  return { kind: 'refused', reason: result.reason, message: result.message }
}

/** A live share: published and not revoked. A revoked one is shared with nobody. */
export function liveShare(state: ShareState): ShareSummary | null {
  if (state.kind !== 'ready' || state.share === null) return null
  return state.share.revokedAt === null ? state.share : null
}

/** The state after a publish, update or revoke answered with a new summary. */
export function withShare(state: ShareState, share: ShareSummary): ShareState {
  if (state.kind !== 'ready') return state
  return { kind: 'ready', share, local: state.local }
}

/**
 * The same state with its share marked revoked — what a view draws once the
 * server answered `revoked` to an update made from a stale window (review H4).
 * The caller's state is never changed.
 */
export function withRevoked(state: ShareState, at: string): ShareState {
  if (state.kind !== 'ready' || state.share === null || state.share.revokedAt !== null) return state
  return { kind: 'ready', share: { ...state.share, revokedAt: at }, local: state.local }
}

/**
 * What a view does after a publish or update was refused:
 *  · `reshare` — the share was revoked elsewhere. Never retried as an update
 *    (that would quietly bring the old list back); the re-share dialog opens
 *    instead, which asks who it is for (review H4).
 *  · `reread` — the files changed since review; read the facts again.
 *  · `show` — say the sentence, nothing else.
 */
export type RefusalStep = 'reshare' | 'reread' | 'show'

export function stepAfterRefusal(reason: ShareClientRefusalReason): RefusalStep {
  if (reason === 'revoked') return 'reshare'
  if (reason === 'changed-since-review') return 'reread'
  return 'show'
}

// ── The Share button ──────────────────────────────────────────────────────

export const SHARE_BUTTON_LABEL = 'Share'
export const SHARED_BUTTON_LABEL = 'Shared'
export const SIGN_IN_TO_SHARE_LABEL = 'Sign in to share'
export const SIGNING_IN_LABEL = 'Opening browser…'
export const SIGNING_IN_HINT = 'Finish signing in in your browser, then come back.'
export const SIGN_IN_FAILED_TEXT = "The sign-in didn't complete. You can try again."
export const SHARE_NO_PROJECT_HINT = 'Open the project this discovery belongs to, to share it.'
export const SHARE_CHECKING_HINT = 'Checking whether this page is shared…'

/** What pressing the button does. */
export type ShareButtonAction = 'none' | 'sign-in' | 'retry' | 'publish' | 'manage'

export interface ShareButtonView {
  label: string
  /** Its hover text: what pressing it does, or why it can't. */
  title: string
  disabled: boolean
  action: ShareButtonAction
}

/**
 * The Share button for a state. It is NEVER hidden (FR-01): a view that cannot
 * share says why on the button itself, disabled, rather than vanishing.
 */
export function shareButtonFor(state: ShareState, signingIn: boolean): ShareButtonView {
  if (signingIn) return { label: SIGNING_IN_LABEL, title: SIGNING_IN_HINT, disabled: true, action: 'none' }
  switch (state.kind) {
    case 'idle':
    case 'loading':
      return { label: SHARE_BUTTON_LABEL, title: SHARE_CHECKING_HINT, disabled: true, action: 'none' }
    case 'no-project':
      return { label: SHARE_BUTTON_LABEL, title: SHARE_NO_PROJECT_HINT, disabled: true, action: 'none' }
    case 'signed-out':
      return {
        label: SIGN_IN_TO_SHARE_LABEL,
        title: 'Sign in to Flow to share this page. Everything else works the same signed out.',
        disabled: false,
        action: 'sign-in',
      }
    case 'refused':
      return FINAL_REASONS.has(state.reason)
        ? { label: SHARE_BUTTON_LABEL, title: state.message, disabled: true, action: 'none' }
        : { label: SHARE_BUTTON_LABEL, title: `${state.message} Press to try again.`, disabled: false, action: 'retry' }
    case 'ready':
      return liveShare(state) === null
        ? {
            label: SHARE_BUTTON_LABEL,
            title: 'Share this artifact as a private page people open in their browser',
            disabled: false,
            action: 'publish',
          }
        : {
            label: SHARED_BUTTON_LABEL,
            title: 'Change who can open this page, or when its link stops working',
            disabled: false,
            action: 'manage',
          }
  }
}

// ── Picking up where the person was, after a sign-in ──────────────────────
//
// Pressing "Sign in to share" is pressing Share: the person wanted to share
// and was stopped by a sign-in. So once the sign-in succeeds and main has
// answered the view's share state again, the dialog they were heading for
// opens by itself — the publish dialog for a page not shared yet, Manage for
// one that is. It OPENS A DIALOG and nothing more: publishing still needs the
// author's own press inside it (FR-05, never an automatic publish).

/** Which dialog to reopen after a sign-in. */
export type ShareResume = 'publish' | 'manage'

/**
 * The dialog to open now, or null. Only when the person asked to share
 * (`intent`), and only from a state main actually answered with — a view still
 * signed out, refused or loading opens nothing.
 */
export function dialogAfterSignIn(intent: boolean, state: ShareState): ShareResume | null {
  if (!intent) return null
  const action = shareButtonFor(state, false).action
  return action === 'publish' || action === 'manage' ? action : null
}

// ── The shared strip ──────────────────────────────────────────────────────

export interface ShareStripView {
  /** Which share this is: its title and project label — "Ledger Sync · proj". */
  subject: string
  /** "Shared with 2 people and company.com". */
  summary: string
  /** The link people open. */
  url: string
  /** "Link expires 12 Oct 2026", "Link expired on …", or null for no expiry. */
  expiry: string | null
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Shared with 1 person", "Shared with company.com", "Shared with 2 people and 3 company domains". */
export function sharedWithText(access: ShareAccess): string {
  const parts: string[] = []
  if (access.emails.length > 0) parts.push(plural(access.emails.length, 'person', 'people'))
  if (access.domains.length === 1) parts.push(access.domains[0] ?? '')
  else if (access.domains.length > 1) parts.push(plural(access.domains.length, 'company domain', 'company domains'))
  if (parts.length === 0) return 'Shared with nobody yet'
  return `Shared with ${parts.join(' and ')}`
}

/** The strip a shared view carries, or null when it is not shared. */
export function shareStripFor(state: ShareState, now: number): ShareStripView | null {
  const share = liveShare(state)
  if (share === null) return null
  let expiry: string | null = null
  if (share.expiresAt !== null) {
    const at = Date.parse(share.expiresAt)
    expiry =
      !Number.isNaN(at) && at <= now
        ? `Link expired on ${formatDate(share.expiresAt)}`
        : `Link expires ${formatDate(share.expiresAt)}`
  }
  return { subject: shareSubject(share), summary: sharedWithText(share.access), url: share.url, expiry }
}

/**
 * "Ledger Sync · proj" — the share's own title and project label, as the share
 * host has them. Shown wherever an action would change what people with the
 * link see, so the author can tell WHICH share it is before pressing (review
 * R2-M3: two projects with one folder name used to look like one share).
 */
export function shareSubject(share: ShareSummary): string {
  const title = share.title.trim() === '' ? share.slug : share.title.trim()
  const project = share.project.trim()
  return project === '' ? title : `${title} · ${project}`
}

export const SHARE_COPY_LABEL = 'Copy link'
export const SHARE_COPIED_LABEL = 'Copied'
export const SHARE_COPY_FAILED_TEXT = "Flow couldn't copy the link. Select it and copy it instead."
export const SHARE_MANAGE_LABEL = 'Manage'
export const SHARE_REVOKE_LABEL = 'Revoke'
/** Said when this window's bridge predates sharing (an older preload). */
export const SHARE_UNSUPPORTED_TEXT = "This version of Flow can't share pages."
/**
 * Said after a publish or update when the share host did not email some of the
 * people it was asked to, because of its sending limits (review R2-L5). Null
 * when everyone was emailed.
 */
export function invitesSkippedText(skipped: number | undefined): string | null {
  if (skipped === undefined || !Number.isSafeInteger(skipped) || skipped <= 0) return null
  const who = skipped === 1 ? "1 person wasn't" : `${skipped} people weren't`
  return `${who} emailed because of sending limits — share the link with them directly.`
}

// ── "Check sharing status" ────────────────────────────────────────────────
//
// Opening a view never asks the share host about a discovery this computer
// has no record of sharing (review R2-M7). A share made from another computer
// shows up when the author asks — this button, in the Share dialog.

export const SHARE_CHECK_LABEL = 'Check sharing status'
export const SHARE_CHECK_BUSY_LABEL = 'Checking…'
export const SHARE_CHECK_TITLE =
  'Ask the share service whether you already shared this page, for example from another computer'
export const SHARE_CHECK_NONE_TEXT = "You haven't shared this page from this account."

/** Said when a share call failed without an answer from main. */
export const SHARE_NO_ANSWER_TEXT = "Flow couldn't reach the share service. Try again in a moment."

// ── "This page is shared — update it?" ────────────────────────────────────

export const UPDATE_PROMPT_TITLE = 'This page is shared — update it?'
export const UPDATE_CONFIRM_LABEL = 'Update shared page'
export const UPDATE_BUSY_LABEL = 'Updating…'
export const UPDATE_DISMISS_LABEL = 'Not now'

export interface UpdatePromptView {
  /** What "Not now" remembers — this version of this page, nothing broader. */
  key: string
  title: string
  /** WHICH share an update goes to — title, project and audience — read before Update. */
  target: string
  detail: string
}

/** The identity of what is on disk now: the discovery version and the page's write time. */
export function updateDismissKey(local: ShareLocalFacts): string {
  return `v${local.discoveryVersion}@${local.pageModifiedAt}`
}

/** A new set with this version dismissed — the caller's set is never changed. */
export function withDismissed(dismissed: ReadonlySet<string>, key: string): Set<string> {
  return new Set([...dismissed, key])
}

/** How what is on disk compares to what people with the link see. */
export function localIsNewer(share: ShareSummary, local: ShareLocalFacts): 'version' | 'page' | null {
  if (local.discoveryVersion > share.discoveryVersion) return 'version'
  if (local.discoveryVersion < share.discoveryVersion) return null
  const localAt = Date.parse(local.pageModifiedAt)
  const sharedAt = Date.parse(share.pageModifiedAt)
  if (Number.isNaN(localAt) || Number.isNaN(sharedAt)) return null
  return localAt > sharedAt ? 'page' : null
}

/**
 * Whether to ask, and what to say. Null when the page is not shared, is
 * already current, or this exact version was answered "Not now".
 */
export function updatePromptFor(state: ShareState, dismissed: ReadonlySet<string>): UpdatePromptView | null {
  if (state.kind !== 'ready') return null
  const share = liveShare(state)
  if (share === null) return null
  const newer = localIsNewer(share, state.local)
  if (newer === null) return null
  const key = updateDismissKey(state.local)
  if (dismissed.has(key)) return null
  const what =
    newer === 'version'
      ? `The discovery is now version ${state.local.discoveryVersion}; people with the link still see version ${share.discoveryVersion}.`
      : 'The artifact changed since you shared it; people with the link still see the earlier page.'
  const sizes = state.local.files.map((file) => `${file.name} (${formatBytes(file.bytes)})`).join(' and ')
  return {
    key,
    title: UPDATE_PROMPT_TITLE,
    target: `${shareSubject(share)} — ${sharedWithText(share.access)}`,
    detail: `${what} Updating sends ${sizes} to the same link, and keeps the earlier version.`,
  }
}

// ── Viewers ───────────────────────────────────────────────────────────────

export const VIEWERS_LABEL = 'Viewers'
export const VIEWERS_EMPTY_TEXT = 'Nobody has opened it yet.'
export const VIEWERS_LOADING_TEXT = 'Loading who opened it…'

export interface ViewerRow {
  email: string
  lastViewed: string
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", else the date. */
export function formatAgo(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const elapsed = Math.max(0, now - at)
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), 'minute', 'minutes')} ago`
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), 'hour', 'hours')} ago`
  if (elapsed < 30 * DAY_MS) return `${plural(Math.floor(elapsed / DAY_MS), 'day', 'days')} ago`
  return formatDate(iso)
}

/** Who opened it, most recent first (the server's order, kept). */
export function viewerRows(views: readonly ShareView[], now: number): ViewerRow[] {
  return views.map((view) => ({ email: view.email, lastViewed: `Last opened ${formatAgo(view.lastViewedAt, now)}` }))
}

// ── Answer ordering ───────────────────────────────────────────────────────

/**
 * Only the newest question's answer may be drawn. A view asks again when it
 * opens, when its page changes and after a sign-in; an older answer arriving
 * after a newer one would put a stale share back on screen.
 */
export interface RequestSequence {
  next(): number
  isCurrent(ticket: number): boolean
}

export function createRequestSequence(): RequestSequence {
  let latest = 0
  return {
    next: () => {
      latest += 1
      return latest
    },
    isCurrent: (ticket) => ticket === latest,
  }
}
