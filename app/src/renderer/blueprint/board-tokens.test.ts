/**
 * Every `--fb-*` the board PAINTS with has to resolve to something (#1564).
 *
 * `var(--fb-nope)` with no fallback is not a CSS error — it makes the whole
 * declaration invalid at computed-value time and the property silently falls
 * back to its initial value. A background disappears, a border vanishes, a font
 * quietly reverts to the UI face, and nothing anywhere says so. The board's own
 * source carries a comment recording two rounds of exactly this (`--fb-bg`
 * #1531, `--fl-shadow-md` #1473); #1564 was the third, and reviewing 13k lines
 * of template literal by eye is what let it be the third.
 *
 * So the invariant is checked instead of watched for. A token is legitimate when
 * it is defined in the stylesheet OR pushed from JS at runtime (the pulse and
 * in-flight animations set theirs per element); a use WITH a fallback is fine by
 * construction, because the fallback is what renders. What must never appear is
 * a bare `var(--fb-x)` naming a token nothing provides.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BOARD = join(__dirname, 'blueprint-board.ts')

/**
 * Bare uses only — `var(--fb-x)` and never `var(--fb-x, something)`. A fallback
 * means the declaration still computes, which is a style choice rather than the
 * silent-blanking bug this guards.
 */
function bareUses(source: string): Set<string> {
  return new Set([...source.matchAll(/var\((--fb-[a-z0-9-]+)\)/g)].map((match) => match[1]))
}

/** Tokens the stylesheet itself declares, in any theme block. */
function declared(source: string): Set<string> {
  return new Set([...source.matchAll(/^\s*(--fb-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]))
}

/** Tokens pushed from JS — `style.setProperty('--fb-x', …)`. */
function runtimeSet(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/setProperty\(\s*['"`](--fb-[a-z0-9-]+)['"`]/g)].map((match) => match[1]),
  )
}

/**
 * Known-broken and deliberately NOT auto-fixed: a painted token stays listed
 * until someone chooses its colour — a visual decision, not a mechanical
 * substitution. Listed exactly rather than pattern-matched so the test stays a
 * characterization: fixing one fails here and asks for the list to shrink.
 *
 * Empty means the debt is paid. The last two — `--fb-grid-strong` (now the
 * card-border weight) and `--fb-well` (now the ground colour, recessed one
 * layer below `--fb-card`) — are aliased in the base token block.
 */
const KNOWN_BROKEN: string[] = []

/**
 * A selector restating the same declarations twice is dead weight at best and
 * a paste error at worst: 121 lines of popover CSS were once pasted INSIDE the
 * reduced-motion media query, where they duplicated the live rules above and
 * buried the query's one real rule (`.fb-learn-chip { transition: none }`).
 * Same characterization contract as KNOWN_BROKEN: each entry is a substring
 * marking one known-duplicated rule, and fixing one fails the length check and
 * asks for the list to shrink. Empty means the debt is paid — the last entry
 * (the dark palette declared under both `prefers-color-scheme: dark` and
 * `[data-theme='dark']`) left when the theme blocks collapsed to base + one
 * dark override.
 */
const KNOWN_DUPLICATED: string[] = []

/** Whitespace-normalized rules that appear more than once, sorted. */
function duplicatedRules(source: string): string[] {
  const rules = [...source.matchAll(/(?:\.flow-board-root|@keyframes|@media)[^{}]*\{[^{}]*\}/g)].map(
    (match) => match[0].replace(/\s+/g, ' ').trim(),
  )
  const counts = new Map<string, number>()
  for (const rule of rules) counts.set(rule, (counts.get(rule) ?? 0) + 1)
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([rule]) => rule)
    .sort()
}

describe('board tokens resolve to something', () => {
  const source = readFileSync(BOARD, 'utf-8')

  it('paints with no token that is neither declared nor set at runtime', () => {
    const provided = new Set([...declared(source), ...runtimeSet(source)])
    const unresolved = [...bareUses(source)].filter((token) => !provided.has(token)).sort()

    // The failure message has to name the tokens: "some token is undefined" in a
    // 13k-line stylesheet is a bug report nobody can act on.
    expect(unresolved).toEqual([...KNOWN_BROKEN].sort())
  })

  it('resolves the three #1564 reported — the regression this came from', () => {
    const provided = new Set([...declared(source), ...runtimeSet(source)])
    for (const token of ['--fb-card-bg', '--fb-line', '--fb-mono']) {
      // Gone entirely rather than merely provided: each was replaced by the
      // token that already existed, so the alias should not come back either.
      expect(source).not.toContain(`var(${token})`)
      expect(provided.has(token)).toBe(false)
    }
  })

  it('still declares the tokens those uses were pointed at', () => {
    const provided = declared(source)
    for (const token of ['--fb-card', '--fb-border']) {
      expect(provided.has(token)).toBe(true)
    }
    // `--fl-font-mono` is a global :root token from theme/tokens.css, so it is
    // in scope inside `.flow-board-root` and is not declared here.
    expect(source).toContain('var(--fl-font-mono, ui-monospace, monospace)')
  })

  it('declares no rule twice with identical declarations', () => {
    const dups = duplicatedRules(source)
    const unexplained = dups.filter(
      (rule) => !KNOWN_DUPLICATED.some((mark) => rule.includes(mark)),
    )
    expect(unexplained).toEqual([])
    expect(dups).toHaveLength(KNOWN_DUPLICATED.length)
  })
})
