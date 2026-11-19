/**
 * A SMALL HTML TAG SCANNER for draft screens — pure JS, no dependency, no
 * native module. It never builds a tree and never re-serialises: it reports
 * where each tag, attribute and text run sits in the ORIGINAL string, so a
 * caller can splice exactly the bytes it means to change and leave every other
 * byte as written (the constraint the plan puts on stamping and editing).
 *
 * What it respects, because a naive `<…>` regex gets each of these wrong:
 *   - quoted attribute values (`title="a > b"` is one tag, not two);
 *   - comments (`<!-- <div> -->` holds no element) and `<!doctype …>`;
 *   - raw text: `<script>`, `<style>`, `<textarea>`, `<title>` contents are
 *     text up to their own closing tag (`if (a < b)` is not a tag).
 *
 * It is a scanner for agent-written screens, not a browser: malformed markup
 * is read as best it can be, and the callers that change bytes refuse when the
 * element they address cannot be bounded with certainty.
 */

export interface HtmlAttribute {
  /** Lowercased attribute name. */
  name: string
  /** Offset of the name's first character. */
  start: number
  /** Offset just past the whole attribute (its value and closing quote, if any). */
  end: number
  /** The raw value as written (entities NOT decoded), or null for a bare attribute. */
  value: string | null
  /** Offsets of the raw value, inside any quotes. Absent for a bare attribute. */
  valueStart?: number
  valueEnd?: number
  quote: '"' | "'" | '' | null
}

export type HtmlToken =
  | { type: 'text'; start: number; end: number }
  | { type: 'comment'; start: number; end: number }
  | { type: 'declaration'; start: number; end: number }
  | {
      type: 'start'
      start: number
      end: number
      /** Lowercased tag name. */
      name: string
      /** Offset just past the tag name. */
      nameEnd: number
      attributes: HtmlAttribute[]
      selfClosing: boolean
    }
  | { type: 'end'; start: number; end: number; name: string }

/** Elements whose content is text up to their own closing tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

/** Elements that never have content or a closing tag. */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const TAG_NAME_START = /[A-Za-z]/
const WHITESPACE = /[\t\n\f\r ]/

function readAttributes(
  html: string,
  from: number,
): { attributes: HtmlAttribute[]; end: number; selfClosing: boolean } {
  const attributes: HtmlAttribute[] = []
  let index = from
  let selfClosing = false
  while (index < html.length) {
    const char = html[index]
    if (WHITESPACE.test(char)) {
      index += 1
      continue
    }
    if (char === '>') return { attributes, end: index + 1, selfClosing }
    if (char === '/') {
      selfClosing = html[index + 1] === '>'
      index += 1
      continue
    }
    selfClosing = false
    const start = index
    while (index < html.length && !WHITESPACE.test(html[index]) && !'/>='.includes(html[index])) index += 1
    // A stray `=` with no name: consume it so the scan always advances.
    if (index === start) index += 1
    const name = html.slice(start, index).toLowerCase()
    let probe = index
    while (probe < html.length && WHITESPACE.test(html[probe])) probe += 1
    if (html[probe] !== '=') {
      attributes.push({ name, start, end: index, value: null, quote: null })
      continue
    }
    probe += 1
    while (probe < html.length && WHITESPACE.test(html[probe])) probe += 1
    const quote = html[probe]
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, probe + 1)
      const valueEnd = close === -1 ? html.length : close
      attributes.push({
        name,
        start,
        end: close === -1 ? html.length : close + 1,
        value: html.slice(probe + 1, valueEnd),
        valueStart: probe + 1,
        valueEnd,
        quote,
      })
      index = close === -1 ? html.length : close + 1
    } else {
      const valueStart = probe
      while (probe < html.length && !WHITESPACE.test(html[probe]) && html[probe] !== '>') probe += 1
      attributes.push({
        name,
        start,
        end: probe,
        value: html.slice(valueStart, probe),
        valueStart,
        valueEnd: probe,
        quote: '',
      })
      index = probe
    }
  }
  return { attributes, end: html.length, selfClosing }
}

/** Scan `html` into tokens that tile it exactly: every byte belongs to one token. */
export function scanHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  let index = 0
  let textStart = 0
  const flushText = (until: number): void => {
    if (until > textStart) tokens.push({ type: 'text', start: textStart, end: until })
  }
  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) break
    const next = html[open + 1]
    if (html.startsWith('<!--', open)) {
      flushText(open)
      const close = html.indexOf('-->', open + 4)
      const end = close === -1 ? html.length : close + 3
      tokens.push({ type: 'comment', start: open, end })
      index = textStart = end
      continue
    }
    if (next === '!' || next === '?') {
      flushText(open)
      const close = html.indexOf('>', open + 2)
      const end = close === -1 ? html.length : close + 1
      tokens.push({ type: 'declaration', start: open, end })
      index = textStart = end
      continue
    }
    if (next === '/' && TAG_NAME_START.test(html[open + 2] ?? '')) {
      flushText(open)
      let nameEnd = open + 2
      while (nameEnd < html.length && !WHITESPACE.test(html[nameEnd]) && !'/>'.includes(html[nameEnd])) nameEnd += 1
      const close = html.indexOf('>', nameEnd)
      const end = close === -1 ? html.length : close + 1
      tokens.push({ type: 'end', start: open, end, name: html.slice(open + 2, nameEnd).toLowerCase() })
      index = textStart = end
      continue
    }
    if (next !== undefined && TAG_NAME_START.test(next)) {
      flushText(open)
      let nameEnd = open + 1
      while (nameEnd < html.length && !WHITESPACE.test(html[nameEnd]) && !'/>'.includes(html[nameEnd])) nameEnd += 1
      const name = html.slice(open + 1, nameEnd).toLowerCase()
      const { attributes, end, selfClosing } = readAttributes(html, nameEnd)
      tokens.push({ type: 'start', start: open, end, name, nameEnd, attributes, selfClosing })
      index = textStart = end
      if (RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
        // Raw text runs to the element's own closing tag, case-insensitively.
        const closing = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'ig')
        closing.lastIndex = end
        const match = closing.exec(html)
        const rawEnd = match === null ? html.length : match.index
        if (rawEnd > end) tokens.push({ type: 'text', start: end, end: rawEnd })
        index = textStart = rawEnd
      }
      continue
    }
    // A `<` that opens nothing (`a < b` in text) is text.
    index = open + 1
  }
  textStart = Math.min(textStart, html.length)
  flushText(html.length)
  return tokens
}

/** The value of attribute `name` on a start tag, or undefined when absent. */
export function attributeOf(token: Extract<HtmlToken, { type: 'start' }>, name: string): HtmlAttribute | undefined {
  return token.attributes.find((attribute) => attribute.name === name)
}

/**
 * The index of the end tag that closes the start tag at `startIndex`, or null
 * when it cannot be told for certain (no closing tag, or an outer element
 * closes first). Void and self-closing elements have none (null).
 */
export function matchingEndIndex(tokens: readonly HtmlToken[], startIndex: number): number | null {
  const opener = tokens[startIndex]
  if (opener === undefined || opener.type !== 'start') return null
  if (opener.selfClosing || VOID_ELEMENTS.has(opener.name)) return null
  const stack: string[] = [opener.name]
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'start') {
      if (!token.selfClosing && !VOID_ELEMENTS.has(token.name)) stack.push(token.name)
      continue
    }
    if (token.type !== 'end') continue
    const at = stack.lastIndexOf(token.name)
    if (at === -1) continue // a stray closing tag: ignored, as a browser would
    if (at === 0) return stack.length === 1 ? index : null
    stack.length = at
  }
  return null
}
