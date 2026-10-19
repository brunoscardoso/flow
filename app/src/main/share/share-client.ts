/**
 * THE PUBLISH CLIENT — the only code in Flow that talks to the share host.
 *
 * It lives in main for one reason: every request is authorised by the author's
 * desktop session token, and that token never leaves this process. The renderer
 * names a discovery (root + repo-relative path) and gets back share STATE —
 * `ShareSummary`, `ShareView[]`, or a refusal carrying one plain sentence.
 *
 * ── WHAT IS READ, AND WHAT IS SENT ──────────────────────────────────────────
 *
 * Exactly two files, both derived here from the discovery path the renderer
 * sent: the discovery markdown and the `.walkthrough.html` beside it. The path
 * must name a discovery doc directly inside `flow/discovery/` or
 * `flow/archive/` of a root the renderer may already address (the readFile
 * gate, allowed-pattern #14). The renderer never sends content, so it cannot
 * smuggle anything else into an upload.
 *
 * EACH FILE IS READ THROUGH `readGuardedFile` (reviews H3, R2-M5, R2-M6, R2-L9,
 * R2-L10): one regular file, never a symlink, FIFO or hard link, in the real
 * discovery/archive directory of the resolved `flow/`, size checked before a
 * byte is read — on every platform, not only where `O_NOFOLLOW` exists.
 *
 * A publish carries the sha256 of each file the author was SHOWN. Both files
 * are re-read, a hash mismatch is refused, and the upload is built from exactly
 * the bytes that were hashed (review L-5).
 *
 * ── A SHARE IS FOUND BY THE PROJECT'S ID, NOT ITS FOLDER NAME ───────────────
 *
 * Every lookup and publish carries the project's stable random id
 * (`share-project-id.ts`, review R2-M3). The folder name rides along as a
 * display label and nothing else.
 *
 * ── NOTHING IS ASKED ABOUT A DISCOVERY THIS MACHINE NEVER SHARED ────────────
 *
 * `get` (what a view does when it opens) asks the share host ONLY when the
 * local record (`share-records.ts`) says this account shared this discovery
 * (review R2-M7). A never-shared discovery sends nothing — not its project, not
 * its name. `check` is the person's explicit "Check sharing status" and is the
 * only call that asks without a record; what it finds is recorded.
 *
 * ── IDENTITY IS READ HERE, AND GATES ONLY THIS ──────────────────────────────
 *
 * This module is a named reader in `identity-is-not-a-gate.test.ts`: publishing
 * is a server feature that needs an owner, so being signed out refuses a share
 * with "Sign in to share". Nothing else in the app changes — the feature view,
 * and everything around it, stays whole signed out.
 *
 * ── THE SERVER IS THE SOURCE OF TRUTH ───────────────────────────────────────
 *
 * Beyond the record of WHICH discoveries were shared, nothing about a share is
 * remembered here except a ~30 s cache of `get`, keyed by (who, project id,
 * slug), so opening the same feature view twice does not ask twice.
 *
 * No default here reaches a real network, a real keychain or a real settings
 * file: `fetch`, the identity source, the project ids and the records are
 * required dependencies (forbidden-pattern #15). Every request runs async with
 * an abort timeout — main answers every window's IPC and must never wait on a
 * socket (allowed-pattern #19). Log lines carry error CODES, never messages,
 * which carry absolute paths.
 */
import { createHash } from 'crypto'
import { basename, join } from 'path'

import type {
  ShareClientRefusalReason,
  ShareGetResult,
  ShareLocalFacts,
  SharePublishRequest,
  ShareReviewed,
  ShareRefusal,
  ShareRevokeRequest,
  ShareSummaryResult,
  ShareUpdateRequest,
  ShareViewsResult,
} from '../../shared/ipc-contract'
import {
  SHARE_MAX_DOMAINS,
  SHARE_MAX_EMAILS,
  SHARE_MAX_PROJECT_LENGTH,
  SHARE_MAX_TITLE_LENGTH,
  SHARE_MAX_VERSION_BYTES,
  SHARE_PROJECT_ID_PATTERN,
  SHARE_REFUSAL_STATUS,
  SHARE_SLUG_PATTERN,
  type PublishInput,
  type ShareAccess,
  type ShareRefusalReason,
  type ShareSummary,
  type ShareUpdateInput,
  type ShareView,
} from '../../shared/share-contract'
import { isWalkthroughPath, walkthroughPathFor } from '../../shared/walkthrough-page'
import type { RejectedSession, SessionRejectionReason } from '../auth/auth-session'
import { isExpired, type StoredIdentity } from '../auth/identity-store'
import { SHARING_UNAVAILABLE, shareLinkOrigin } from './share-endpoint'
import { errorCode, readGuardedFile, type GuardedFileRead, type ShareFileGuard } from './share-file-guard'
import type { ProjectIds } from './share-project-id'
import type { ShareRecordKey, ShareRecords } from './share-records'

