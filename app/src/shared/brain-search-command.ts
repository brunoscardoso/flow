/**
 * Brain-search command matching — the ONE code path (allowed-pattern #14)
 * that decides "this Bash command is a `planflow-ai brain search`". Used by
 * BOTH the main-process brain-usage analyzer (counters) and the renderer
 * tool-card (the "Knowledge search" card), so the card and the counters can
 * never disagree about what a brain search is.
 *
 * Matches any spelling that reaches the real CLI: the PATH shim
 * (`planflow-ai brain search`), the bundled CLI (`.../planflow-ai.mjs brain
 * search`), or repo dev (`node dist/cli/index.js brain search`). A bare
 * `brain search` with no invoker is not a real command and does not match;
 * neither does a text-search command (grep/rg/echo/...) that merely mentions
 * the invocation in its arguments.
 *
 * Pure and dependency-free — plain-Node loadable from main, renderer, and
 * the CJS ts-jest suite alike.
 */

/** A recognized brain-search invocation: the query text and optional scope. */
export interface BrainSearchMatch {
  query: string
  scope?: string
}

/** Invoker + verb — the same spellings the Phase 4 analyzer recognized. */
const BRAIN_SEARCH_PATTERN = /(?:planflow-ai(?:\.mjs)?|plan-flow|index\.js)['"]?\s+brain\s+search\b/

/** Command words that read text rather than run it — a `grep "planflow-ai
 *  brain search"` is a mention, not a search. */
const TEXT_TOOL_WORDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'find', 'echo', 'printf', 'cat', 'sed', 'awk'])

/** Flags of `brain search` that consume a value token. `--scope` is handled
 *  separately (its value is surfaced); unknown `--flag value` pairs are rare
 *  enough that treating the value as positional is the safer default. */
const VALUE_FLAGS = new Set(['--limit'])

/**
 * True when the last command word before `index` in `command` is a
 * text-reading tool — i.e. the brain-search spelling appears as an argument
 * to grep/rg/echo/... rather than as the command being run.
 */
function isTextToolMention(command: string, index: number): boolean {
  const prefix = command.slice(0, index)
  const segments = prefix.split(/[;|&`(]/)
  const lastSegment = segments[segments.length - 1]?.trim() ?? ''
  const firstWord = lastSegment.split(/\s+/)[0] ?? ''
  const basename = firstWord.split('/').pop() ?? ''
  return TEXT_TOOL_WORDS.has(basename)
}

/**
 * Split the text after `brain search` into shell-ish argument tokens.
 * Handles double quotes (with backslash escapes), single quotes (literal),
 * and bare words. Stops at an unquoted command boundary (`|`, `;`, `&`,
 * backtick) so trailing noise like `|| echo "NO_BRAIN_CLI"` never leaks into
 * the query. Redirections (`2>/dev/null`, `2>&1`, `> out.txt`) are skipped
 * along with their targets.
 */
function tokenizeArgs(rest: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  let i = 0

  const push = (): void => {
    if (inToken) {
      tokens.push(current)
      current = ''
      inToken = false
    }
  }

  while (i < rest.length) {
    const ch = rest[i] as string
    if (quote !== null) {
      if (quote === '"' && ch === '\\' && i + 1 < rest.length) {
        current += rest[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        i += 1
        continue
      }
      current += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < rest.length) {
      current += rest[i + 1]
      inToken = true
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      push()
      i += 1
      continue
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '`') {
      // Command boundary — everything after is a different command.
      push()
      return tokens
    }
    if (ch === '>' || ch === '<') {
      // Redirection: a pure-digit current token is the fd (`2>`), not an arg.
      if (/^\d+$/.test(current)) {
        current = ''
        inToken = false
      } else {
        push()
      }
      i += 1
      while (i < rest.length && (rest[i] === '>' || rest[i] === '&')) i += 1
      while (i < rest.length && /\s/.test(rest[i] as string)) i += 1
      while (i < rest.length && !/[\s|;&`<>]/.test(rest[i] as string)) i += 1
      continue
    }
    current += ch
    inToken = true
    i += 1
  }
  push()
  return tokens
}

/**
 * Match a Bash command against the brain-search spellings and extract the
 * query (and `--scope` when given). Returns null for anything that is not a
 * real brain-search invocation. Flags and shell noise (redirections,
 * `|| echo ...` fallbacks) never appear in the query.
 */
export function matchBrainSearch(command: string): BrainSearchMatch | null {
  const match = BRAIN_SEARCH_PATTERN.exec(command)
  if (!match) return null
  if (isTextToolMention(command, match.index)) return null

  const tokens = tokenizeArgs(command.slice(match.index + match[0].length))
  const positional: string[] = []
  let scope: string | undefined
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    if (token === '--scope') {
      const value = tokens[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        scope = value
        i += 1
      }
      continue
    }
    if (token.startsWith('--scope=')) {
      scope = token.slice('--scope='.length)
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      i += 1
      continue
    }
    if (token.startsWith('--')) continue
    positional.push(token)
  }

  const query = positional.join(' ').trim()
  return scope === undefined ? { query } : { query, scope }
}

/** True when the command invokes `brain search` through a real CLI entry. */
export function isBrainSearchCommand(command: string): boolean {
  return matchBrainSearch(command) !== null
}
