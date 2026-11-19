/**
 * IN-PLACE EDITS (note 4): one element, addressed by its stamped
 * `data-flow-id`, gets new text or one style property — and nothing else in
 * the file changes. The patch is a splice into the original string at offsets
 * the scanner reported; the screen is never parsed into a tree and written
 * back, so the agent's formatting, comments and scripts survive every edit.
 *
 * Before the write, the previous file becomes the newest undo snapshot; the
 * write is atomic and recorded as Flow's own (draft-store.ts). An edit whose
 * element is gone writes nothing and says so.
 */
import { join } from 'path'

import { DRAFT_ID_ATTRIBUTE, resolveDraftPath, validateDraftEdit, type DraftEdit, type DraftWriteAnswer } from '../../shared/ui-drafts'
import { attributeOf, matchingEndIndex, scanHtml, VOID_ELEMENTS, type HtmlToken } from './html-scan'
import { replaceDraftFile, type DraftStoreDeps } from './draft-store'

export const ELEMENT_GONE = 'This element is no longer on the screen, so the change was not saved.'
export const TEXT_NOT_PATCHABLE =
  'The text of this element is spread across the elements inside it, so it cannot be changed in place. Pick the inner element instead.'
export const ELEMENT_NOT_BOUNDED = 'This element cannot be changed in place, so the change was not saved.'
export const SCREEN_GONE = 'This screen is no longer in the canvas, so the change was not saved.'

type StartToken = Extract<HtmlToken, { type: 'start' }>

export type DraftPatchResult = { ok: true; html: string } | { ok: false; reason: string }

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function splice(html: string, start: number, end: number, insert: string): string {
  return html.slice(0, start) + insert + html.slice(end)
}

/** Split a style attribute's raw value into declarations, respecting quotes and parentheses. */
function splitDeclarations(style: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const char of style) {
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ';' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** The style value with `property` set to `value` — replaced where it was, appended when absent. */
export function setStyleProperty(style: string, property: string, value: string): string {
  const declarations = splitDeclarations(style)
  let replaced = false
  const out: string[] = []
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':')
    const name = colon === -1 ? '' : declaration.slice(0, colon).trim().toLowerCase()
    if (name !== property) {
      out.push(declaration)
      continue
    }
    if (replaced) continue // a later duplicate would override ours; drop it
    replaced = true
    const leading = /^\s*/.exec(declaration)?.[0] ?? ''
    const afterColon = /^:\s*/.exec(declaration.slice(colon))?.[0] ?? ': '
    const trailing = /\s*$/.exec(declaration)?.[0] ?? ''
    out.push(`${leading}${declaration.slice(leading.length, colon)}${afterColon}${value}${trailing}`)
  }
  if (replaced) return out.join(';')
  const body = out.join(';')
  const trimmed = body.replace(/[\s;]*$/, '')
  return trimmed.length === 0 ? `${property}: ${value}` : `${trimmed}; ${property}: ${value}`
}

function findElement(tokens: readonly HtmlToken[], id: string): number | null {
  const index = tokens.findIndex(
    (token) => token.type === 'start' && attributeOf(token, DRAFT_ID_ATTRIBUTE)?.value === id,
  )
  return index === -1 ? null : index
}

function patchText(html: string, tokens: readonly HtmlToken[], index: number, text: string): DraftPatchResult {
  const opener = tokens[index] as StartToken
  if (VOID_ELEMENTS.has(opener.name) || opener.selfClosing) return { ok: false, reason: ELEMENT_NOT_BOUNDED }
  const endIndex = matchingEndIndex(tokens, index)
  if (endIndex === null) return { ok: false, reason: ELEMENT_NOT_BOUNDED }
  const escaped = escapeText(text)
  // Direct children only: text runs at depth 0, and whether any element sits there.
  const directText: Array<Extract<HtmlToken, { type: 'text' }>> = []
  let hasChildElement = false
  let depth = 0
  for (let at = index + 1; at < endIndex; at += 1) {
    const token = tokens[at]
    if (token.type === 'start') {
      if (depth === 0) hasChildElement = true
      if (!token.selfClosing && !VOID_ELEMENTS.has(token.name)) depth += 1
    } else if (token.type === 'end') depth = Math.max(0, depth - 1)
    else if (token.type === 'text' && depth === 0) directText.push(token)
  }
  const innerStart = opener.end
  const innerEnd = tokens[endIndex].start
  if (!hasChildElement) {
    // Text only (or empty, or comments): the whole content becomes the new text,
    // keeping the whitespace around it so the file's indentation survives.
    const inner = html.slice(innerStart, innerEnd)
    if (/<!--/.test(inner)) return { ok: false, reason: TEXT_NOT_PATCHABLE }
    const leading = /^\s*/.exec(inner)?.[0] ?? ''
    const trailing = inner.trim().length === 0 ? '' : (/\s*$/.exec(inner)?.[0] ?? '')
    return { ok: true, html: splice(html, innerStart, innerEnd, `${leading}${escaped}${trailing}`) }
  }
  const meaningful = directText.filter((token) => html.slice(token.start, token.end).trim().length > 0)
  // The text lives in the children, or in more than one run between them:
  // there is no single place to put the new text without guessing.
  if (meaningful.length !== 1) return { ok: false, reason: TEXT_NOT_PATCHABLE }
  const run = meaningful[0]
  const raw = html.slice(run.start, run.end)
  const leading = /^\s*/.exec(raw)?.[0] ?? ''
  const trailing = /\s*$/.exec(raw)?.[0] ?? ''
  return { ok: true, html: splice(html, run.start + leading.length, run.end - trailing.length, escaped) }
}

