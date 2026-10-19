/**
 * THE SHARE API'S SHAPES — what Flow sends to planflow.sh and what it gets back
 * when an author shares a discovery's feature view.
 *
 * TWO REPOSITORIES, ONE BLOCK. The web side (`plan-flow-lp`) carries a copy of
 * everything between the BEGIN/END markers below in
 * `plan-flow-lp/src/lib/share/contract.ts`, byte for byte. Only the header above
 * the markers may differ. Change the block here, copy it there, and update
 * `flow/contracts/share-api_contract.md` in the same change — the contract
 * document is the prose, this block is the part a compiler holds both sides to.
 *
 * DOM-free and node-free on purpose: main (the publish client) and the renderer
 * (the Share dialog) both import it. Nothing in here is a secret, and nothing in
 * here may become one — the desktop session token never appears in these types,
 * because these types are what crosses IPC.
 */

// ── BEGIN SHARE CONTRACT TYPES ──────────────────────────────────────────────

/** Bumped when a shape below changes incompatibly. Not sent on the wire. */
export const SHARE_CONTRACT_VERSION = 1

/** One version's upload cap: walkthrough page + discovery markdown, UTF-8 bytes. */
export const SHARE_MAX_VERSION_BYTES = 2 * 1024 * 1024

/** At most this many people on one share's list. */
export const SHARE_MAX_EMAILS = 100

/** At most this many company domains on one share. */
export const SHARE_MAX_DOMAINS = 10

/** A share's title, as the author's discovery names it. */
export const SHARE_MAX_TITLE_LENGTH = 200

/** The project label shown to viewers and used to find the share again. */
export const SHARE_MAX_PROJECT_LENGTH = 200

/** A discovery slug: what sits between `discovery_` and `_v<N>.md`. */
export const SHARE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/

/**
 * A project's stable, random sharing identity: 32 lower-case hex characters,
 * minted by Flow once per project and kept in the project's own settings. A
 * share is found by (author, projectId, slug) — never by the folder name,
 * which two unrelated repos can share (review R2-M3).
 */
export const SHARE_PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/

/** How long a content token lives: long enough to load a frame, no longer. */
export const SHARE_CONTENT_TOKEN_TTL_MS = 2 * 60_000

/**
 * Mail providers anyone can sign up to — the big ones and their regional
 * variants, the privacy and alias relays, and the large ISPs. As a COMPANY
 * DOMAIN each would mean "anyone with a free mailbox", so neither side accepts
 * one in `domains`. A single address at one of them is fine in `emails`.
 *
 * Embedded, not fetched: a list that changes is a contract change on both
 * sides. The server additionally refuses a bare public suffix (`co.uk`,
 * `com.br`) as a domain — a domain must have its own label before one.
 */
