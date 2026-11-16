// Ask the Blueprint — what an answer's text IS, before anything draws it
// (the centered sheet, 2026-11-16).
//
// FORMATTING COMES FROM STRUCTURE. The agent is asked for structured markdown
// (`ask-orchestrator`'s EXPLANATION_RULES): a one-sentence lead on the first
// line, `### ` headings, `- ` lists, backticked code names, `[n]` citations
// naming the nth source, and an optional "Not covered:" line. `parseAnswer`
// reads exactly that grammar into blocks and inline pieces; the view builds DOM
// nodes from them and never hands model text to innerHTML.
//
// OLD ANSWERS STILL READ. A saved answer from before the grammar is plain
// prose: it renders as paragraphs, and an inline run like "…: - a - b - c" is
// turned into a list only when it clearly is one (see `inlineList`).
//
// Also here, because they are words and choices rather than DOM: the
// suggested questions for a scope (deterministic templates, no model call),
// the "Your recent questions" rows, and how many saved questions touch each
// feature (the board's cell markers).
//
// DOM-free and clock-free (`now` is injected), tested in ask-answer-model.test.ts.

import type { AskSavedThread, AskSource } from '../../shared/ask-contract'
import { splitQualifiedFeatureId } from '../../shared/ask-contract'
import { ageLabel } from './ask-panel-model'

/* ── The answer's shape ─────────────────────────────────────────────────── */

export type AnswerInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  /** A backticked name that is not a file or a feature. */
  | { kind: 'code'; text: string }
  /**
   * A backticked repo path or file name. `path` is the file to open — the
   * matching source's path when one matches — or null when nothing says where
   * it is (a bare file name no source names): it is drawn, not pressable.
   */
  | { kind: 'file'; text: string; path: string | null; project?: string }
  /** A backticked `feature:<slug>` (or `feature:<project>::<slug>`) the answer names. */
  | { kind: 'feature'; id: string; label: string }
  /** `[n]` — the nth source. */
  | { kind: 'cite'; n: number }

export type AnswerBlock =
  | { kind: 'heading'; inline: AnswerInline[] }
  | { kind: 'paragraph'; inline: AnswerInline[] }
  | { kind: 'list'; items: AnswerInline[][] }

export interface AnswerDoc {
  /** The one-sentence answer, first; null when the text has none (old prose). */
  lead: AnswerInline[] | null
  blocks: AnswerBlock[]
  /** What the answer says it could not check ("Not covered: …"), without the label. */
  notCovered: string | null
  /** True when the text followed the structured grammar. */
  structured: boolean
}

/** What inline pieces are resolved against. */
export interface AnswerContext {
  sources: readonly Pick<AskSource, 'n' | 'file' | 'project' | 'featureId' | 'label'>[]
  /** A feature id's name, when the board knows it; null draws the id's own last segment. */
  featureName: (id: string) => string | null
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/
const NOT_COVERED = /^(?:\*\*)?not covered(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/i
const NOT_COVERED_HEADING = /^not covered\s*:?$/i

/** Known source-file extensions — a dotted name is a file only with one of these (`tenant.alias` is not). */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'm', 'mm', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte',
  'yml', 'yaml', 'toml', 'ini', 'env', 'prisma', 'sql', 'graphql', 'gql', 'proto', 'sh', 'bash', 'zsh', 'txt',
  'xml', 'gradle', 'lock', 'dart', 'ex', 'exs', 'erl', 'scala', 'lua', 'r', 'jsonl',
])

/**
 * Read an answer's text. Structured text (a heading or a list line) becomes a
 * lead, headed sections and lists; anything else is old prose — paragraphs,
 * with an inline " - a - b - c" run made a list when it clearly is one.
 */
