/**
 * Streaming-safe markdown → DOM renderer (hand-rolled, no external library).
 *
 * SAFETY: raw input never reaches innerHTML — every piece of source text is
 * inserted via `textContent`/`createTextNode`, so markup in model output is
 * inert by construction. Links are restricted to http(s) and open externally
 * (target=_blank → main's setWindowOpenHandler → shell.openExternal).
 *
 * Supported blocks: headings, paragraphs, blockquotes, ordered/unordered
 * lists (incl. GitHub task lists), tables, horizontal rules, and fenced code
 * blocks (JetBrains Mono, language tag, copy button). Inline: code spans,
 * bold, italic, strikethrough, links — bracketed `[text](url)` and, per GFM,
 * bare/`<angle>` autolinks in prose (#1127, span resolved by markdown-autolink).
 *
 * INCREMENTAL APPEND (`StreamingMarkdown`): the source is parsed into blocks
 * with source offsets; on each delta only the region from the last *open*
 * block onward is re-parsed and re-rendered. Blocks before the open block
 * are frozen in the DOM and never touched again, so long streams stay O(1)
 * per delta instead of O(document).
 */

import { looksLikeFilePath, opensInBrowser } from './file-path'
import { highlightCodeBlock } from './code-highlight-view'
import { findAutolink } from './markdown-autolink'
import { isTableStart } from './markdown-table-detect'
import {
  LIST_ITEM_RE,
  classifyAfterBlank,
  fenceLineInfo,
  listStartNumber,
  stripFenceIndent,
} from './markdown-list-code'

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/** One-shot render (message history, finalized content). */
export function renderMarkdown(source: string): HTMLElement {
  injectMarkdownStyles()
  const container = document.createElement('div')
  container.className = 'fl-md'
  for (const block of parseBlocks(source)) {
    container.appendChild(block.element)
  }
  return container
}

/** Incremental renderer for a live assistant message. */
export class StreamingMarkdown {
  readonly element: HTMLElement
  #source = ''
  /** Absolute source offset where the open (still mutable) region begins. */
  #stableOffset = 0
  /** DOM nodes rendered for the open region (replaced on every delta). */
  #openNodes: HTMLElement[] = []

  constructor() {
    injectMarkdownStyles()
    this.element = document.createElement('div')
    this.element.className = 'fl-md'
  }

  get source(): string {
    return this.#source
  }

  /** Append a streamed delta and re-render only the open tail region. */
  append(delta: string): void {
    if (!delta) {
      return
    }
    this.#source += delta
    this.#renderTail()
  }

  /** Replace the whole content (history load / reconcile). */
  set(source: string): void {
    this.#source = source
    this.#stableOffset = 0
    this.#openNodes = []
    this.element.textContent = ''
    this.#renderTail()
  }

  /** Final render pass once the stream is done (closes the open block). */
  finalize(): void {
    this.#renderTail()
  }

  #renderTail(): void {
    for (const node of this.#openNodes) {
      node.remove()
    }
    this.#openNodes = []

    const region = this.#source.slice(this.#stableOffset)
    const blocks = parseBlocks(region)
    if (blocks.length === 0) {
      return
    }

