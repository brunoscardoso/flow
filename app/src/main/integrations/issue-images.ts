// THE PICTURES ON A TICKET — finding them, and deciding which may be fetched.
//
// A screenshot is most of what a bug report says. Every tracker carries them
// and, until now, the ticket card showed none: a Jira attachment never reached
// the description at all (ADF media has no markdown equivalent, so it was
// dropped), and a GitHub body's `![](…)` arrived as text the renderer had no
// image support for anyway.
//
// TWO RULES SHAPE THIS FILE, and both are about not trusting ticket content.
//
//  1. A TICKET BODY IS WRITTEN BY STRANGERS. Anyone who can comment on an issue
//     can put `![](http://theirs/beacon.png)` in it. So the address of an image
//     is not permission to fetch it: `imageHostAllowed` is an allow-list of the
//     PROVIDER'S OWN hosts, and it is the only thing that opens the door.
//  2. THE CREDENTIAL GOES ONLY WHERE THE CREDENTIAL BELONGS. This is the rule
//     `fetchJira` already states for issue reads — a Basic header carrying the
//     user's Jira token must never travel to a host taken from a pasted URL —
//     and an image URL is exactly such a host, one step further from the user.
//
// Pure: no fetch, no fs, no DOM. What performs the fetch is
// IntegrationsManager.imageData, which asks this module first.

/** One picture a ticket carries: where it lives, and what to call it. */
export interface IssueImage {
  /** Absolute https URL on the provider's own host. */
  url: string
  /** The tracker's filename, or the alt text, or a generated one. */
  name: string
}

/**
 * How many pictures one ticket may offer.
 *
 * A CAP, NOT A LIMIT ON WHAT EXISTS. Twelve is well past a bug report's worth
 * of screenshots, and the point is that a ticket with two hundred attachments
 * cannot turn opening a card into two hundred authenticated round trips.
 */
export const MAX_ISSUE_IMAGES = 12

/** The largest single image that may cross IPC as a data URI. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * Image types a tracker realistically attaches, and a renderer can draw.
 *
 * NO `image/svg+xml`. An SVG is a document with scripting in it, not a picture,
 * and the whole point of this path is that the bytes come from a stranger. The
 * cost of leaving it out is a diagram that shows as a download instead of a
 * preview; the cost of leaving it in is arbitrary markup from a ticket author.
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])

/** `.png` and friends — the fallback when a tracker names no MIME type. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp)(?:$|[?#])/i

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The pictures attached to a Jira issue.
 *
 * FROM THE ATTACHMENT LIST, NOT FROM THE BODY. ADF marks an inline image with a
 * `media` node whose `attrs.id` is a media-services id — not the attachment id
 * beside it — so pairing the two is a guess that silently pairs the wrong
 * picture with the wrong ticket. `fields.attachment` is Jira's own answer to
 * "what is attached here", each entry already carrying the authenticated
 * address to read it from. An inline image that is not also an attachment is
 * therefore not shown; that is a real gap, and it is the one that cannot show
 * the wrong thing.
 *
 * Requires `attachment` in the search's `fields` list — Jira returns only what
 * was asked for, which is how the ticket's priority and names once arrived
 * empty.
 */
export function imagesFromJiraFields(fields: unknown): IssueImage[] {
  const list = record(fields)['attachment']
  if (!Array.isArray(list)) return []
  const images: IssueImage[] = []
  for (const entry of list) {
    const attachment = record(entry)
    const url = text(attachment['content']).trim()
    if (url.length === 0) continue
    const name = text(attachment['filename']).trim()
    const mime = text(attachment['mimeType']).trim().toLowerCase()
    // THE TRACKER'S OWN TYPE WINS. A name is a hint and a MIME type is an
    // answer, so a `.png` that Jira calls `application/octet-stream` is not
    // drawn as an image and a typed one with no extension still is.
    const isImage = mime.length > 0 ? IMAGE_TYPES.has(mime) : IMAGE_EXTENSION.test(name)
    if (!isImage) continue
    images.push({ url, name: name.length > 0 ? name : 'Attachment' })
  }
  return images.slice(0, MAX_ISSUE_IMAGES)
}

/** `![alt](url)` — markdown's own image, as GitHub bodies write it. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g

/** `<img src="…">` — HTML, which both GitHub markdown and Azure descriptions use. */
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

