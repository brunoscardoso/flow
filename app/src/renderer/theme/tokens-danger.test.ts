/**
 * `--fl-color-danger` was referenced across 15+ call sites (several with no
 * CSS fallback at all, e.g. thread-sidebar.ts's inline
 * `color:var(--fl-color-danger)`) but never declared in tokens.css - every
 * "danger" element silently fell back to the same hardcoded literal in both
 * themes, forever. Guards the fix the same way board-tokens.test.ts guards
 * `--fb-*`: the token must be DECLARED, in both theme blocks, not merely
 * assumed from a fallback value baked into each consumer.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS = join(__dirname, 'tokens.css')

function declaredIn(source: string, token: string): number {
  return [...source.matchAll(new RegExp('^\\s*' + token + '\\s*:', 'gm'))].length
}

describe('--fl-color-danger is declared for both themes', () => {
  const source = readFileSync(TOKENS, 'utf-8')

  it('is declared exactly twice - once per theme block', () => {
    expect(declaredIn(source, '--fl-color-danger')).toBe(2)
  })

  it('sits alongside --fl-color-error and --fl-color-warning in each block', () => {
    const darkBlock = source.slice(source.indexOf(':root {'), source.indexOf("[data-theme='light']"))
    const lightBlock = source.slice(source.indexOf("[data-theme='light']"))
    for (const block of [darkBlock, lightBlock]) {
      expect(declaredIn(block, '--fl-color-error')).toBe(1)
      expect(declaredIn(block, '--fl-color-warning')).toBe(1)
      expect(declaredIn(block, '--fl-color-danger')).toBe(1)
    }
  })
})