export const PUBLIC_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.co.uk',
  'outlook.fr',
  'outlook.de',
  'outlook.es',
  'outlook.it',
  'outlook.jp',
  'outlook.com.br',
  'outlook.com.au',
  'outlook.in',
  'outlook.ie',
  'outlook.be',
  'outlook.at',
  'outlook.dk',
  'outlook.sa',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.es',
  'hotmail.it',
  'hotmail.nl',
  'hotmail.be',
  'hotmail.ca',
  'hotmail.co.jp',
  'hotmail.com.br',
  'hotmail.com.ar',
  'hotmail.com.mx',
  'hotmail.com.au',
  'hotmail.co.in',
  'hotmail.se',
  'hotmail.no',
  'hotmail.dk',
  'hotmail.fi',
  'hotmail.gr',
  'hotmail.ch',
  'hotmail.at',
  'hotmail.cl',
  'hotmail.co.za',
  'live.com',
  'live.co.uk',
  'live.fr',
  'live.de',
  'live.it',
  'live.nl',
  'live.be',
  'live.ca',
  'live.com.au',
  'live.com.mx',
  'live.com.ar',
  'live.cl',
  'live.se',
  'live.no',
  'live.dk',
  'live.ie',
  'live.at',
  'live.jp',
  'live.co.za',
  'live.in',
  'msn.com',
  'passport.com',
  'windowslive.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.es',
  'yahoo.it',
  'yahoo.ca',
  'yahoo.co.in',
  'yahoo.in',
  'yahoo.co.jp',
  'yahoo.com.br',
  'yahoo.com.ar',
  'yahoo.com.mx',
  'yahoo.com.au',
  'yahoo.co.nz',
  'yahoo.com.sg',
  'yahoo.com.hk',
  'yahoo.com.tw',
  'yahoo.com.ph',
  'yahoo.co.id',
  'yahoo.com.vn',
  'yahoo.gr',
  'yahoo.ie',
  'yahoo.se',
  'yahoo.dk',
  'yahoo.no',
  'yahoo.fi',
  'yahoo.pl',
  'yahoo.ro',
  'yahoo.co.th',
  'yahoo.co.za',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'aol.co.uk',
  'aol.fr',
  'aol.de',
  'aim.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'tutanota.com',
  'tutanota.de',
  'tutamail.com',
  'tuta.io',
  'tuta.com',
  'keemail.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'gmx.at',
  'gmx.ch',
  'gmx.fr',
  'gmx.co.uk',
  'gmx.us',
  'gmx.es',
  'gmx.it',
  'web.de',
  'mail.com',
  'email.com',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'internet.ru',
  'yandex.com',
  'yandex.ru',
  'yandex.ua',
  'yandex.by',
  'yandex.kz',
  'ya.ru',
  'zoho.com',
  'zohomail.com',
  'zohomail.eu',
  'zohomail.in',
  'fastmail.com',
  'fastmail.fm',
  'fastmail.net',
  'hey.com',
  'duck.com',
  'simplelogin.com',
  'simplelogin.co',
  'simplelogin.fr',
  'aleeas.com',
  'slmail.me',
  'passmail.net',
  'passmail.com',
  'passinbox.com',
  'privaterelay.appleid.com',
  'anonaddy.com',
  'anonaddy.me',
  'addy.io',
  'mailfence.com',
  'posteo.de',
  'posteo.net',
  'disroot.org',
  'riseup.net',
  'runbox.com',
  'startmail.com',
  'hushmail.com',
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'yeah.net',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'aliyun.com',
  '139.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'kakao.com',
  'nate.com',
  'rediffmail.com',
  'libero.it',
  'virgilio.it',
  'tiscali.it',
  'alice.it',
  'tin.it',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'laposte.net',
  'sfr.fr',
  'neuf.fr',
  't-online.de',
  'freenet.de',
  'arcor.de',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'ntlworld.com',
  'talktalk.net',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'optonline.net',
  'shaw.ca',
  'rogers.com',
  'sympatico.ca',
  'bigpond.com',
  'optusnet.com.au',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'ig.com.br',
  'seznam.cz',
  'centrum.cz',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'interia.pl',
]

/**
 * Who may open a share. A verified email is let in when it is listed in
 * `emails`, or when the part after its `@` equals one of `domains`. Both are
 * stored and compared lower-cased; a domain has no `@` and no leading dot.
 */
export interface ShareAccess {
  emails: string[]
  domains: string[]
}

/** The two things a share ever holds. Nothing else from a project is sent. */
export type SharePart = 'walkthrough' | 'discovery'

/**
 * `POST /api/shares` — publish a discovery's feature view, or a new version of
 * one already shared. The server finds the share by (author, project, slug), so
 * a later publish of the same discovery keeps the same id and the same link.
 */
export interface PublishInput {
  /** The project's stable sharing identity (`SHARE_PROJECT_ID_PATTERN`). The
   *  lookup key — two projects never share a share, whatever their names. */
  projectId: string
  /** A label for the project, chosen by Flow; viewers see it in the frame.
   *  Display only — never part of how a share is found. */
  project: string
  /** The discovery's slug (`SHARE_SLUG_PATTERN`). */
  slug: string
  /** What viewers see as the page's title. */
  title: string
  /** The `_v<N>` of the discovery being published. */
  discoveryVersion: number
  /** When the walkthrough page was last written, ISO 8601. */
  pageModifiedAt: string
  /** The walkthrough page, exactly as written beside the discovery. */
  walkthroughHtml: string
  /** The discovery document, exactly as written. */
  discoveryMarkdown: string
  /**
   * Who may open it. Required on the first publish; omitted on a later one
   * keeps the list as it is; given, it REPLACES the list.
   */
  access?: ShareAccess
  /** Email people newly added by this request. */
  notify: boolean
  /** ISO 8601, or null for no expiry. Omitted on a later publish keeps it. */
  expiresAt?: string | null
}

/**
 * What `POST /api/shares` and `PATCH /api/shares/[id]` answer: the share, plus
 * how many newly added people were NOT emailed (sending limits, a recent
 * invite, a failed send, or a revoked share). Flow tells the author so they
 * can send the link themselves (review R2-L5).
 */
export type ShareWriteResponse = ShareSummary & { invitesSkipped: number }