    // Everything before the last block can no longer change — freeze it.
    for (let index = 0; index < blocks.length - 1; index += 1) {
      this.element.appendChild(blocks[index]!.element)
    }
    const open = blocks[blocks.length - 1]!
    this.#stableOffset += open.start
    this.#openNodes = [open.element]
    this.element.appendChild(open.element)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Block parser
// ═══════════════════════════════════════════════════════════════════════

interface ParsedBlock {
  /** Offset of the block's first character within the parsed source. */
  start: number
  element: HTMLElement
}

interface SourceLine {
  text: string
  /** Offset of the line's first character within the parsed source. */
  offset: number
}

// CommonMark opening fence: the marker plus an ARBITRARY info string (#789 —
// real answers constantly carry `title="…"`, `{2,4}`, `showLineNumbers` after
// the language; requiring a whitespace-only tail shredded those blocks into
// prose). Backtick fences may not contain a backtick in the info string (that
// would be inline code, e.g. a paragraph starting ```` ```code``` ````). The
// LANGUAGE is the first word. Parsing lives in fenceLineInfo (pure module);
// a TOP-LEVEL fence must sit at column 0 — an indented fence belongs to a
// list item and is handled inside parseList (#1016).

/** Parse a top-level opening fence: marker + language (first info-string
 *  word), or null when the line isn't a column-0 fence. */
function fenceInfo(lineText: string): { marker: string; lang: string } | null {
  const fence = fenceLineInfo(lineText)
  return fence !== null && fence.indent === 0 ? fence : null
}
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const TASK_ITEM_RE = /^\[([ xX])\]\s+(.*)$/
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let offset = 0
  for (const text of source.split('\n')) {
    lines.push({ text, offset })
    offset += text.length + 1
  }
  return lines
}

function parseBlocks(source: string): ParsedBlock[] {
  const lines = splitLines(source)
  const blocks: ParsedBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    if (line.text.trim() === '') {
      index += 1
      continue
    }
    const start = line.offset

    // Fenced code block
    const fence = fenceInfo(line.text)
    if (fence) {
      const marker = fence.marker
      const lang = fence.lang
      const body: string[] = []
      let cursor = index + 1
      while (cursor < lines.length && !isClosingFence(lines[cursor]!.text, marker)) {
        body.push(lines[cursor]!.text)
        cursor += 1
      }
      const closed = cursor < lines.length
      blocks.push({ start, element: codeBlock(lang, body.join('\n')) })
      index = closed ? cursor + 1 : cursor
      continue
    }

    // Heading
    const heading = HEADING_RE.exec(line.text)
    if (heading) {
      const level = heading[1]!.length
      const el = document.createElement(`h${level}`)
      appendInline(el, heading[2] ?? '')
      blocks.push({ start, element: el })
      index += 1
      continue
    }

    // Horizontal rule
    if (HR_RE.test(line.text)) {
      blocks.push({ start, element: document.createElement('hr') })
      index += 1
      continue
    }

    // Blockquote
    if (BLOCKQUOTE_RE.test(line.text)) {
      const quoted: string[] = []
      let cursor = index
      while (cursor < lines.length) {
        const match = BLOCKQUOTE_RE.exec(lines[cursor]!.text)
        if (!match) {
          break
        }
        quoted.push(match[1] ?? '')
        cursor += 1
      }
      const quote = document.createElement('blockquote')
      for (const inner of parseBlocks(quoted.join('\n'))) {
        quote.appendChild(inner.element)
      }
      blocks.push({ start, element: quote })
      index = cursor
      continue
    }

    // List (unordered / ordered / task)
    if (LIST_ITEM_RE.test(line.text)) {
      const { element, next } = parseList(lines, index)
      blocks.push({ start, element })
      index = next
      continue
    }

    // Table: a header row containing '|' followed by a divider row
    if (isTableStart(line.text, lines[index + 1]?.text)) {
      const { element, next } = parseTable(lines, index)
      blocks.push({ start, element })
      index = next
      continue
    }

    // Paragraph: consume until a blank line or the start of another block
    const paragraph: string[] = []
    let cursor = index
    while (cursor < lines.length) {
      const text = lines[cursor]!.text
      if (
        text.trim() === '' ||
        fenceInfo(text) !== null ||
        HEADING_RE.test(text) ||
        HR_RE.test(text) ||
        LIST_ITEM_RE.test(text) ||
        BLOCKQUOTE_RE.test(text) ||
        // #1015: in GFM a table interrupts a paragraph — a header row written
        // on the line right after prose starts the table; without this test
        // the whole table is swallowed as literal pipe text.
        isTableStart(text, lines[cursor + 1]?.text)
      ) {
        if (cursor === index) {
          paragraph.push(text)
          cursor += 1
        }
        break
      }
      paragraph.push(text)
      cursor += 1
    }
    const p = document.createElement('p')
    appendInline(p, paragraph.join('\n'))
    blocks.push({ start, element: p })
    index = cursor
  }

  return blocks
}

