/**
 * STAMPING (note 3): every element of a draft screen carries a short stable id
 * in `data-flow-id`, so an in-place edit can address one element and patch
 * only it. Stamping adds the attribute to each element tag that has none —
 * right after the tag name — and changes no other byte: existing ids,
 * attribute order, quoting, whitespace, comments, script and style text all
 * stay exactly as the agent wrote them. Running it twice adds nothing.
 */
import { randomBytes } from 'crypto'

import { DRAFT_ID_ATTRIBUTE } from '../../shared/ui-drafts'
import { attributeOf, scanHtml } from './html-scan'

/** Tags that are never stamped: document plumbing, raw-text holders, and `<br>`. */
const UNSTAMPED = new Set(['html', 'head', 'meta', 'title', 'style', 'script', 'link', 'br', 'base', 'noscript'])

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A short random id (6 characters, letter first so it is also a valid CSS ident). */
export function randomDraftId(): string {
  const bytes = randomBytes(6)
  let id = ID_ALPHABET[bytes[0] % 26]
  for (let index = 1; index < 6; index += 1) id += ID_ALPHABET[bytes[index] % ID_ALPHABET.length]
  return id
}

/** Every `data-flow-id` already present in a screen. */
export function draftIdsIn(html: string): Set<string> {
  const ids = new Set<string>()
  for (const token of scanHtml(html)) {
    if (token.type !== 'start') continue
    const value = attributeOf(token, DRAFT_ID_ATTRIBUTE)?.value
    if (value !== null && value !== undefined && value.length > 0) ids.add(value)
  }
  return ids
}

/**
 * Add a `data-flow-id` to every element tag of `html` that has none. `taken`
 * names ids that must not be minted (beyond those already in the screen);
 * `nextId` is injectable so tests are deterministic. Ids are unique per screen.
 */
export function stampDraftIds(
  html: string,
  taken: ReadonlySet<string>,
  nextId: () => string = randomDraftId,
): { html: string; added: number } {
  const tokens = scanHtml(html)
  const used = new Set<string>([...taken, ...draftIdsIn(html)])
  const inserts: Array<{ at: number; text: string }> = []
  for (const token of tokens) {
    if (token.type !== 'start' || UNSTAMPED.has(token.name)) continue
    if (attributeOf(token, DRAFT_ID_ATTRIBUTE) !== undefined) continue
    let id = nextId()
    for (let attempt = 0; used.has(id); attempt += 1) {
      if (attempt > 1000) throw new Error('stampDraftIds: could not mint a unique id')
      id = nextId()
    }
    used.add(id)
    inserts.push({ at: token.nameEnd, text: ` ${DRAFT_ID_ATTRIBUTE}="${id}"` })
  }
  if (inserts.length === 0) return { html, added: 0 }
  let out = ''
  let cursor = 0
  for (const insert of inserts) {
    out += html.slice(cursor, insert.at) + insert.text
    cursor = insert.at
  }
  return { html: out + html.slice(cursor), added: inserts.length }
}