export function parseAnswer(text: string, context: AnswerContext): AnswerDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const structured = lines.some((line) => HEADING.test(line.trim()) || BULLET.test(line))
  const notCovered: string[] = []
  const blocks: AnswerBlock[] = []
  let paragraph: string[] = []
  let list: string[] | null = null
  let inNotCovered = false

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim()
    paragraph = []
    if (joined === '') return
    if (inNotCovered) notCovered.push(joined)
    else blocks.push({ kind: 'paragraph', inline: parseInline(joined, context) })
  }
  const flushList = (): void => {
    if (list === null) return
    const items = list.map((item) => item.replace(/\s+/g, ' ').trim()).filter((item) => item !== '')
    list = null
    if (items.length === 0) return
    if (inNotCovered) notCovered.push(...items)
    else blocks.push({ kind: 'list', items: items.map((item) => parseInline(item, context)) })
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      const title = stripStrong(heading[1])
      // A "### Not covered" section is the callout, not a section.
      inNotCovered = NOT_COVERED_HEADING.test(title)
      if (!inNotCovered) blocks.push({ kind: 'heading', inline: parseInline(title, context) })
      continue
    }
    const gap = NOT_COVERED.exec(line)
    if (gap !== null) {
      flushParagraph()
      flushList()
      if (gap[1].trim() !== '') notCovered.push(gap[1].trim())
      else inNotCovered = true
      continue
    }
    const bullet = BULLET.exec(raw)
    if (bullet !== null) {
      flushParagraph()
      if (list === null) list = []
      list.push(bullet[1])
      continue
    }
    if (list !== null && /^\s{2,}/.test(raw)) {
      // An indented continuation of the list item above.
      list[list.length - 1] = `${list[list.length - 1] ?? ''} ${line}`
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()

  if (!structured) {
    // OLD PROSE: paragraphs, and a clear inline list made a real one.
    const prose: AnswerBlock[] = []
    for (const block of blocks) {
      if (block.kind !== 'paragraph') {
        prose.push(block)
        continue
      }
      const split = inlineList(inlineText(block.inline))
      if (split === null) {
        prose.push(block)
        continue
      }
      if (split.intro !== '') prose.push({ kind: 'paragraph', inline: parseInline(split.intro, context) })
      prose.push({ kind: 'list', items: split.items.map((item) => parseInline(item, context)) })
    }
    return { lead: null, blocks: prose, notCovered: notCovered.length > 0 ? notCovered.join(' ') : null, structured: false }
  }

  // THE LEAD: the first block, when it is a paragraph before any heading.
  let lead: AnswerInline[] | null = null
  if (blocks[0]?.kind === 'paragraph') {
    lead = blocks[0].inline
    blocks.shift()
  }
  return { lead, blocks, notCovered: notCovered.length > 0 ? notCovered.join(' ') : null, structured: true }
}

function stripStrong(text: string): string {
  return text.replace(/^\*\*(.+)\*\*$/, '$1').trim()
}

/** The plain text of some inline pieces, as the model wrote them (for re-reading prose). */
function inlineText(inline: readonly AnswerInline[]): string {
  return inline
    .map((piece) => {
      switch (piece.kind) {
        case 'text':
          return piece.text
        case 'strong':
          return `**${piece.text}**`
        case 'code':
        case 'file':
          return `\`${piece.text}\``
        case 'feature':
          return `\`${piece.id}\``
        case 'cite':
          return `[${String(piece.n)}]`
      }
    })
    .join('')
}

/**
 * An old answer's inline list: "Intro: - a - b - c". It is a list only when it
 * clearly is one — at least three " - " separated items, or two after an intro
 * ending in a colon — and no item is a whole page. A lone " - " is a dash.
 */
export function inlineList(text: string): { intro: string; items: string[] } | null {
  const trimmed = text.trim()
  const startsWithDash = /^-\s+\S/.test(trimmed)
  const body = startsWithDash ? trimmed.replace(/^-\s+/, '') : trimmed
  const parts = body.split(/\s+-\s+(?=\S)/).map((part) => part.trim())
  const intro = startsWithDash ? '' : (parts.shift() ?? '')
  const items = parts.filter((part) => part !== '')
  if (items.length < 2) return null
  if (items.length < 3 && !startsWithDash && !intro.endsWith(':')) return null
  if (items.some((item) => item.length > 280)) return null
  return { intro, items }
}

/** Inline pieces of one line: `code`, **strong**, and [n] citations. */
export function parseInline(text: string, context: AnswerContext): AnswerInline[] {
  const out: AnswerInline[] = []
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g
  let at = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > at) pushText(out, text.slice(at, match.index))
    if (match[1] !== undefined) out.push(classifyCode(match[1], context))
    else if (match[2] !== undefined) out.push({ kind: 'strong', text: match[2] })
    else if (match[3] !== undefined) {
      for (const n of match[3].split(',')) out.push({ kind: 'cite', n: Number(n.trim()) })
    }
    at = match.index + match[0].length
  }
  if (at < text.length) pushText(out, text.slice(at))
  return out
}

function pushText(out: AnswerInline[], text: string): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last !== undefined && last.kind === 'text') last.text += text
  else out.push({ kind: 'text', text })
}