export { NotARegularFileError, readGuardedFile, type GuardedFileRead } from './share-file-guard'

/** How long a `get` answer is reused for the same (who, project, slug). */
export const SHARE_GET_CACHE_MS = 30_000

/** A read or a small write. */
const REQUEST_TIMEOUT_MS = 15_000

/** A publish uploads up to `SHARE_MAX_VERSION_BYTES`; give it longer. */
const PUBLISH_TIMEOUT_MS = 60_000

/**
 * A discovery doc's path, repo-relative: one file directly inside
 * `flow/discovery/` or `flow/archive/`, named `discovery_<slug>_v<N>.md`. The
 * slug's own grammar is `SHARE_SLUG_PATTERN`, checked after the match.
 */
const DISCOVERY_DOC_PATTERN = /^flow\/(discovery|archive)\/discovery_([^/\\]+)_v(\d+)\.md$/

/** A share id as the server mints them: opaque base64url. */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

/** One plain sentence per refusal (forbidden-pattern #12: no commands, paths or keys). */
const REFUSAL_MESSAGES: Readonly<Record<ShareClientRefusalReason, string>> = {
  'invalid-request': "The share service couldn't accept that. Check the people and domains, then try again.",
  'public-mail-domain':
    "A public mail provider like gmail.com can't be a company domain. Add those people by their email address instead.",
  'access-required': 'Add at least one person or company domain before sharing.',
  // Only ever the host's answer to a token that WAS sent — so the sign-in this
  // computer held is no longer valid, not merely absent.
  unauthenticated: 'Your Flow sign-in is no longer valid. Sign in again to share.',
  'session-expired': 'Your Flow sign-in has expired. Sign in again to share.',
  'identity-disabled': "This Flow account can't share pages.",
  'not-found': 'This page is not shared.',
  revoked: 'This page was unshared. Choose who can open it to share it again.',
  'too-large':
    'This is too large to share. The page and the discovery together must be under 2 MB, with at most 100 people and 10 domains.',
  'rate-limited': "You've shared a lot in a short time. Try again in a little while.",
  unavailable: 'The share service is having trouble right now. Nothing was changed — try again in a moment.',
  'sharing-unavailable': SHARING_UNAVAILABLE,
  'signed-out': 'Sign in to Flow to share this page.',
  'not-a-discovery': "Only a discovery's artifact can be shared.",
  'page-missing': 'This discovery has no artifact to share yet.',
  unreadable: "Flow couldn't read this discovery's files. Try again in a moment.",
  'changed-since-review': 'The artifact changed after you reviewed it. Check what will be sent and publish again.',
  'not-confirmed': 'Revoking a shared page needs your confirmation.',
  unreachable: "Flow couldn't reach the share service. Check your connection and try again.",
  'project-settings': "Flow couldn't save this project's sharing settings. Nothing was sent — try again in a moment.",
}

/** The server's refusal words, as a set, for reading untrusted bodies. */
const SERVER_REASONS: ReadonlySet<string> = new Set(Object.keys(SHARE_REFUSAL_STATUS))

/**
 * The host's answers that mean "the session you presented is not good" — the
 * only refusals that clear the stored sign-in. A 5xx, `unavailable`, a timeout
 * or a network failure says nothing about the session and clears nothing.
 */
const SESSION_REJECTIONS: ReadonlySet<ShareRefusalReason> = new Set<SessionRejectionReason>([
  'unauthenticated',
  'session-expired',
  'identity-disabled',
])

/** The rejection a refused response carries, or null when it is not one. */
export function sessionRejectionOf(status: number, reason: ShareRefusalReason): SessionRejectionReason | null {
  if (!SESSION_REJECTIONS.has(reason)) return null
  // The word AND its status: a body saying `unauthenticated` on a 503 is the
  // service misbehaving, not a verdict on the session.
  return status === SHARE_REFUSAL_STATUS[reason] ? (reason as SessionRejectionReason) : null
}

export function refusal(reason: ShareClientRefusalReason): ShareRefusal {
  return { ok: false, reason, message: REFUSAL_MESSAGES[reason] }
}

/** The minimum `fetch` this client needs — Node's global satisfies it. */
export type ShareFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
    /**
     * Always `'error'` (review L-4): a 307/308 from the share host would
     * re-send the body — both files — to wherever it points.
     */
    redirect: 'error'
  },
) => Promise<{ status: number; json(): Promise<unknown> }>