function isClosingFence(text: string, marker: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith(marker[0]!.repeat(3)) && /^(`{3,}|~{3,})\s*$/.test(trimmed)
}

function parseList(lines: SourceLine[], startIndex: number): { element: HTMLElement; next: number } {
  const startLine = lines[startIndex]
  if (!startLine) {
    throw new Error('parseList invariant violated: startIndex out of range')
  }
  const first = LIST_ITEM_RE.exec(startLine.text)
  if (!first) {
    throw new Error('parseList invariant violated: caller must guarantee LIST_ITEM_RE matches at startIndex')
  }
  const baseIndent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const list = document.createElement(ordered ? 'ol' : 'ul')
  // #1016: the first item's number sets the <ol> start, so a procedure that
  // resumes after an interruption ("2. Then …") never renumbers from 1.
  const startNumber = listStartNumber(first[2]!)
  if (ordered && startNumber !== null && startNumber !== 1) {
    list.setAttribute('start', String(startNumber))
  }
  let index = startIndex
  // The <li> most recently appended — a deeper-indented item nests inside it.
  let currentItem: HTMLLIElement | null = null
  // Where prose continuation lines of the current item render. Reset to a
  // fresh span after an in-item code block so later prose follows the code.
  let inlineTarget: HTMLSpanElement | null = null

  while (index < lines.length) {
    const text = lines[index]!.text

    // Loose list (#1016): blank line(s) end the list ONLY when what follows is
    // neither another item of this list nor indented continuation of the
    // current item — otherwise GFM keeps it ONE list (a blank line before an
    // indented fence must not split a procedure in two and renumber it).
    if (text.trim() === '') {
      let peek = index + 1
      while (peek < lines.length && lines[peek]!.text.trim() === '') {
        peek += 1
      }
      if (peek >= lines.length || currentItem === null) {
        break
      }
      if (classifyAfterBlank(lines[peek]!.text, baseIndent, ordered) === 'end') {
        break
      }
      index = peek
      continue
    }

    const match = LIST_ITEM_RE.exec(text)
    if (match) {
      const indent = match[1]!.length

      // A more-indented item is a NESTED list (#690): recurse and hang the
      // sublist off the current item instead of flattening it into a sibling
      // (which, in an ordered list, also mis-renumbers the real next step).
      // Guard on a parent existing; a stray leading-indent first item just
      // parses at this level.
      if (indent > baseIndent && currentItem !== null) {
        const sub = parseList(lines, index)
        currentItem.appendChild(sub.element)
        index = sub.next
        continue
      }
      // A less-indented item belongs to an ancestor list — stop and let the
      // caller (an outer parseList frame) resume with it.
      if (indent < baseIndent) {
        break
      }

      let content = match[3] ?? ''
      const item = document.createElement('li')

      const task = TASK_ITEM_RE.exec(content)
      if (task) {
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.disabled = true
        checkbox.checked = task[1] !== ' '
        item.appendChild(checkbox)
        item.classList.add('fl-md-task')
        content = task[2] ?? ''
      }

      const span = document.createElement('span')
      appendInline(span, content)
      item.appendChild(span)

      list.appendChild(item)
      currentItem = item
      inlineTarget = span
      index += 1
      continue
    }

    // Not blank, not an item: a continuation line of the current item — it
    // must be indented (a column-0 line ends the list and resumes top-level).
    if (currentItem === null || !/^\s+/.test(text)) {
      break
    }

    // #1016: an indented fence under the item opens a REAL code block that
    // belongs to the <li> — capture through the closing fence and strip the
    // fence's own indent from the body so the code keeps only its relative
    // indentation. Previously these lines were appended as inline prose:
    // literal ``` shown to the user and multi-line commands flattened.
    const fence = fenceLineInfo(text)
    if (fence) {
      const body: string[] = []
      let cursor = index + 1
      while (cursor < lines.length && !isClosingFence(lines[cursor]!.text, fence.marker)) {
        body.push(stripFenceIndent(lines[cursor]!.text, fence.indent))
        cursor += 1
      }
      currentItem.appendChild(codeBlock(fence.lang, body.join('\n')))
      inlineTarget = null
      index = cursor < lines.length ? cursor + 1 : cursor
      continue
    }

    // Indented prose joins the current item.
    if (inlineTarget === null) {
      inlineTarget = document.createElement('span')
      currentItem.appendChild(inlineTarget)
    } else {
      inlineTarget.appendChild(document.createTextNode(' '))
    }
    appendInline(inlineTarget, text.trim())
    index += 1
  }

  return { element: list, next: index }
}