/** A backticked name: a feature id, a file, or code. */
export function classifyCode(raw: string, context: AnswerContext): AnswerInline {
  const text = raw.trim()
  if (/^feature:[A-Za-z0-9._:/-]+$/.test(text)) {
    const label = context.featureName(text) ?? sourceLabelFor(text, context) ?? featureIdLabel(text)
    return { kind: 'feature', id: text, label }
  }
  if (isFileLike(text)) {
    const source = matchSourceFile(text, context)
    if (source !== null) return { kind: 'file', text, path: source.file, ...(source.project !== undefined ? { project: source.project } : {}) }
    return { kind: 'file', text, path: text.includes('/') ? text.replace(/^\.\//, '') : null }
  }
  return { kind: 'code', text }
}

/** A repo path or a file name: no spaces, a known extension, nothing that reads as a call. */
export function isFileLike(text: string): boolean {
  if (/\s|[()=<>{}"',;]/.test(text)) return false
  const match = /^[\w@.\-/[\]+]*?([\w@\-[\]+]+)\.([A-Za-z0-9]{1,8})$/.exec(text)
  if (match === null) return false
  return FILE_EXTENSIONS.has(match[2].toLowerCase())
}

function matchSourceFile(text: string, context: AnswerContext): { file: string; project?: string } | null {
  const wanted = text.replace(/^\.\//, '')
  for (const source of context.sources) {
    if (source.file === undefined) continue
    if (source.file === wanted || source.file.endsWith(`/${wanted}`) || wanted.endsWith(`/${source.file}`)) {
      return { file: source.file, ...(source.project !== undefined ? { project: source.project } : {}) }
    }
  }
  return null
}

function sourceLabelFor(id: string, context: AnswerContext): string | null {
  const source = context.sources.find((candidate) => candidate.featureId === id)
  return source === undefined ? null : source.label
}

/** `feature:tenant-admin/roles` → "Roles"; a qualified id drops its project. */
export function featureIdLabel(id: string): string {
  const local = splitQualifiedFeatureId(id)?.localId ?? id
  const bare = local.replace(/^feature:/, '')
  const last = bare.split('/').pop() ?? bare
  return last.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/* ── Suggested questions (no model call) ────────────────────────────────── */

export interface SuggestInput {
  /** The feature the question is scoped to, when exactly one is. */
  focus: { name: string; parts: readonly string[]; related: readonly string[] } | null
  /** Workspace scope: the projects' names; project scope: empty. */
  projects: readonly string[]
  /** The project's (or the Workspace's) name, when known. */
  scopeName: string | null
  /** The biggest features in scope, biggest first. */
  features: readonly string[]
}

/** Two or three questions worth asking here, from templates — the same scope always gives the same ones. */
export function suggestedQuestions(input: SuggestInput): string[] {
  const out: string[] = []
  const add = (question: string | null): void => {
    if (question !== null && !out.includes(question) && out.length < 3) out.push(question)
  }
  const focus = input.focus
  if (focus !== null) {
    add(`How does ${focus.name} work, from start to finish?`)
    add(focus.parts[0] !== undefined ? `What does ${focus.parts[0]} do in ${focus.name}?` : null)
    add(focus.related[0] !== undefined ? `How does ${focus.name} connect to ${focus.related[0]}?` : null)
    add(`Where would a change to ${focus.name} start?`)
    add(`What could break if ${focus.name} changes?`)
    return out
  }
  if (input.projects.length >= 2) {
    add(`How do ${input.projects[0]} and ${input.projects[1]} talk to each other?`)
    add(input.features[0] !== undefined ? `Where does ${input.features[0]} live, and who uses it?` : null)
    add('Which projects share data, and how?')
    return out
  }
  add(`What are the main parts of ${input.scopeName ?? 'this project'}, and how do they fit together?`)
  add(input.features[0] !== undefined ? `How does ${input.features[0]} work?` : null)
  add(input.features[0] !== undefined && input.features[1] !== undefined ? `How do ${input.features[0]} and ${input.features[1]} connect?` : null)
  add('Where would a new feature usually start?')
  return out
}

/* ── Your recent questions ──────────────────────────────────────────────── */

export interface RecentRow {
  id: string
  question: string
  /** "4 h ago · Tenant". */
  meta: string
  thread: AskSavedThread
}

/** Newest first, at most `max`; the meta names the first tag the question was asked about. */
export function recentRows(
  threads: readonly AskSavedThread[],
  now: number,
  tagName: (id: string) => string | null,
  max = 4,
): RecentRow[] {
  return [...threads]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .slice(0, max)
    .map((thread) => {
      const first = thread.tags.find((id) => id.startsWith('feature:') || id.startsWith('project:'))
      const tag = first === undefined ? null : (tagName(first) ?? featureIdLabel(first.replace(/^project:/, 'feature:')))
      return {
        id: thread.id,
        question: thread.question,
        meta: [ageLabel(thread.ts, now), tag ?? ''].filter((part) => part !== '').join(' · '),
        thread,
      }
    })
}

/* ── Questions per feature (the board's cell markers) ───────────────────── */

/**
 * How many saved questions touch each feature or part: a question counts on
 * every id it was tagged with or cites, and a part's question counts on its
 * feature too — once per question, however often it names it.
 */
export function questionCounts(threads: readonly AskSavedThread[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const thread of threads) {
    const ids = new Set<string>()
    for (const entry of [thread, ...thread.followUps]) {
      for (const id of entry.tags) if (id.startsWith('feature:')) addWithOwner(ids, id)
      for (const source of entry.sources) if (source.featureId !== undefined) addWithOwner(ids, source.featureId)
    }
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

function addWithOwner(ids: Set<string>, id: string): void {
  ids.add(id)
  const slash = id.indexOf('/')
  if (slash !== -1) ids.add(id.slice(0, slash))
}

/** "1 question" / "4 questions" — the marker's accessible words. */
export function questionCountLabel(count: number, featureName: string): string {
  return `${String(count)} question${count === 1 ? '' : 's'} you asked about ${featureName}`
}
