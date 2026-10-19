/**
 * `console.log` FORMAT DIRECTIVES, applied rather than printed.
 *
 * A page that calls
 *
 *   console.warn('%cElectron Security Warning%c\n\nThis renderer…',
 *                'font-weight: bold;', 'font-weight: normal;')
 *
 * has three arguments, and joining them with a space produces
 *
 *   %cElectron Security Warning%c … font-weight: bold; font-weight: normal;
 *
 * — the directives shown raw and the CSS they referred to tacked on the end.
 * That is what the drawer displayed (user, 2026-09-21), and it cannot be
 * repaired later: by then the style strings are indistinguishable from message
 * text, and stripping what LOOKS like CSS would eat real content. It has to
 * happen where the arguments are still separate.
 *
 * WHAT THIS DOES AND DOES NOT DO. It consumes the directives the way a console
 * does — `%s`, `%d`/`%i`, `%f`, `%o`/`%O`/`%j` take the next argument, `%c`
 * takes one and CONTRIBUTES NOTHING (this is text, not a rendered console), and
 * `%%` is a literal percent. Anything left over is appended, because a page
 * that passes more arguments than directives means them to be seen.
 *
 * Pure: strings in, string out.
 */

/** A directive that consumes an argument and substitutes it. */
const SUBSTITUTING = new Set(['s', 'd', 'i', 'f', 'o', 'O', 'j'])

/**
 * Apply the first argument's directives to the rest.
 *
 * `args` are already rendered to strings — this decides how they combine, not
 * how each one prints.
 */
export function formatConsoleArgs(args: readonly string[]): string {
  const [first, ...rest] = args
  if (first === undefined) return ''
  // No directives: the console's own behaviour is to join with a space.
  if (!/%[sdifoOjc%]/.test(first)) return args.join(' ')

  let out = ''
  let at = 0
  let consumed = 0
  while (at < first.length) {
    const char = first[at]
    if (char !== '%') {
      out += char
      at += 1
      continue
    }
    const directive = first[at + 1]
    if (directive === undefined) {
      out += '%'
      at += 1
      continue
    }
    if (directive === '%') {
      out += '%'
      at += 2
      continue
    }
    if (directive === 'c') {
      // STYLE, WHICH TEXT CANNOT CARRY. The argument is consumed and dropped —
      // printing it is how `font-weight: bold;` ended up in the middle of a
      // security warning.
      consumed += 1
      at += 2
      continue
    }
    if (SUBSTITUTING.has(directive)) {
      const value = rest[consumed]
      consumed += 1
      // A directive with no argument left prints as itself, which is what a
      // console does and is a truer reading than an empty gap.
      out += value === undefined ? `%${directive}` : value
      at += 2
      continue
    }
    out += char
    at += 1
  }

  // Arguments beyond the directives are still meant to be seen.
  const trailing = rest.slice(consumed)
  return trailing.length === 0 ? out : `${out} ${trailing.join(' ')}`
}