function parseTable(lines: SourceLine[], startIndex: number): { element: HTMLElement; next: number } {
  const wrapper = document.createElement('div')
  wrapper.className = 'fl-md-table-wrap'
  const table = document.createElement('table')
  wrapper.appendChild(table)

  const headerCells = splitTableRow(lines[startIndex]!.text)
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const cell of headerCells) {
    const th = document.createElement('th')
    appendInline(th, cell)
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  let index = startIndex + 2
  while (index < lines.length && lines[index]!.text.includes('|')) {
    const row = document.createElement('tr')
    const cells = splitTableRow(lines[index]!.text)
    for (let cellIndex = 0; cellIndex < headerCells.length; cellIndex += 1) {
      const td = document.createElement('td')
      appendInline(td, cells[cellIndex] ?? '')
      row.appendChild(td)
    }
    tbody.appendChild(row)
    index += 1
  }
  table.appendChild(tbody)

  return { element: wrapper, next: index }
}

function splitTableRow(text: string): string[] {
  let row = text.trim()
  if (row.startsWith('|')) {
    row = row.slice(1)
  }
  if (row.endsWith('|')) {
    row = row.slice(0, -1)
  }
  return row.split('|').map((cell) => cell.trim())
}

// ═══════════════════════════════════════════════════════════════════════
// Inline parser
// ═══════════════════════════════════════════════════════════════════════

interface InlineRule {
  regex: RegExp
  render: (match: RegExpExecArray) => Node
}