const SHA256_HEX = /^[0-9a-f]{64}$/

function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface ShareClientDeps {
  /** The share host's base URL, or null when this build has none. */
  endpoint: () => string | null
  /**
   * WHO IS SIGNED IN — the session token is read from here at the moment of
   * each request and goes nowhere but the Authorization header.
   */
  identity: { load(): StoredIdentity | null }
  /** REQUIRED, never defaulted: a test that forgets it must not reach the network. */
  fetch: ShareFetch
  /** Whether the renderer may address this root (the readFile gate). */
  isKnownRoot: (rootPath: string) => boolean
  /**
   * REQUIRED: each project's stable sharing id. `ensure` WRITES the project's
   * settings, so a test must say which settings it means.
   */
  projectIds: ProjectIds
  /** REQUIRED: what this account has shared, remembered on this machine. */
  records: ShareRecords
  /**
   * REQUIRED, never defaulted (forbidden-pattern #15): called when a session
   * that was really presented is refused by the host (401 `unauthenticated` /
   * `session-expired`, 403 `identity-disabled`), or the stored one is past its
   * expiry. The wiring clears the stored sign-in and tells every window. This
   * client never writes identity itself — it is a READER
   * (`identity-is-not-a-gate.test.ts`).
   */
  onSessionRejected: (rejected: RejectedSession) => void
  /** The project label viewers see; defaults to the root's folder name. */
  projectLabelFor?: (rootPath: string) => string
  /**
   * Injectable for tests; default `readGuardedFile` — reading is not
   * destructive, and the default is the guarded read.
   */
  readFile?: (absPath: string, guard: ShareFileGuard) => Promise<GuardedFileRead>
  now?: () => number
}

/** A validated discovery, resolved to the two files it may send. */
interface ResolvedDiscovery {
  rootPath: string
  project: string
  slug: string
  discoveryVersion: number
  docAbs: string
  pageAbs: string
  docName: string
  pageName: string
  guard: ShareFileGuard
}

/** Both files read, with what the author would be shown. */
interface ReadDiscovery {
  facts: ShareLocalFacts
  /** Null when either file is over the cap — nothing of it was read. */
  upload: {
    walkthroughHtml: string
    discoveryMarkdown: string
    walkthroughSha256: string
    discoverySha256: string
  } | null
}

type Resolved<T> = { ok: true; value: T } | ShareRefusal

/** Who is asking, and how to reach the host. */
interface Session {
  base: string
  token: string
  subject: string
}