/** `PATCH /api/shares/[id]` — every field optional; at least one is required. */
export interface ShareUpdateInput {
  /** Replaces the list. */
  access?: ShareAccess
  /** Email people newly added by `access`. Default false. */
  notify?: boolean
  /** ISO 8601 sets an expiry; null clears it. */
  expiresAt?: string | null
  /** Revoke. There is no un-revoke here; publishing again re-shares. */
  revoke?: true
}

/** What the server says about one share. Every success returns this. */
export interface ShareSummary {
  /** Opaque, unguessable, stable across versions. */
  id: string
  /** `https://planflow.sh/v/<id>` — the link the author copies. */
  url: string
  project: string
  slug: string
  title: string
  /** The live version: 1 for the first publish, +1 for each later one. */
  version: number
  /** The discovery `_v<N>` the live version was published from. */
  discoveryVersion: number
  /** The walkthrough page's write time the live version was published from. */
  pageModifiedAt: string
  /** When the live version was published, ISO 8601. */
  publishedAt: string
  access: ShareAccess
  /** `access.emails.length + access.domains.length` — "Shared with N". */
  accessCount: number
  /** ISO 8601 when revoked, else null. */
  revokedAt: string | null
  /** ISO 8601, or null for no expiry. */
  expiresAt: string | null
}

/** One person who has opened a share. */
export interface ShareView {
  email: string
  firstViewedAt: string
  lastViewedAt: string
}

/** `GET /api/shares/[id]/views`. Most recently viewed first. */
export interface ShareViewsResponse {
  views: ShareView[]
}

/**
 * WHY THE SERVER SAID NO. Sent as the `error` of every non-2xx body, so a
 * caller branches on a known word instead of reading prose. Flow turns each one
 * into a plain sentence; the server never sends a sentence.
 */
export type ShareRefusalReason =
  /** 400 — the body or query is not the shape above. Never echoes the input. */
  | 'invalid-request'
  /** 400 — a public mail provider was given as a company domain. */
  | 'public-mail-domain'
  /** 400 — the first publish of a share carried no `access`. */
  | 'access-required'
  /** 401 — no bearer token, or one that does not verify. */
  | 'unauthenticated'
  /** 401 — the token verified but has expired. Sign in again. */
  | 'session-expired'
  /** 403 — the identity behind the token has been disabled. */
  | 'identity-disabled'
  /** 404 — no such share for this author. Someone else's share answers the
   *  same, so a share id never reveals that it exists (review L-1). */
  | 'not-found'
  /** 409 — the share is revoked; only an explicit re-share (one that sends
   *  `access`) brings it back. A plain update never does (review H4). */
  | 'revoked'
  /** 413 — the version is over `SHARE_MAX_VERSION_BYTES`, or a list is over its cap. */
  | 'too-large'
  /** 429 — too many publishes or invites. Carries no detail. */
  | 'rate-limited'
  /** 503 — storage, database or mail is unreachable. Nothing was changed. */
  | 'unavailable'

/** The body of every refusal. */
export interface ShareErrorBody {
  error: ShareRefusalReason
}

/** The HTTP status each refusal is sent with. One mapping, both sides. */
export const SHARE_REFUSAL_STATUS: Readonly<Record<ShareRefusalReason, number>> = {
  'invalid-request': 400,
  'public-mail-domain': 400,
  'access-required': 400,
  unauthenticated: 401,
  'session-expired': 401,
  'identity-disabled': 403,
  'not-found': 404,
  revoked: 409,
  'too-large': 413,
  'rate-limited': 429,
  unavailable: 503,
}

/**
 * What planflow.sh signs to let `usercontent.planflow.sh` serve one part of one
 * version to one viewer. Never used by Flow; here so the claim names are fixed
 * in one place.
 */
export interface ContentTokenClaims {
  /** Share id. */
  share: string
  /** Share version (not the discovery's `_v<N>`). */
  version: number
  /** An OPAQUE reference to the viewer — HMAC(CONTENT_SECRET,
   *  'viewer:' + share + ':' + email), never the email. The token rides in a
   *  URL the shared page's own script can read, so it must carry nothing
   *  about who is looking (review H1), and the share id inside the HMAC keeps
   *  one viewer's refs unlinkable across shares (review R2-L6). */
  viewerRef: string
  /** An OPAQUE reference to the viewer's mail domain — HMAC(CONTENT_SECRET,
   *  'domain:' + share + ':' + domain). Lets the content host re-check a domain grant against the live
   *  list without ever learning the domain. */
  domainRef: string
  part: SharePart
  /** Expiry, milliseconds since the epoch. */
  exp: number
}

// ── END SHARE CONTRACT TYPES ────────────────────────────────────────────────