const INLINE_RULES: InlineRule[] = [
  {
    // Code span — matched first so markers inside code stay literal.
    regex: /`([^`\n]+)`/,
    render: (match) => {
      const text = match[1] ?? ''
      // A code span that names a file becomes a clickable link that opens the
      // file in the editor (resolved against the active project root).
      if (looksLikeFilePath(text)) return fileLink(text)
      const code = document.createElement('code')
      code.textContent = text
      return code
    },
  },
  {
    // Link: [text](http(s)://…) — scheme-restricted, opens externally.
    regex: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/,
    render: (match) => {
      const anchor = externalAnchor(match[2] ?? '')
      appendInline(anchor, match[1] ?? '')
      return anchor
    },
  },
  {
    regex: /\*\*([^*\n]+)\*\*/,
    render: (match) => {
      const strong = document.createElement('strong')
      appendInline(strong, match[1] ?? '')
      return strong
    },
  },
  {
    regex: /~~([^~\n]+)~~/,
    render: (match) => {
      const del = document.createElement('del')
      appendInline(del, match[1] ?? '')
      return del
    },
  },
  {
    regex: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/,
    render: (match) => {
      const em = document.createElement('em')
      appendInline(em, match[1] ?? '')
      return em
    },
  },
  {
    regex: /(?<![\w_])_([^_\n]+)_(?![\w_])/,
    render: (match) => {
      const em = document.createElement('em')
      appendInline(em, match[1] ?? '')
      return em
    },
  },
]

/** An external link with the app's fixed safety contract: http(s) only,
 *  `target=_blank` + `rel=noreferrer noopener` → main's setWindowOpenHandler →
 *  `shell.openExternal`. Shared by the bracketed and autolinked forms so a bare
 *  URL can never reach the renderer with weaker guarantees (#1127). */
function externalAnchor(href: string): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  return anchor
}

/** Render inline markdown into `parent` (text nodes only — never innerHTML). */
function appendInline(parent: Node, text: string): void {
  let remaining = text
  while (remaining.length > 0) {
    let earliest: { index: number; length: number; render: () => Node } | null = null
    for (const rule of INLINE_RULES) {
      const match = rule.regex.exec(remaining)
      if (match && (earliest === null || match.index < earliest.index)) {
        earliest = {
          index: match.index,
          length: match[0].length,
          render: () => rule.render(match),
        }
      }
    }
    // Bare/angle autolink (#1127) — GFM linkifies URLs written in prose, which
    // is how a URL actually reaches the transcript. Considered LAST and only
    // when it starts strictly earlier, so a code span (`` `https://x` ``) and a
    // bracketed [text](url) still win at the same position and URLs inside
    // backticks stay literal. The span comes from the pure detector because a
    // regex alone can't say where a URL ends (`…(bar).` vs `…/Foo_(bar)`).
    const auto = findAutolink(remaining)
    if (auto !== null && (earliest === null || auto.index < earliest.index)) {
      earliest = {
        index: auto.index,
        length: auto.length,
        render: () => {
          const anchor = externalAnchor(auto.url)
          anchor.textContent = auto.url
          return anchor
        },
      }
    }
    if (!earliest) {
      parent.appendChild(document.createTextNode(remaining))
      return
    }
    if (earliest.index > 0) {
      parent.appendChild(document.createTextNode(remaining.slice(0, earliest.index)))
    }
    parent.appendChild(earliest.render())
    remaining = remaining.slice(earliest.index + earliest.length)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// File references
// ═══════════════════════════════════════════════════════════════════════

/**
 * A clickable file-reference chip.
 *
 * A GENERATED PAGE OPENS AS A PAGE. An agent that writes
 * `docs/playbook-output-contract.html` and says "open it directly in a browser"
 * is describing something to look at, and clicking the name gave a tab of
 * `<!DOCTYPE html>` (user, 2026-09-18: "by default should open the browser and
 * if the user wanna open the html we should have also have a way to do it").
 *
 * The other way is ⌥click, and the tooltip is where a person finds that out —
 * an inline chip in a paragraph has no room for a second control, and the
 * source of a page is a minority want.
 *
 * WHERE IT IS RESOLVED DOES NOT CHANGE. A raw path from a conversation means
 * nothing until it is resolved against the thread's roots, and exactly one
 * place does that (allowed-pattern #14) — so this asks the same handler for a
 * different DESTINATION rather than resolving a path of its own.
 */
function fileLink(path: string): HTMLElement {
  const link = document.createElement('a')
  link.className = 'fl-md-file'
  link.href = '#'
  link.textContent = path
  const browsable = opensInBrowser(path)
  link.title = browsable
    ? `Open ${path} in the browser — hold ⌥ to open the file`
    : `Open ${path}`
  link.dataset['filePath'] = path
  link.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const asBrowser = browsable && !event.altKey
    document.dispatchEvent(
      new CustomEvent('flow:open-file-path', {
        detail: { path, ...(asBrowser ? { as: 'browser' as const } : {}) },
      }),
    )
  })
  return link
}

// ═══════════════════════════════════════════════════════════════════════
// Code blocks
// ═══════════════════════════════════════════════════════════════════════