export function createShareClient(deps: ShareClientDeps) {
  const now = deps.now ?? (() => Date.now())
  const readFile = deps.readFile ?? ((absPath: string, guard: ShareFileGuard) => readGuardedFile(absPath, guard))
  const projectLabelFor = deps.projectLabelFor ?? ((rootPath: string) => basename(rootPath))

  /** (subject, projectId, slug) → the server's last answer. null = not shared. */
  const cache = new Map<string, { at: number; share: ShareSummary | null }>()

  function cacheKey(key: ShareRecordKey): string {
    return `${key.subject}\u0000${key.projectId}\u0000${key.slug}`
  }

  /** Every cached answer about this share id, replaced by the server's newer one. */
  function replaceCached(subject: string, share: ShareSummary): void {
    for (const [key, entry] of cache) {
      if (key.startsWith(`${subject}\u0000`) && entry.share?.id === share.id) cache.set(key, { at: now(), share })
    }
  }

  /** Drop every cached answer about this share id. */
  function forgetShare(subject: string, id: string): void {
    for (const [key, entry] of cache) {
      if (key.startsWith(`${subject}\u0000`) && entry.share?.id === id) cache.delete(key)
    }
  }

  /** The base URL and a usable session, or why there is none. */
  function session(): Resolved<Session> {
    const base = deps.endpoint()
    if (base === null) return refusal('sharing-unavailable')
    let held: StoredIdentity | null
    try {
      held = deps.identity.load()
    } catch (error) {
      console.warn('[Share] identity unreadable; treating as signed out', { code: errorCode(error) })
      held = null
    }
    if (held === null) return refusal('signed-out')
    if (isExpired(held, now())) {
      rejected({ reason: 'session-expired', token: held.token })
      return refusal('session-expired')
    }
    return { ok: true, value: { base, token: held.token, subject: held.subject } }
  }

  /** Report a refused session. Never lets the report fail the share call. */
  function rejected(session: RejectedSession): void {
    try {
      deps.onSessionRejected(session)
    } catch (error) {
      console.warn('[Share] a refused sign-in could not be reported', { code: errorCode(error) })
    }
  }

  /** Validate root + path and derive the two files. Nothing is read yet. */
  function resolveDiscovery(rootPath: unknown, docPath: unknown): Resolved<ResolvedDiscovery> {
    if (typeof rootPath !== 'string' || rootPath === '' || typeof docPath !== 'string') {
      return refusal('not-a-discovery')
    }
    if (!deps.isKnownRoot(rootPath)) return refusal('not-a-discovery')
    const match = DISCOVERY_DOC_PATTERN.exec(docPath)
    if (match === null || docPath.includes('..')) return refusal('not-a-discovery')
    const subdir = match[1] === 'archive' ? 'archive' : 'discovery'
    const slug = match[2] ?? ''
    const discoveryVersion = Number(match[3])
    if (!SHARE_SLUG_PATTERN.test(slug) || !Number.isSafeInteger(discoveryVersion)) {
      return refusal('not-a-discovery')
    }
    const pagePath = walkthroughPathFor(docPath)
    // The same lexical rule the flow-page scheme serves by — one gate.
    if (pagePath === null || !isWalkthroughPath(pagePath)) return refusal('not-a-discovery')
    const project = projectLabelFor(rootPath).trim().slice(0, SHARE_MAX_PROJECT_LENGTH)
    if (project === '') return refusal('not-a-discovery')
    return {
      ok: true,
      value: {
        rootPath,
        project,
        slug,
        discoveryVersion,
        docAbs: join(rootPath, docPath),
        pageAbs: join(rootPath, pagePath),
        docName: basename(docPath),
        pageName: basename(pagePath),
        guard: { flowDir: join(rootPath, 'flow'), subdir, maxBytes: SHARE_MAX_VERSION_BYTES },
      },
    }
  }

  /** Read EXACTLY the two files, and what the author would be shown about them. */
  async function readDiscovery(doc: ResolvedDiscovery): Promise<Resolved<ReadDiscovery>> {
    let page: GuardedFileRead
    try {
      page = await readFile(doc.pageAbs, doc.guard)
    } catch (error) {
      console.warn('[Share] walkthrough page unreadable', { page: doc.pageName, code: errorCode(error) })
      // A missing page is "no feature view yet"; anything else — a symlink, a
      // FIFO, a directory, a hard link, a moved directory — is refused as
      // unreadable, never followed.
      return refusal(isMissing(error) ? 'page-missing' : 'unreadable')
    }
    let docRead: GuardedFileRead
    try {
      docRead = await readFile(doc.docAbs, doc.guard)
    } catch (error) {
      console.warn('[Share] discovery unreadable', { doc: doc.docName, code: errorCode(error) })
      return refusal('unreadable')
    }
    // Over the cap: reported by size, never read (review R2-L10).
    if (page.content === null || docRead.content === null) {
      const walkthroughBytes = page.content === null ? page.size : page.content.length
      const discoveryBytes = docRead.content === null ? docRead.size : docRead.content.length
      return {
        ok: true,
        value: {
          upload: null,
          facts: {
            project: doc.project,
            slug: doc.slug,
            title: docRead.content === null ? doc.slug : titleOf(docRead.content.toString('utf8'), doc.slug),
            discoveryVersion: doc.discoveryVersion,
            pageModifiedAt: new Date(page.mtimeMs).toISOString(),
            files: [
              { part: 'walkthrough', name: doc.pageName, bytes: walkthroughBytes, sha256: '' },
              { part: 'discovery', name: doc.docName, bytes: discoveryBytes, sha256: '' },
            ],
            totalBytes: walkthroughBytes + discoveryBytes,
            maxBytes: SHARE_MAX_VERSION_BYTES,
          },
        },
      }
    }
    const walkthroughHtml = page.content.toString('utf8')
    const discoveryMarkdown = docRead.content.toString('utf8')
    const walkthroughBytes = Buffer.byteLength(walkthroughHtml, 'utf8')
    const discoveryBytes = Buffer.byteLength(discoveryMarkdown, 'utf8')
    const walkthroughSha256 = sha256Of(page.content)
    const discoverySha256 = sha256Of(docRead.content)
    return {
      ok: true,
      value: {
        upload: { walkthroughHtml, discoveryMarkdown, walkthroughSha256, discoverySha256 },
        facts: {
          project: doc.project,
          slug: doc.slug,
          title: titleOf(discoveryMarkdown, doc.slug),
          discoveryVersion: doc.discoveryVersion,
          pageModifiedAt: new Date(page.mtimeMs).toISOString(),
          files: [
            { part: 'walkthrough', name: doc.pageName, bytes: walkthroughBytes, sha256: walkthroughSha256 },
            { part: 'discovery', name: doc.docName, bytes: discoveryBytes, sha256: discoverySha256 },
          ],
          totalBytes: walkthroughBytes + discoveryBytes,
          maxBytes: SHARE_MAX_VERSION_BYTES,
        },
      },
    }
  }

  /** The project's id if it has one — never mints, never fails loudly. */
  async function existingProjectId(rootPath: string): Promise<string | null> {
    try {
      return await deps.projectIds.existing(rootPath)
    } catch (error) {
      console.warn('[Share] project sharing id unreadable', { code: errorCode(error) })
      return null
    }
  }

  /** The project's id, minted if needed — or a refusal when it can't be stored. */
  async function ensureProjectId(rootPath: string): Promise<Resolved<string>> {
    try {
      const id = await deps.projectIds.ensure(rootPath)
      if (!SHARE_PROJECT_ID_PATTERN.test(id)) return refusal('project-settings')
      return { ok: true, value: id }
    } catch (error) {
      console.warn('[Share] project sharing id could not be stored', { code: errorCode(error) })
      return refusal('project-settings')
    }
  }

  /** The record says, or null. A record that can't be read is "no record". */
  async function recorded(key: ShareRecordKey): Promise<string | null> {
    try {
      return await deps.records.get(key)
    } catch (error) {
      console.warn('[Share] share records unreadable', { code: errorCode(error) })
      return null
    }
  }

  /** Writes to the record never fail a share call; they are logged. */
  async function quietly(write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error) {
      console.warn('[Share] share record not updated', { code: errorCode(error) })
    }
  }

  /**
   * Ask the host about one discovery, by project id and slug, and keep the
   * record in step with the answer: found → recorded; "no such share" → the
   * record is removed.
   */
  async function lookUp(
    auth: Session,
    key: ShareRecordKey,
    local: ShareLocalFacts,
    useCache: boolean,
  ): Promise<ShareGetResult> {
    const cached = cache.get(cacheKey(key))
    if (useCache && cached !== undefined && now() - cached.at < SHARE_GET_CACHE_MS) {
      return { ok: true, share: cached.share, local }
    }
    const query = `?projectId=${encodeURIComponent(key.projectId)}&slug=${encodeURIComponent(key.slug)}`
    const answer = await request(auth.base, auth.token, 'GET', `/api/shares${query}`, undefined, REQUEST_TIMEOUT_MS)
    if (!answer.ok) {
      // NOT SHARED IS AN ANSWER, not a failure — and the record is stale.
      if (answer.reason === 'not-found') {
        await quietly(() => deps.records.remove(key))
        cache.set(cacheKey(key), { at: now(), share: null })
        return { ok: true, share: null, local }
      }
      return answer
    }
    const share = summaryOf(answer.json, linkOrigin(auth.base))
    if (share === null) return badResponse('GET /api/shares')
    await quietly(() => deps.records.set(key, share.id))
    cache.set(cacheKey(key), { at: now(), share })
    return { ok: true, share, local }
  }

  /** One request to the share host. Never throws; a failure is a refusal. */
  async function request(
    base: string,
    token: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ ok: true; status: number; json: unknown } | ShareRefusal> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        // Header only — never a query parameter, never a body field (contract §2).
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      }
      const init: Parameters<ShareFetch>[1] = { method, headers, signal: controller.signal, redirect: 'error' }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await deps.fetch(`${base}${path}`, init)
      let json: unknown = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, json }
      }
      // A 3xx can only arrive from a fetch that ignored `redirect: 'error'`;
      // it is never followed and never read as an answer.
      if (response.status >= 300 && response.status < 400) return refusal('unavailable')
      const reason = serverReason(json)
      const rejection = sessionRejectionOf(response.status, reason)
      if (rejection !== null) rejected({ reason: rejection, token })
      return refusal(reason)
    } catch (error) {
      if (isRedirectRefusal(error)) {
        // The host answered — with a redirect we refused to follow. That is the
        // service misbehaving, not the network being down.
        console.warn('[Share] share host answered with a redirect; not followed', { method, path: path.split('?')[0] })
        return refusal('unavailable')
      }
      // Offline, DNS, TLS, or our own abort: the host did not answer. Logged
      // by code only — the headers carry the token, the message can carry a URL.
      console.warn('[Share] share host unreachable', {
        method,
        path: path.split('?')[0],
        aborted: controller.signal.aborted,
        code: errorCode(error),
      })
      return refusal('unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * What a view asks when it opens: the local facts the Share dialog shows,
     * and the author's share — asked of the host ONLY when this machine's
     * record says this account shared this discovery (review R2-M7). A
     * never-shared discovery answers `share: null` and sends nothing.
     */
    async get(rootPath: string, docPath: string): Promise<ShareGetResult> {
      const doc = resolveDiscovery(rootPath, docPath)
      if (!doc.ok) return doc
      const auth = session()
      if (!auth.ok) return auth
      const read = await readDiscovery(doc.value)
      if (!read.ok) return read
      const local = read.value.facts

      const projectId = await existingProjectId(doc.value.rootPath)
      if (projectId === null) return { ok: true, share: null, local }
      const key: ShareRecordKey = { subject: auth.value.subject, projectId, slug: doc.value.slug }
      if ((await recorded(key)) === null) return { ok: true, share: null, local }
      return lookUp(auth.value, key, local, true)
    },

    /**
     * "Check sharing status" — a person pressed it. Asks the host whether this
     * discovery is shared even without a record (a share made from another
     * computer), and records what it finds. Never cached.
     */
    async check(rootPath: string, docPath: string): Promise<ShareGetResult> {
      const doc = resolveDiscovery(rootPath, docPath)
      if (!doc.ok) return doc
      const auth = session()
      if (!auth.ok) return auth
      const read = await readDiscovery(doc.value)
      if (!read.ok) return read
      const projectId = await ensureProjectId(doc.value.rootPath)
      if (!projectId.ok) return projectId
      const key: ShareRecordKey = { subject: auth.value.subject, projectId: projectId.value, slug: doc.value.slug }
      return lookUp(auth.value, key, read.value.facts, false)
    },

    /** Publish this discovery, or a new version of it to the same link. */
    async publish(input: SharePublishRequest): Promise<ShareSummaryResult> {
      const doc = resolveDiscovery(input.rootPath, input.docPath)
      if (!doc.ok) return doc
      const reviewed = cleanReviewed(input.reviewed)
      if (reviewed === null) return refusal('changed-since-review')
      const access = input.access === undefined ? undefined : cleanAccess(input.access)
      if (access === null) return refusal('invalid-request')
      if (access !== undefined && overCaps(access)) return refusal('too-large')
      const expiresAt = cleanExpiry(input.expiresAt)
      if (expiresAt === null && input.expiresAt !== null && input.expiresAt !== undefined) {
        return refusal('invalid-request')
      }
      const auth = session()
      if (!auth.ok) return auth
      const read = await readDiscovery(doc.value)
      if (!read.ok) return read
      const upload = read.value.upload
      if (upload === null || read.value.facts.totalBytes > SHARE_MAX_VERSION_BYTES) return refusal('too-large')
      // CONTENT, not size: a same-size rewrite between look and press is a
      // different page (review L-5). The body below is built from exactly the
      // bytes these hashes were computed over.
      if (
        upload.walkthroughSha256 !== reviewed.walkthroughSha256 ||
        upload.discoverySha256 !== reviewed.discoverySha256
      ) {
        return refusal('changed-since-review')
      }
      const projectId = await ensureProjectId(doc.value.rootPath)
      if (!projectId.ok) return projectId
      const key: ShareRecordKey = { subject: auth.value.subject, projectId: projectId.value, slug: doc.value.slug }

      const body: PublishInput = {
        projectId: projectId.value,
        project: read.value.facts.project,
        slug: read.value.facts.slug,
        title: read.value.facts.title,
        discoveryVersion: read.value.facts.discoveryVersion,
        pageModifiedAt: read.value.facts.pageModifiedAt,
        walkthroughHtml: upload.walkthroughHtml,
        discoveryMarkdown: upload.discoveryMarkdown,
        notify: input.notify === true,
        ...(access === undefined ? {} : { access }),
        ...(input.expiresAt === undefined ? {} : { expiresAt }),
      }
      const answer = await request(auth.value.base, auth.value.token, 'POST', '/api/shares', body, PUBLISH_TIMEOUT_MS)
      if (!answer.ok) {
        // Revoked elsewhere: what this window remembers is stale (review H4).
        // The RECORD stays — the view says "unshared" from it.
        if (answer.reason === 'revoked') cache.delete(cacheKey(key))
        return answer
      }
      const share = summaryOf(answer.json, linkOrigin(auth.value.base))
      if (share === null) return badResponse('POST /api/shares')
      await quietly(() => deps.records.set(key, share.id))
      cache.set(cacheKey(key), { at: now(), share })
      return withSkipped(share, answer.json)
    },

    /** Change who may open a share, or its expiry. Never revokes. */
    async updateAccess(input: ShareUpdateRequest): Promise<ShareSummaryResult> {
      if (!isShareId(input.id)) return refusal('invalid-request')
      const body: ShareUpdateInput = {}
      if (input.access !== undefined) {
        const access = cleanAccess(input.access)
        if (access === null) return refusal('invalid-request')
        if (overCaps(access)) return refusal('too-large')
        body.access = access
      }
      if (input.notify !== undefined) body.notify = input.notify === true
      if (input.expiresAt !== undefined) {
        const expiresAt = cleanExpiry(input.expiresAt)
        if (expiresAt === null && input.expiresAt !== null) return refusal('invalid-request')
        body.expiresAt = expiresAt
      }
      // `revoke` is deliberately never copied: revoking has its own call.
      if (body.access === undefined && body.expiresAt === undefined) return refusal('invalid-request')
      return patch(input.id, body)
    },

    /**
     * Revoke a share. DESTRUCTIVE, so it needs `confirmed: true` from a caller
     * that asked a person (forbidden-pattern #15) — nothing else will do it.
     * The record is KEPT, so the view can say the page is unshared.
     */
    async revoke(input: ShareRevokeRequest): Promise<ShareSummaryResult> {
      if ((input.confirmed as unknown) !== true) return refusal('not-confirmed')
      if (!isShareId(input.id)) return refusal('invalid-request')
      return patch(input.id, { revoke: true })
    },

    /** Who has opened a share, most recent first. */
    async views(id: string): Promise<ShareViewsResult> {
      if (!isShareId(id)) return refusal('invalid-request')
      const auth = session()
      if (!auth.ok) return auth
      const answer = await request(
        auth.value.base,
        auth.value.token,
        'GET',
        `/api/shares/${encodeURIComponent(id)}/views`,
        undefined,
        REQUEST_TIMEOUT_MS,
      )
      if (!answer.ok) return answer
      const views = (answer.json as { views?: unknown } | null)?.views
      if (!Array.isArray(views) || !views.every(isShareView)) return badResponse('GET views')
      return { ok: true, views }
    },
  }

  async function patch(id: string, body: ShareUpdateInput): Promise<ShareSummaryResult> {
    const auth = session()
    if (!auth.ok) return auth
    const answer = await request(
      auth.value.base,
      auth.value.token,
      'PATCH',
      `/api/shares/${encodeURIComponent(id)}`,
      body,
      REQUEST_TIMEOUT_MS,
    )
    if (!answer.ok) {
      if (answer.reason === 'revoked') forgetShare(auth.value.subject, id)
      // The host has no such share for this account: the record is stale.
      if (answer.reason === 'not-found') {
        forgetShare(auth.value.subject, id)
        await quietly(() => deps.records.removeId(auth.value.subject, id))
      }
      return answer
    }
    const share = summaryOf(answer.json, linkOrigin(auth.value.base))
    if (share === null) return badResponse('PATCH /api/shares')
    replaceCached(auth.value.subject, share)
    return withSkipped(share, answer.json)
  }
}