/** The `alt="…"` of one `<img>` tag, when it has one. */
const HTML_ALT = /\balt\s*=\s*["']([^"']*)["']/i

/**
 * Every picture referenced by a markdown body — GitHub's issue bodies, and any
 * other tracker whose description is markdown.
 *
 * BOTH SPELLINGS, because GitHub accepts both and a pasted screenshot arrives
 * as whichever the person's client wrote. Order is preserved and duplicates are
 * dropped: the same screenshot linked twice is one picture.
 */
export function imagesFromMarkdown(body: string): IssueImage[] {
  const found: IssueImage[] = []
  for (const match of body.matchAll(MARKDOWN_IMAGE)) {
    const url = (match[2] ?? '').trim()
    if (url.length > 0) found.push({ url, name: (match[1] ?? '').trim() })
  }
  found.push(...imagesFromHtml(body))
  return dedupe(found)
}

/** Every `<img>` in an HTML description — Azure DevOps writes these. */
export function imagesFromHtml(html: string): IssueImage[] {
  const found: IssueImage[] = []
  for (const match of html.matchAll(HTML_IMAGE)) {
    const url = (match[1] ?? '').trim()
    if (url.length === 0) continue
    found.push({ url, name: (HTML_ALT.exec(match[0])?.[1] ?? '').trim() })
  }
  return dedupe(found)
}

/**
 * One address per picture, named — the shared tail of both parsers.
 *
 * A NAME IS DERIVED, NEVER LEFT BLANK. The alt text is what the author wrote,
 * the filename is what their client called it, and "Image N" is what is left;
 * the name is a label and an accessible description, so an empty one would put
 * an unlabelled picture in front of a screen reader.
 */
function dedupe(found: readonly IssueImage[]): IssueImage[] {
  const seen = new Set<string>()
  const images: IssueImage[] = []
  for (const image of found) {
    if (seen.has(image.url)) continue
    seen.add(image.url)
    images.push({
      url: image.url,
      name: image.name.length > 0 ? image.name : fileNameOf(image.url, images.length + 1),
    })
    if (images.length >= MAX_ISSUE_IMAGES) break
  }
  return images
}

/** The last path segment of a URL, or `Image N` when it has nothing to say. */
function fileNameOf(url: string, ordinal: number): string {
  const path = url.split(/[?#]/)[0] ?? ''
  const segment = decodeURIComponent(path.split('/').pop() ?? '').trim()
  return segment.length > 0 ? segment : `Image ${String(ordinal)}`
}

/** Which provider's credential a URL may be fetched with, and from where. */
export interface ImageHost {
  provider: 'jira' | 'github' | 'azure'
  /** The connected Jira site (`acme.atlassian.net`), for the jira allow-list. */
  site?: string | null
}

/** GitHub's own hosts — the API, the site, and the two it serves assets from. */
const GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'avatars.githubusercontent.com',
  'media.githubusercontent.com',
])

/**
 * May this URL be fetched with this provider's credential?
 *
 * THE ONLY DOOR. Everything else about an image — its name, its size, whether
 * the ticket meant it as a screenshot — is presentation. This is the security
 * decision, so it is one exported function with one answer, and every fetch
 * asks it (allowed-pattern #14).
 *
 * `https` ONLY, and the host must be the provider's own. A plain-http address
 * would send a Basic header in the clear; any other host, on any scheme, is
 * somebody else's — including one a ticket author chose specifically because
 * it is theirs.
 */
export function imageHostAllowed(host: ImageHost, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  // Userinfo in the authority is how a URL smuggles a credential to a host that
  // is not the one it appears to name; refused before the hostname is read.
  if (parsed.username.length > 0 || parsed.password.length > 0) return false
  const hostname = parsed.hostname.toLowerCase()
  if (host.provider === 'github') return GITHUB_HOSTS.has(hostname)
  if (host.provider === 'azure') {
    return hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')
  }
  const site = (host.site ?? '').trim().toLowerCase()
  return site.length > 0 && hostname === site
}

/** Whether a response's own Content-Type says this really is an image. */
export function isImageContentType(contentType: string | null): boolean {
  if (contentType === null) return false
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return IMAGE_TYPES.has(type)
}