function codeBlock(lang: string, body: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'fl-md-codeblock'

  const header = document.createElement('div')
  header.className = 'fl-md-code-header'
  const langLabel = document.createElement('span')
  langLabel.textContent = lang || 'text'
  header.appendChild(langLabel)

  const copy = document.createElement('fl-button')
  copy.setAttribute('variant', 'ghost')
  copy.setAttribute('small', '')
  copy.setAttribute('title', 'Copy code')
  copy.setAttribute('aria-label', 'Copy code')
  const copyLabel = document.createElement('span')
  copyLabel.textContent = 'Copy'
  copy.appendChild(copyLabel)
  copy.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(body)
      .then(() => {
        copyLabel.textContent = 'Copied'
        window.setTimeout(() => {
          copyLabel.textContent = 'Copy'
        }, 1200)
      })
      .catch((error: unknown) => {
        console.warn('flow: failed to copy code block', error)
      })
  })
  header.appendChild(copy)

  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = body
  pre.appendChild(code)
  // COLOUR ARRIVES LATE, AND ONLY IF IT CAN. The block is readable the instant
  // it renders; Monaco's tokenizer is fetched on the first fence that names a
  // language and painted in afterwards. A failure to load, an unknown tag, or a
  // block the reader has already scrolled past all end as the plain text above
  // — the reader never waits on this and never sees it fail.
  void highlightCodeBlock(code, lang, body)

  wrapper.appendChild(header)
  wrapper.appendChild(pre)
  return wrapper
}

// ═══════════════════════════════════════════════════════════════════════
// Styles (light DOM)
// ═══════════════════════════════════════════════════════════════════════

let markdownStylesInjected = false