/**
 * A success, with how many people the server did not email because of its
 * sending limits (review R2-L5). Read defensively: anything but a positive
 * whole number is 0, and 0 is left out.
 */
function withSkipped(share: ShareSummary, json: unknown): ShareSummaryResult {
  const skipped = invitesSkippedOf(json)
  return skipped > 0 ? { ok: true, share, invitesSkipped: skipped } : { ok: true, share }
}

export function invitesSkippedOf(json: unknown): number {
  const value = (json as { invitesSkipped?: unknown } | null)?.invitesSkipped
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** The contract's summary fields only — extra response fields never ride along into state. */
function summaryOf(value: unknown, expectedOrigin: string): ShareSummary | null {
  if (!isShareSummary(value, expectedOrigin)) return null
  return {
    id: value.id,
    url: value.url,
    project: value.project,
    slug: value.slug,
    title: value.title,
    version: value.version,
    discoveryVersion: value.discoveryVersion,
    pageModifiedAt: value.pageModifiedAt,
    publishedAt: value.publishedAt,
    access: { emails: [...value.access.emails], domains: [...value.access.domains] },
    accessCount: value.accessCount,
    revokedAt: value.revokedAt,
    expiresAt: value.expiresAt,
  }
}

export type ShareClient = ReturnType<typeof createShareClient>

/** The origin a share link from this endpoint must have; '' never matches. */
function linkOrigin(base: string): string {
  return shareLinkOrigin(base) ?? ''
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Node's fetch with `redirect: 'error'` rejects a redirect with
 * `TypeError('fetch failed', { cause: Error('unexpected redirect') })`.
 */
function isRedirectRefusal(error: unknown): boolean {
  // Duck-typed, not `instanceof Error`: undici's error can come from another
  // realm (a vm context, a worker), where `instanceof` is false.
  const cause = (error as { cause?: unknown } | null)?.cause
  let message = ''
  if (typeof cause === 'string') message = cause
  else if (typeof (cause as { message?: unknown } | null)?.message === 'string') message = (cause as { message: string }).message
  return message === 'unexpected redirect' || /\bredirect\b/i.test(message)
}

/** IPC input is untrusted: the reviewed hashes must be sha256 hex, or nothing was reviewed. */
function cleanReviewed(value: unknown): ShareReviewed | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const walkthroughSha256 = v['walkthroughSha256']
  const discoverySha256 = v['discoverySha256']
  if (typeof walkthroughSha256 !== 'string' || !SHA256_HEX.test(walkthroughSha256)) return null
  if (typeof discoverySha256 !== 'string' || !SHA256_HEX.test(discoverySha256)) return null
  return {
    walkthroughBytes: typeof v['walkthroughBytes'] === 'number' ? v['walkthroughBytes'] : 0,
    discoveryBytes: typeof v['discoveryBytes'] === 'number' ? v['discoveryBytes'] : 0,
    walkthroughSha256,
    discoverySha256,
  }
}

/** A 2xx whose body is not the contract's shape: logged, and shown as trouble. */
function badResponse(what: string): ShareRefusal {
  console.warn('[Share] share host answered with an unexpected shape', { what })
  return refusal('unavailable')
}

/** The server's refusal word from an untrusted body; anything else is trouble. */
function serverReason(json: unknown): ShareRefusalReason {
  const error = (json as { error?: unknown } | null)?.error
  return typeof error === 'string' && SERVER_REASONS.has(error) ? (error as ShareRefusalReason) : 'unavailable'
}

/** The discovery's first `# ` heading, else its slug — capped to the contract. */
export function titleOf(markdown: string, slug: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1]?.trim() ?? ''
  const title = heading === '' ? slug : heading
  return title.slice(0, SHARE_MAX_TITLE_LENGTH)
}

