/**
 * What the Share dialog decides — PURE, no DOM, so node-env jest can hold every
 * rule here without a browser (the dialog itself only draws what this returns).
 *
 * THREE JOBS, one module:
 *
 *  · WHO. People are emails, a company is a domain. What a person types is
 *    VALIDATED and refused in place, never rewritten (allowed-pattern #22):
 *    trimming the edges and lower-casing are the only changes, because the
 *    server compares lower-cased and whitespace is not part of an address. A
 *    public mail provider is refused as a company domain — "anyone at gmail.com"
 *    is everybody — but a single address there is fine as a person.
 *
 *  · WHAT. The dialog says exactly what will leave the machine — the walkthrough
 *    page and the discovery document, by name and size — from the local facts
 *    main read off disk. Those files' hashes are what the publish request carries
 *    as `reviewed`, so main can refuse when the files changed after the author
 *    looked — even to the same size: what is uploaded is what was confirmed.
 *
 *  · THE PAYLOAD. A form becomes a publish or an update request here, so the
 *    one place that knows the request's shape is the one a test reads.
 *
 * Every sentence is plain words: no commands, paths or config keys
 * (forbidden-pattern #12). A file NAME is shown — it is what is being sent, and
 * the author should recognise it — but never where it lives.
 */
import type {
  ShareDocRef,
  ShareLocalFacts,
  ShareLocalFile,
  SharePublishRequest,
  ShareReviewed,
  ShareUpdateRequest,
} from '../../shared/ipc-contract'
import {
  PUBLIC_MAIL_DOMAINS,
  SHARE_MAX_DOMAINS,
  SHARE_MAX_EMAILS,
  type ShareAccess,
  type ShareSummary,
} from '../../shared/share-contract'

// ── Copy ──────────────────────────────────────────────────────────────────

export const SHARE_DIALOG_PUBLISH_TITLE = 'Share this artifact'
export const SHARE_DIALOG_MANAGE_TITLE = 'Manage sharing'
export const SHARE_DIALOG_PUBLISH_BODY =
  'People you add get a private link. They confirm their email once to open it — nothing to install, no account to create.'
export const SHARE_DIALOG_MANAGE_BODY =
  'Change who can open this page, or when the link stops working. The link stays the same.'
export const SHARE_PEOPLE_LABEL = 'People'
export const SHARE_PEOPLE_PLACEHOLDER = 'name@company.com'
export const SHARE_DOMAIN_LABEL = 'Company domain (optional)'
export const SHARE_DOMAIN_PLACEHOLDER = 'company.com'
export const SHARE_DOMAIN_HINT = 'Anyone with a verified email at this domain can open the page.'
export const SHARE_NOTIFY_LABEL = 'Email them the link'
export const SHARE_EXPIRY_LABEL = 'Link expires'
export const SHARE_SENT_LABEL = 'What will be sent'
export const SHARE_SENT_NOTE = 'Only these two files leave your computer.'
export const SHARE_PUBLISH_LABEL = 'Share'
export const SHARE_SAVE_LABEL = 'Save changes'
export const SHARE_CANCEL_LABEL = 'Cancel'
export const SHARE_BUSY_PUBLISH_LABEL = 'Sharing…'
export const SHARE_BUSY_SAVE_LABEL = 'Saving…'

/** What each part is, in words — the file name follows it. */
const PART_LABELS: Readonly<Record<ShareLocalFile['part'], string>> = {
  walkthrough: 'Artifact page',
  discovery: 'Discovery document',
}

// ── People and domains ────────────────────────────────────────────────────

/**
 * One address: something@host.tld, no spaces, no second `@`. Deliberately not
 * RFC 5322 — the server sends a code to whatever is listed, and a typo that
 * passes a strict parser fails there just the same. This catches the shapes a
 * person mistypes (a missing `@`, a missing dot, a stray comma).
 */
const EMAIL_PATTERN = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]{2,}$/

/** The longest address mail systems accept. */
const MAX_EMAIL_LENGTH = 254

/**
 * A host name: dot-separated labels of letters, digits and inner hyphens, with
 * at least two labels. No `@`, no leading or trailing dot (the contract's rule).
 */
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

/** What a person may paste several of at once: commas, semicolons, spaces. */
const ENTRY_SEPARATOR = /[\s,;]+/

const PUBLIC_DOMAINS: ReadonlySet<string> = new Set(PUBLIC_MAIL_DOMAINS)

/** Split pasted text into entries. Blanks are dropped; nothing is rewritten. */
export function splitEntries(raw: string): string[] {
  return raw
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export type EntryCheck = { ok: true; value: string } | { ok: false; message: string }

/** One typed email: lower-cased, or why it is not one. */
export function checkEmail(raw: string): EntryCheck {
  const value = raw.trim().toLowerCase()
  if (value === '') return { ok: false, message: 'Type an email address.' }
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) {
    return { ok: false, message: `"${raw.trim()}" doesn't look like an email address.` }
  }
  return { ok: true, value }
}

