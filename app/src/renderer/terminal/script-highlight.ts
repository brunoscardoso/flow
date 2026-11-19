/**
 * LIGHT SHELL COLOURING for the Launchpad's script editor — DOM-free, so it is
 * tested in plain Node. It only paints: comments, quoted strings, variables,
 * shell keywords and the program each command starts with. It never parses
 * the script for meaning; a wrong colour is the worst it can do.
 *
 * The output is a list of plain-text pieces with a class each; the editor
 * writes them as text nodes (never as HTML), so a script can hold anything.
 */

export type ShellTokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'program' | 'variable'

export interface ShellToken {
  kind: ShellTokenKind
  text: string
}

const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'return', 'set', 'export', 'local', 'select', 'exit',
])

/** Words after which the next word starts a command. */
const COMMAND_STARTERS = new Set(['then', 'else', 'do', 'if', 'elif', 'while', 'until', '!', 'time', 'exec'])

function push(out: ShellToken[], kind: ShellTokenKind, text: string): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last !== undefined && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

/** One line's pieces. */
export function highlightShellLine(line: string): ShellToken[] {
  const out: ShellToken[] = []
  let i = 0
  let atCommand = true
  while (i < line.length) {
    const ch = line[i]!
    // A comment: `#` at the start of a word runs to the end of the line.
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      push(out, 'comment', line.slice(i))
      break
    }
    if (ch === "'" || ch === '"') {
      let end = i + 1
      while (end < line.length && line[end] !== ch) {
        if (ch === '"' && line[end] === '\\') end += 1
        end += 1
      }
      push(out, 'string', line.slice(i, Math.min(line.length, end + 1)))
      i = end + 1
      atCommand = false
      continue
    }
    if (ch === '$') {
      const match = /^\$(\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(line.slice(i))
      if (match !== null) {
        push(out, 'variable', match[0])
        i += match[0].length
        atCommand = false
        continue
      }
    }
    if (/\s/.test(ch)) {
      push(out, 'plain', ch)
      i += 1
      continue
    }
    // `2>&1`: a redirection, not a command running in the background.
    if (ch === '&' && line[i - 1] === '>') {
      push(out, 'plain', ch)
      i += 1
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      push(out, 'plain', ch)
      i += 1
      atCommand = true
      continue
    }
    const word = /^[^\s;|&()'"$#{}]+/.exec(line.slice(i))?.[0] ?? ch
    if (KEYWORDS.has(word)) {
      push(out, 'keyword', word)
      atCommand = COMMAND_STARTERS.has(word)
    } else if (atCommand && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      push(out, 'program', word)
      atCommand = false
    } else {
      push(out, 'plain', word)
    }
    i += word.length
  }
  return out
}

/** Every line's pieces, lines joined back with their newline. */
export function highlightShell(text: string): ShellToken[] {
  const out: ShellToken[] = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const token of highlightShellLine(line)) push(out, token.kind, token.text)
    if (index < lines.length - 1) push(out, 'plain', '\n')
  })
  return out
}
