/**
 * The Workspace palette — eight project hues and the connections' colour,
 * hand-picked per theme. Read straight out of the board's stylesheet, like
 * `board-contrast.test.ts`, so a value edited there is the value checked here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { WORKSPACE_PALETTE_SIZE } from './workspace-sheet'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const SOURCE = readFileSync(join(__dirname, 'blueprint-board.ts'), 'utf-8')

function values(token: string): string[] {
  const pattern = new RegExp(`^\\s*${token}\\s*:\\s*(#[0-9A-Fa-f]{6})\\s*;`, 'gm')
  return [...SOURCE.matchAll(pattern)].map((match) => match[1])
}

const [LIGHT_PAPER, DARK_PAPER] = values('--fb-paper')

/**
 * THE PROJECT HUES ARE THE APP'S (2026-10-06): one palette for the map, the
 * file tree, tabs and the switcher, declared once in the theme tokens — the
 * dark ground first (the base :root), then the light. Answered [light, dark]
 * like every board pair here.
 */
const TOKENS = readFileSync(join(__dirname, '..', 'theme', 'tokens.css'), 'utf-8')
function projectHue(slot: number): string[] {
  const pattern = new RegExp(`^\\s*--fl-project-hue-${String(slot)}\\s*:\\s*(#[0-9A-Fa-f]{6})\\s*;`, 'gm')
  const [dark, light] = [...TOKENS.matchAll(pattern)].map((match) => match[1])
  return [light, dark]
}

/** WCAG 1.4.11: a line or border that carries meaning needs 3:1 against its ground. */
const NON_TEXT = 3
const TEXT = 4.5

describe('workspace palette', () => {
  it('declares every slot once per theme, and each is a different hue', () => {
    for (const theme of [0, 1]) {
      const hues = Array.from({ length: WORKSPACE_PALETTE_SIZE }, (_, slot) => {
        const declared = projectHue(slot)
        expect(declared.filter(Boolean)).toHaveLength(2)
        // …and the board paints with them, never a copy.
        expect(SOURCE).toContain(`--fb-ws-hue-${String(slot)}: var(--fl-project-hue-${String(slot)});`)
        return declared[theme].toLowerCase()
      })
      expect(new Set(hues).size).toBe(WORKSPACE_PALETTE_SIZE)
    }
  })

  it('every project border and the connections read against their sheet, in both themes', () => {
    for (let slot = 0; slot < WORKSPACE_PALETTE_SIZE; slot += 1) {
      const [light, dark] = projectHue(slot)
      expect(contrastRatio(light, LIGHT_PAPER)).toBeGreaterThanOrEqual(NON_TEXT)
      expect(contrastRatio(dark, DARK_PAPER)).toBeGreaterThanOrEqual(NON_TEXT)
    }
    const [linkLight, linkDark] = values('--fb-ws-link')
    expect(contrastRatio(linkLight, LIGHT_PAPER)).toBeGreaterThanOrEqual(NON_TEXT)
    expect(contrastRatio(linkDark, DARK_PAPER)).toBeGreaterThanOrEqual(NON_TEXT)
    const [inkLight, inkDark] = values('--fb-ws-link-ink')
    expect(contrastRatio(inkLight, LIGHT_PAPER)).toBeGreaterThanOrEqual(TEXT)
    expect(contrastRatio(inkDark, DARK_PAPER)).toBeGreaterThanOrEqual(TEXT)
  })
})