/** One typed company domain: lower-cased, or why it can't be one. */
export function checkDomain(raw: string): EntryCheck {
  const value = raw.trim().toLowerCase()
  if (value === '') return { ok: false, message: 'Type a company domain, like company.com.' }
  if (value.includes('@')) {
    return {
      ok: false,
      message: `A company domain is the part after the @, like company.com. Add "${raw.trim()}" under People instead.`,
    }
  }
  if (value.startsWith('.')) {
    return { ok: false, message: 'Write the domain without the leading dot, like company.com.' }
  }
  if (!DOMAIN_PATTERN.test(value)) {
    return { ok: false, message: `"${raw.trim()}" doesn't look like a domain, like company.com.` }
  }
  if (PUBLIC_DOMAINS.has(value)) {
    return {
      ok: false,
      message: `${value} is a public mail provider, so it would let anyone in. Add those people by their email address instead.`,
    }
  }
  return { ok: true, value }
}

/** The list after adding what was typed, and a sentence for anything refused. */
export interface EntriesAdded {
  /** A NEW list — the caller's is never changed (forbidden-pattern #4). */
  entries: string[]
  /** The typed entries that were refused, exactly as typed — kept in the field. */
  rejected: string[]
  /** The first refusal's sentence, or null when everything was added. */
  message: string | null
}

/**
 * Add typed emails or domains to a list: each checked, duplicates ignored, the
 * cap held. Refused entries come back as typed so the field can keep them for
 * the person to correct — a refusal that also erased the input would make them
 * type it again to see what was wrong.
 */
export function addEntries(current: readonly string[], raw: string, kind: 'email' | 'domain'): EntriesAdded {
  const check = kind === 'email' ? checkEmail : checkDomain
  const cap = kind === 'email' ? SHARE_MAX_EMAILS : SHARE_MAX_DOMAINS
  const entries = [...current]
  const rejected: string[] = []
  let message: string | null = null
  for (const typed of splitEntries(raw)) {
    const result = check(typed)
    if (!result.ok) {
      rejected.push(typed)
      message ??= result.message
      continue
    }
    if (entries.includes(result.value)) continue
    if (entries.length >= cap) {
      rejected.push(typed)
      message ??= capMessage(kind)
      continue
    }
    entries.push(result.value)
  }
  return { entries, rejected, message }
}

/** The list without one entry. */
export function removeEntry(current: readonly string[], entry: string): string[] {
  return current.filter((item) => item !== entry)
}

function capMessage(kind: 'email' | 'domain'): string {
  return kind === 'email'
    ? `A page can be shared with at most ${SHARE_MAX_EMAILS} people.`
    : `A page can be shared with at most ${SHARE_MAX_DOMAINS} company domains.`
}

// ── Expiry ────────────────────────────────────────────────────────────────

/** `keep` exists only when managing a share that already has an expiry. */
export type ExpiryChoice = 'keep' | 'never' | '7d' | '30d' | '90d'

export interface ExpiryOption {
  value: ExpiryChoice
  label: string
}

const DAY_MS = 24 * 60 * 60 * 1000

const EXPIRY_DAYS: Readonly<Record<'7d' | '30d' | '90d', number>> = { '7d': 7, '30d': 30, '90d': 90 }

/** "12 Oct 2026" — the date a link stops working, in the reader's locale. */
export function formatDate(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The expiry choices. A share that already expires offers to keep that date —
 * first, and selected — so saving an unrelated change never moves it.
 */
export function expiryOptions(currentExpiresAt: string | null): ExpiryOption[] {
  const fixed: ExpiryOption[] = [
    { value: 'never', label: 'Never' },
    { value: '7d', label: 'In 7 days' },
    { value: '30d', label: 'In 30 days' },
    { value: '90d', label: 'In 90 days' },
  ]
  if (currentExpiresAt === null) return fixed
  return [{ value: 'keep', label: `Keep: ${formatDate(currentExpiresAt)}` }, ...fixed]
}

/** The choice a dialog opens on: keep what is set, else never. */
export function initialExpiry(currentExpiresAt: string | null): ExpiryChoice {
  return currentExpiresAt === null ? 'never' : 'keep'
}

/**
 * The request's `expiresAt` for a choice: an ISO date, null to clear, or
 * undefined to leave the share's expiry as it is. The clock is injected.
 */
export function expiresAtFor(choice: ExpiryChoice, now: number): string | null | undefined {
  if (choice === 'keep') return undefined
  if (choice === 'never') return null
  return new Date(now + EXPIRY_DAYS[choice] * DAY_MS).toISOString()
}

// ── What will be sent ─────────────────────────────────────────────────────

/** "12.4 KB" — sizes as a person reads them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface SentFileRow {
  /** "Artifact page" / "Discovery document". */
  label: string
  /** The file's own name — what is sent, not where it lives. */
  name: string
  size: string
}

export interface SendSummary {
  rows: SentFileRow[]
  total: string
  /** True when the two together exceed what one version may hold. */
  overCap: boolean
  /** Said instead of letting the person press Share on something refused. */
  overCapMessage: string | null
}

