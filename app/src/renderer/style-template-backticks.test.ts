/**
 * NO BACKTICKS INSIDE A CSS TEMPLATE LITERAL.
 *
 * Several modules here hold their stylesheet as a template literal. A backtick
 * anywhere inside one — including in a CSS comment, where it is the natural way
 * to name a selector or a property — ENDS THE LITERAL. The failure is a TS1005
 * pointing at a line that looks fine, and a vite build that names no cause.
 *
 * This has cost four separate builds in this repo, all of them in a comment
 * written to be helpful. A lint rule is the honest fix: a person cannot be
 * relied on to remember, and the compiler's message does not say what is wrong.
 *
 * Reads the SOURCE as text rather than importing it — these modules touch the
 * DOM and cannot be imported under this app's node-environment jest, which is
 * also why the mistake reaches a build instead of a test.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Modules whose stylesheet lives in a template literal — DISCOVERED, not listed.
 *
 * This was a hand-written array of four paths, and it had already drifted: the
 * settings panel carries one of the largest CSS literals in the app and was
 * never on it, so the rule did not cover the file most likely to gain a new
 * selector. A guard whose subjects are maintained by hand protects whatever
 * somebody remembered, which is not the same set as whatever is at risk.
 */
function styledModules(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...styledModules(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      if (OPENS_CSS.test(readFileSync(full, 'utf8'))) found.push(relative(process.cwd(), full))
    }
  }
  return found.sort()
}

/** The line that OPENS a stylesheet literal — the same shape the scanner below keys on. */
const OPENS_CSS = /(?:textContent|STYLES|styles|cssText)\s*=\s*`\s*$/m

const STYLED_MODULES = styledModules(join(process.cwd(), 'src/renderer'))

/** Unescaped backticks inside a STYLES template literal. */
function offendingLines(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  const lines = source.split('\n')
  let inCss = false
  lines.forEach((line, index) => {
    // Only a STYLES template, not every template literal: an innerHTML one
    // legitimately carries an escaped backtick (the ⌃` shortcut is written in
    // this very file), and flagging that would make the rule noise.
    if (!inCss && /(?:textContent|STYLES|styles|cssText)\s*=\s*`\s*$/.test(line)) {
      inCss = true
      return
    }
    if (inCss && /^\s*`/.test(line)) {
      inCss = false
      return
    }
    // An ESCAPED backtick is fine — it is the unescaped one that ends the
    // literal. Remove the escapes before looking.
    if (inCss && line.replace(/\\`/g, '').includes('`')) {
      out.push({ line: index + 1, text: line.trim() })
    }
  })
  return out
}

describe('CSS template literals', () => {
  it.each(STYLED_MODULES)('has no backtick inside the styles of %s', (relPath) => {
    const source = readFileSync(join(process.cwd(), relPath), 'utf8')
    const offenders = offendingLines(source)
    // The message IS the value here: TS1005 points at the wrong line and says
    // nothing about backticks.
    expect(
      offenders.map((o) => `${relPath}:${o.line} — ${o.text.slice(0, 70)}`),
    ).toEqual([])
  })
})