/**
 * IPC input is untrusted: arrays of strings, trimmed and lower-cased (the
 * server does the same), blanks dropped. null when the shape is wrong.
 */
function cleanAccess(access: unknown): ShareAccess | null {
  if (typeof access !== 'object' || access === null) return null
  const { emails, domains } = access as { emails?: unknown; domains?: unknown }
  const clean = (list: unknown): string[] | null => {
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) return null
    return [...new Set((list as string[]).map((item) => item.trim().toLowerCase()).filter((item) => item !== ''))]
  }
  const cleanEmails = clean(emails)
  const cleanDomains = clean(domains)
  if (cleanEmails === null || cleanDomains === null) return null
  return { emails: cleanEmails, domains: cleanDomains }
}

function overCaps(access: ShareAccess): boolean {
  return access.emails.length > SHARE_MAX_EMAILS || access.domains.length > SHARE_MAX_DOMAINS
}

/** An ISO date string normalised, or null for "none" / unparseable. */
function cleanExpiry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

function isShareId(id: unknown): id is string {
  return typeof id === 'string' && SHARE_ID_PATTERN.test(id)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * A server answer is untrusted until it has the summary's shape — and its link
 * points at the share host itself (`expectedOrigin`, the endpoint's origin;
 * review L-6). A link anywhere else is shown and copied to people, so it is
 * refused rather than trusted.
 */
export function isShareSummary(value: unknown, expectedOrigin: string): value is ShareSummary {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const access = v['access'] as Record<string, unknown> | null | undefined
  return (
    isShareId(v['id']) &&
    typeof v['url'] === 'string' &&
    isLinkOn(v['url'], expectedOrigin) &&
    typeof v['project'] === 'string' &&
    typeof v['slug'] === 'string' &&
    typeof v['title'] === 'string' &&
    typeof v['version'] === 'number' &&
    typeof v['discoveryVersion'] === 'number' &&
    typeof v['pageModifiedAt'] === 'string' &&
    typeof v['publishedAt'] === 'string' &&
    typeof access === 'object' &&
    access !== null &&
    isStringList(access['emails']) &&
    isStringList(access['domains']) &&
    typeof v['accessCount'] === 'number' &&
    (v['revokedAt'] === null || typeof v['revokedAt'] === 'string') &&
    (v['expiresAt'] === null || typeof v['expiresAt'] === 'string')
  )
}

function isLinkOn(url: string, expectedOrigin: string): boolean {
  if (expectedOrigin === '') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.origin === expectedOrigin
  } catch {
    return false
  }
}

function isShareView(value: unknown): value is ShareView {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['email'] === 'string' &&
    typeof v['firstViewedAt'] === 'string' &&
    typeof v['lastViewedAt'] === 'string'
  )
}