function patchStyle(html: string, opener: StartToken, property: string, value: string): DraftPatchResult {
  const style = attributeOf(opener, 'style')
  if (style === undefined) {
    // No style yet: add one at the end of the attributes, before `>` or `/>`.
    const last = opener.attributes[opener.attributes.length - 1]
    const at = last === undefined ? opener.nameEnd : last.end
    return { ok: true, html: splice(html, at, at, ` style="${property}: ${value}"`) }
  }
  const current = style.value ?? ''
  const next = setStyleProperty(current, property, value)
  if (style.quote === '"' || style.quote === "'") {
    if (next.includes(style.quote)) return { ok: false, reason: ELEMENT_NOT_BOUNDED }
    return { ok: true, html: splice(html, style.valueStart as number, style.valueEnd as number, next) }
  }
  // Bare `style` or an unquoted value: rewrite the whole attribute, quoted.
  if (next.includes('"')) return { ok: false, reason: ELEMENT_NOT_BOUNDED }
  return { ok: true, html: splice(html, style.start, style.end, `style="${next}"`) }
}

/** Apply one edit to a screen's HTML, in memory. Pure; exported for tests. */
export function patchDraftHtml(html: string, edit: DraftEdit): DraftPatchResult {
  const tokens = scanHtml(html)
  const index = findElement(tokens, edit.id)
  if (index === null) return { ok: false, reason: ELEMENT_GONE }
  if (edit.kind === 'text') return patchText(html, tokens, index, edit.text)
  return patchStyle(html, tokens[index] as StartToken, edit.property, edit.value)
}

export interface DraftEditDeps extends DraftStoreDeps {
  /** Whether the renderer may address this root (the readFile gate). */
  isKnownRoot: (rootPath: string) => boolean
}

/**
 * Patch only the addressed element's text or one style property, snapshot the
 * previous file for undo, write atomically and mark the write as Flow's own.
 * Refused with a sentence — and nothing written — when the root, the screen,
 * the edit or the element is not there.
 */
export async function applyDraftEdit(
  deps: DraftEditDeps,
  request: { root: string; canvas: string; screen: string; edit: DraftEdit },
): Promise<DraftWriteAnswer> {
  if (!deps.isKnownRoot(request.root)) return { ok: false, reason: "That project isn't open." }
  const resolution = resolveDraftPath(request.root, request.canvas, `${request.screen}.html`)
  if (!resolution.ok || resolution.kind !== 'screen') return { ok: false, reason: SCREEN_GONE }
  const valid = validateDraftEdit(request.edit)
  if (!valid.ok) return valid
  const absPath = join(request.root, resolution.relPath)
  let html: string
  try {
    html = await deps.fs.readFile(absPath)
  } catch {
    return { ok: false, reason: SCREEN_GONE }
  }
  const patched = patchDraftHtml(html, valid.edit)
  if (!patched.ok) return patched
  if (patched.html === html) return { ok: true }
  try {
    await replaceDraftFile(deps, {
      root: request.root,
      canvas: request.canvas,
      file: `${request.screen}.html`,
      content: patched.html,
    })
  } catch (error) {
    console.warn('[Drafts] could not write an edit', { canvas: request.canvas, screen: request.screen, error })
    return { ok: false, reason: 'The change could not be saved.' }
  }
  return { ok: true }
}
