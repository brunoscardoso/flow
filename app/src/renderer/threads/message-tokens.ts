/**
 * Message tokens — pure, DOM-free.
 *
 * Splits a message into plain text, slash COMMANDS and `@` FILE mentions, so
 * the composer (while typing) and the feed (once sent) highlight exactly the
 * same runs. One tokenizer for both surfaces (allowed-pattern #14): a run the
 * input shows as a command is a run the sent message shows as a command.
 *
 * Display only. Concatenating every token's `text` gives back the input
 * unchanged — that is the invariant the tests pin and the reason a copied
 * message is plain text.
 *
 * What counts:
 *  - a COMMAND is `/name` where `name` is a known command or skill (the same
 *    list the composer's slash menu offers, asked through `isCommand`). The
 *    slash must start the text or follow whitespace or an opening bracket, and
 *    the name must not run on into another `/` or `@` — so `/usr/bin`, `1/2`,
 *    `https://x/create-plan` and an unknown `/word` stay plain. Trailing
 *    sentence punctuation (`/create-plan,` `/create-plan.`) is not part of it.
 *  - a FILE is an `@` reference as the composer writes it (mention-quoting.ts):
 *    a bare run of path characters, or a closed double-quoted path. The `@`
 *    must start the text or follow whitespace or an opening bracket — so an
 *    email (`a@b.com`) stays plain.
 */

export type MessageTokenKind = 'text' | 'command' | 'file'

export interface MessageToken {
  kind: MessageTokenKind
  text: string
}

/** Characters a command name may hold (Unicode letters/digits, `_ : . -`). */
const COMMAND_NAME = /^[\p{L}\p{N}_:.-]+/u
/** A bare mention's path characters — mention-quoting's `[\w./-]`, widened to
 *  Unicode letters/digits and `~` so a non-ASCII filename stays one run. */
const BARE_MENTION = /^[\p{L}\p{N}\p{M}_./~-]+/u
/** A closed quoted mention: `@"design docs/tokens.md"`. */
const QUOTED_MENTION = /^"(?:[^"\\\n]|\\.)*"/
/** Trailing characters that end a sentence rather than a name. */
const TRAILING_PUNCTUATION = /[.:,;!?-]+$/
/** What may stand right before a `/` or `@` for it to start a token. */
const OPENERS = new Set(['(', '[', '{', '"', "'", '`'])

function startsToken(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1] ?? ''
  return /\s/u.test(previous) || OPENERS.has(previous)
}

/** The command at `index` (a `/`), as its full text, or null. */
function commandAt(text: string, index: number, isCommand: (name: string) => boolean): string | null {
  const run = COMMAND_NAME.exec(text.slice(index + 1))?.[0]
  if (run === undefined) return null
  const following = text[index + 1 + run.length] ?? ''
  // `/usr/bin`, `/a@b` — the name runs on into a path or an address.
  if (following === '/' || following === '@' || following === '\\') return null
  const name = run.replace(TRAILING_PUNCTUATION, '')
  if (name.length === 0 || !isCommand(name)) return null
  return `/${name}`
}

/** The mention at `index` (an `@`), as its full text, or null. */
function mentionAt(text: string, index: number): string | null {
  const rest = text.slice(index + 1)
  const quoted = QUOTED_MENTION.exec(rest)?.[0]
  if (quoted !== undefined) return quoted.length > 2 ? `@${quoted}` : null
  const run = BARE_MENTION.exec(rest)?.[0]
  if (run === undefined) return null
  const following = rest[run.length] ?? ''
  if (following === '@') return null // `@a@b` is an address, not a path
  // A sentence-ending `.` or `-` is not part of the path; `./` and `../` stay.
  const path = run.replace(/[.-]+$/, (tail) => (run === tail ? tail : ''))
  if (!/[\p{L}\p{N}_~/]/u.test(path)) return null
  return `@${path}`
}

/**
 * Split `text` into plain, command and file tokens. `isCommand(name)` answers
 * whether `name` (no leading slash) is a known command or skill.
 */
export function tokenizeMessage(text: string, isCommand: (name: string) => boolean): MessageToken[] {
  const tokens: MessageToken[] = []
  let plainStart = 0
  let index = 0
  const flushPlain = (end: number): void => {
    if (end > plainStart) tokens.push({ kind: 'text', text: text.slice(plainStart, end) })
  }
  while (index < text.length) {
    const char = text[index]
    if ((char === '/' || char === '@') && startsToken(text, index)) {
      const run = char === '/' ? commandAt(text, index, isCommand) : mentionAt(text, index)
      if (run !== null) {
        flushPlain(index)
        tokens.push({ kind: char === '/' ? 'command' : 'file', text: run })
        index += run.length
        plainStart = index
        continue
      }
    }
    index += 1
  }
  flushPlain(text.length)
  return tokens
}

/** Whether any token is a command or a file — nothing to highlight otherwise. */
export function hasHighlights(tokens: readonly MessageToken[]): boolean {
  return tokens.some((token) => token.kind !== 'text')
}