/** The "What will be sent" block, from the local facts main read off disk. */
export function sendSummary(local: ShareLocalFacts): SendSummary {
  const rows = local.files.map((file) => ({
    label: PART_LABELS[file.part],
    name: file.name,
    size: formatBytes(file.bytes),
  }))
  const overCap = local.totalBytes > local.maxBytes
  return {
    rows,
    total: formatBytes(local.totalBytes),
    overCap,
    overCapMessage: overCap
      ? `These are ${formatBytes(local.totalBytes)} together; a shared page can hold at most ${formatBytes(local.maxBytes)}.`
      : null,
  }
}

/**
 * What the author was shown — what `reviewed` must carry, read off the facts:
 * each file's hash (what main checks) and size (for display). A missing file
 * yields an empty hash, which main refuses as not reviewed.
 */
export function reviewedFiles(local: ShareLocalFacts): ShareReviewed {
  const fileOf = (part: ShareLocalFile['part']): ShareLocalFile | undefined =>
    local.files.find((file) => file.part === part)
  const walkthrough = fileOf('walkthrough')
  const discovery = fileOf('discovery')
  return {
    walkthroughBytes: walkthrough?.bytes ?? 0,
    discoveryBytes: discovery?.bytes ?? 0,
    walkthroughSha256: walkthrough?.sha256 ?? '',
    discoverySha256: discovery?.sha256 ?? '',
  }
}

// ── The form and its payload ──────────────────────────────────────────────

export type ShareDialogMode = 'publish' | 'manage'

/** What the dialog holds. Lists are already checked; the dialog never stores raw text. */
export interface ShareDialogForm {
  emails: string[]
  domains: string[]
  notify: boolean
  expiry: ExpiryChoice
}

/**
 * The form a dialog opens with. Publishing for the first time starts empty
 * with "Email them" on; re-sharing a revoked page, or managing a live one,
 * starts from the list it had — nobody should have to retype a team.
 *
 * Re-sharing a REVOKED page starts with "Email them" OFF: its list is the one
 * that was cut off, often after a leak, and ticking a box should be what emails
 * them all again — not leaving one ticked.
 */
export function initialForm(share: ShareSummary | null): ShareDialogForm {
  if (share === null) return { emails: [], domains: [], notify: true, expiry: 'never' }
  const live = share.revokedAt === null
  return {
    emails: [...share.access.emails],
    domains: [...share.access.domains],
    notify: live,
    // A revoked share's old expiry means nothing to the re-share.
    expiry: live ? initialExpiry(share.expiresAt) : 'never',
  }
}

export type FormCheck<T> = { ok: true; request: T } | { ok: false; message: string }

export const SHARE_NOBODY_MESSAGE = 'Add at least one person or a company domain.'

/** The access a form names, or why it names nobody. */
function accessOf(form: ShareDialogForm): ShareAccess | null {
  if (form.emails.length === 0 && form.domains.length === 0) return null
  return { emails: [...form.emails], domains: [...form.domains] }
}

/**
 * A publish request from the dialog — always with the list, so a re-share
 * after a revoke says who it is for, and with the sizes the author was shown.
 */
export function buildPublishRequest(
  doc: ShareDocRef,
  local: ShareLocalFacts,
  form: ShareDialogForm,
  now: number,
): FormCheck<SharePublishRequest> {
  const access = accessOf(form)
  if (access === null) return { ok: false, message: SHARE_NOBODY_MESSAGE }
  const summary = sendSummary(local)
  if (summary.overCapMessage !== null) return { ok: false, message: summary.overCapMessage }
  const expiresAt = expiresAtFor(form.expiry, now)
  return {
    ok: true,
    request: {
      rootPath: doc.rootPath,
      docPath: doc.docPath,
      reviewed: reviewedFiles(local),
      access,
      notify: form.notify,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  }
}

/**
 * An update request from the Manage dialog: the whole list (the server
 * REPLACES it), whether to email anyone it adds, and the expiry only when it
 * changed. Emptying the list is refused here — revoking is its own, confirmed
 * act, never the side effect of removing the last name.
 */
export function buildUpdateRequest(
  shareId: string,
  form: ShareDialogForm,
  now: number,
): FormCheck<ShareUpdateRequest> {
  const access = accessOf(form)
  if (access === null) {
    return {
      ok: false,
      message: 'A shared page needs at least one person or company domain. To stop sharing it, revoke the link.',
    }
  }
  const expiresAt = expiresAtFor(form.expiry, now)
  return {
    ok: true,
    request: {
      id: shareId,
      access,
      notify: form.notify,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  }
}

// ── Revoke ────────────────────────────────────────────────────────────────

export const REVOKE_TITLE = 'Stop sharing this page?'
export const REVOKE_BODY =
  'Anyone who opens the link will see that this page is no longer shared. You can share it again later.'
export const REVOKE_CONFIRM_LABEL = 'Revoke link'
export const REVOKE_BUSY_LABEL = 'Revoking…'