function injectMarkdownStyles(): void {
  if (markdownStylesInjected) {
    return
  }
  markdownStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-md {
      font-size: var(--fl-text-prose-size);
      line-height: var(--fl-line-height);
      color: var(--fl-color-text);
      overflow-wrap: break-word;
      /* Never wider than what holds it. overflow-wrap alone cannot save a
         block whose parent sized it to max-content - see .fl-conv-assistant. */
      max-width: 100%;
      min-width: 0;
    }
    .fl-md > :first-child { margin-top: 0; }
    .fl-md > :last-child { margin-bottom: 0; }
    .fl-md p { margin: var(--fl-space-sm) 0; white-space: pre-wrap; }
    .fl-md h1, .fl-md h2, .fl-md h3, .fl-md h4, .fl-md h5, .fl-md h6 {
      margin: var(--fl-space-lg) 0 var(--fl-space-sm);
      line-height: var(--fl-line-height-dense);
      font-weight: 600;
    }
    .fl-md h1 { font-size: 1.3em; }
    .fl-md h2 { font-size: 1.15em; }
    .fl-md h3 { font-size: 1.05em; }
    .fl-md h4, .fl-md h5, .fl-md h6 { font-size: 1em; }
    .fl-md a { color: var(--fl-color-accent); text-decoration: none; }
    .fl-md a:hover { text-decoration: underline; }
    .fl-md code {
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      padding: 0 4px;
    }
    /* A file-reference code span — same monospace chip, but interactive. */
    .fl-md .fl-md-file {
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      padding: 0 4px;
      color: var(--fl-color-accent);
      cursor: pointer;
      text-decoration: none;
    }
    .fl-md .fl-md-file:hover {
      text-decoration: underline;
      border-color: var(--fl-color-accent);
    }
    .fl-md ul, .fl-md ol { margin: var(--fl-space-sm) 0; padding-left: var(--fl-space-xl); }
    .fl-md li { margin: 2px 0; }
    .fl-md li.fl-md-task { list-style: none; margin-left: calc(-1 * var(--fl-space-lg)); }
    .fl-md li.fl-md-task input {
      margin-right: var(--fl-space-xs);
      accent-color: var(--fl-color-accent);
      vertical-align: middle;
    }
    .fl-md blockquote {
      margin: var(--fl-space-sm) 0;
      padding: 0 var(--fl-space-md);
      border-left: 2px solid var(--fl-color-border);
      color: var(--fl-color-text-secondary);
    }
    .fl-md hr {
      border: none;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      margin: var(--fl-space-lg) 0;
    }
    .fl-md .fl-md-table-wrap { overflow-x: auto; margin: var(--fl-space-sm) 0; }
    .fl-md table { border-collapse: collapse; font-size: var(--fl-text-ui-size); }
    .fl-md th, .fl-md td {
      border: var(--fl-border-width) solid var(--fl-color-border);
      padding: var(--fl-space-xs) var(--fl-space-sm);
      text-align: left;
    }
    .fl-md th {
      background: var(--fl-color-surface-raised);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-md .fl-md-codeblock {
      margin: var(--fl-space-sm) 0;
      max-width: 100%;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-bg);
      overflow: hidden;
    }
    .fl-md .fl-md-code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px var(--fl-space-sm) 2px var(--fl-space-md);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-family: var(--fl-font-mono);
    }
    .fl-md .fl-md-codeblock pre {
      margin: 0;
      padding: var(--fl-space-md);
      overflow-x: auto;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      line-height: var(--fl-line-height-dense);
    }
    /*
     * SYNTAX COLOUR, TAKEN FROM THE EDITOR'S OWN THEME.
     *
     * These are the values in monaco-themes.ts (VS Code Dark+ / Light+), not a
     * second palette invented for the chat — a snippet here and the same file
     * in a tab have to be the same colour, or the app is telling two stories
     * about what a keyword looks like. Both modes switch on data-theme,
     * exactly as the tokens do. (No backticks in here: this block is a template
     * literal, and one breaks the build with a misleading TS1005.)
     */
    .fl-md .fl-tok-keyword { color: #569CD6; }
    .fl-md .fl-tok-string { color: #CE9178; }
    .fl-md .fl-tok-comment { color: #6A9955; font-style: italic; }
    .fl-md .fl-tok-number { color: #B5CEA8; }
    .fl-md .fl-tok-regexp { color: #D16969; }
    .fl-md .fl-tok-type,
    .fl-md .fl-tok-namespace,
    .fl-md .fl-tok-class,
    .fl-md .fl-tok-interface,
    .fl-md .fl-tok-struct,
    .fl-md .fl-tok-enum { color: #4EC9B0; }
    .fl-md .fl-tok-function,
    .fl-md .fl-tok-annotation { color: #DCDCAA; }
    .fl-md .fl-tok-variable { color: #9CDCFE; }
    .fl-md .fl-tok-tag { color: #569CD6; }
    .fl-md .fl-tok-attribute { color: #9CDCFE; }
    .fl-md .fl-tok-operator,
    .fl-md .fl-tok-delimiter { color: inherit; }

    :root[data-theme='light'] .fl-md .fl-tok-keyword { color: #0000FF; }
    :root[data-theme='light'] .fl-md .fl-tok-string { color: #A31515; }
    :root[data-theme='light'] .fl-md .fl-tok-comment { color: #008000; }
    :root[data-theme='light'] .fl-md .fl-tok-number { color: #098658; }
    :root[data-theme='light'] .fl-md .fl-tok-regexp { color: #811F3F; }
    :root[data-theme='light'] .fl-md .fl-tok-type,
    :root[data-theme='light'] .fl-md .fl-tok-namespace,
    :root[data-theme='light'] .fl-md .fl-tok-class,
    :root[data-theme='light'] .fl-md .fl-tok-interface,
    :root[data-theme='light'] .fl-md .fl-tok-struct,
    :root[data-theme='light'] .fl-md .fl-tok-enum { color: #267F99; }
    :root[data-theme='light'] .fl-md .fl-tok-function,
    :root[data-theme='light'] .fl-md .fl-tok-annotation { color: #795E26; }
    :root[data-theme='light'] .fl-md .fl-tok-variable { color: #001080; }
    :root[data-theme='light'] .fl-md .fl-tok-tag { color: #800000; }
    :root[data-theme='light'] .fl-md .fl-tok-attribute { color: #E50000; }

    .fl-md .fl-md-codeblock code {
      background: transparent;
      border: none;
      padding: 0;
    }
  `
  document.head.appendChild(style)
}
