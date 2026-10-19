/**
 * The board's small text has to be readable, in both themes (#1565).
 *
 * The board paints dense 10-11.5px labels — breadcrumbs, verify/witness links,
 * the approve-all button, sync verdicts — in its accent, stale and drift hues.
 * At that size WCAG AA asks 4.5:1, and the light theme was shipping 3.47-4.24:1:
 * not invisible, just washed out on the warm off-white ground, which is exactly
 * the kind of thing nobody files and everybody squints at.
 *
 * CONTRAST IS NOT THE ONLY BAR, and this file learned that the hard way. The
 * `--fb-learn-known` exercise recorded in blueprint-board.ts rejected its own
 * first darkening (#1F6B45) even though it cleared contrast at 5.78:1, because
 * OKLCH chroma fell to 0.096 — under the 0.10 floor the hue stops reading as a
 * colour and starts reading as "dark". #1565's own suggested drift value
 * (#0B7181) makes precisely that mistake: 5.44:1 and chroma 0.086.
 *
 * So both bars are checked here, together, over the values actually in the
 * stylesheet. Computed rather than asserted as literals — a table of expected
 * ratios would be a second thing to keep in sync with the palette.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BOARD = join(__dirname, 'blueprint-board.ts')

/** WCAG AA for text below ~18px. */
const MIN_CONTRAST = 4.5

/** The floor below which a hue reads as grey rather than as itself. */
const MIN_CHROMA = 0.1

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/** sRGB → linear, the transfer function both formulas below start from. */
function linear(hex: string): [number, number, number] {
  return channels(hex).map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = linear(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** OKLCH chroma — how far the colour sits from the grey axis. */
export function chroma(hex: string): number {
  const [r, g, b] = linear(hex)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return Math.hypot(A, B)
}

/**
 * Read a token's value out of a theme block.
 *
 * The stylesheet declares each themed token exactly ONCE per theme — the base
 * block (light) and the `[data-theme='dark']` override. Every occurrence is
 * collected so an accidental re-declaration (the four-block era's failure
 * mode) shows up as a count change here.
 */
function tokenValues(source: string, token: string): string[] {
  const pattern = new RegExp(`^\\s*${token}\\s*:\\s*(#[0-9A-Fa-f]{6})\\s*;`, 'gm')
  return [...source.matchAll(pattern)].map((match) => match[1])
}

describe('board palette: small text is readable', () => {
  const source = readFileSync(BOARD, 'utf-8')

  /** [light, dark] for a token, proven to be declared consistently in each theme. */
  function themePair(token: string): { light: string; dark: string } {
    const values = tokenValues(source, token)
    // One declaration per theme, base (light) first — a third occurrence
    // means a duplicate block crept back.
    expect(values).toHaveLength(2)
    const [light, dark] = values
    return { light, dark }
  }

  const grounds = { paper: { light: '#F4F2EC', dark: '#0C1320' }, card: { light: '#FBFAF6', dark: '#122943' } }

  const inks: Array<{ token: string; ground: keyof typeof grounds }> = [
    { token: '--fb-accent', ground: 'paper' },
    { token: '--fb-learn-stale', ground: 'card' },
    { token: '--fb-drift', ground: 'card' },
    // #1566 — warning and danger were hardcoded dark-tuned hues outside the
    // theme blocks, so the light theme rendered them at 2.42:1 and 3.23:1.
    { token: '--fb-warn', ground: 'card' },
    { token: '--fb-danger', ground: 'card' },
  ]

  for (const { token, ground } of inks) {
    it(`${token} clears ${String(MIN_CONTRAST)}:1 as text, in both themes`, () => {
      const { light, dark } = themePair(token)
      expect(contrastRatio(light, grounds[ground].light)).toBeGreaterThanOrEqual(MIN_CONTRAST)
      expect(contrastRatio(dark, grounds[ground].dark)).toBeGreaterThanOrEqual(MIN_CONTRAST)
    })

    it(`${token} still reads as a colour, not as grey`, () => {
      const { light, dark } = themePair(token)
      // Both halves: darkening for contrast is what drains chroma, so the light
      // value is the one at risk — but a future dark-theme edit gets the same bar.
      expect(chroma(light)).toBeGreaterThanOrEqual(MIN_CHROMA)
      expect(chroma(dark)).toBeGreaterThanOrEqual(MIN_CHROMA)
    })
  }

  it('keeps the semantic states out of the rules that use them (#1566)', () => {
    // The bug was not the hues — it was hardcoding them where no theme could
    // reach. A literal outside the token blocks is what must not come back.
    const blocks = source.slice(source.indexOf('--fb-paper:'), source.lastIndexOf('--fb-danger:') + 40)
    for (const hue of ['#d29922', '#d06c6c', '#d66c6c']) {
      const everywhere = source.split(hue).length - 1
      const inBlocks = blocks.split(hue).length - 1
      expect({ hue, outsideTheThemeBlocks: everywhere - inBlocks }).toEqual({
        hue,
        outsideTheThemeBlocks: 0,
      })
    }
  })

  it('rejects the values that shipped, and the one #1565 suggested', () => {
    // Guards against a well-meaning revert: each of these looks reasonable and
    // fails one of the two bars.
    expect(contrastRatio('#0E7FB8', '#F4F2EC')).toBeLessThan(MIN_CONTRAST) // old accent
    expect(contrastRatio('#B8791E', '#FBFAF6')).toBeLessThan(MIN_CONTRAST) // old stale
    expect(contrastRatio('#0E8A9E', '#FBFAF6')).toBeLessThan(MIN_CONTRAST) // old drift
    // The issue's own drift proposal: contrast fine, chroma under the floor.
    expect(contrastRatio('#0B7181', '#FBFAF6')).toBeGreaterThanOrEqual(MIN_CONTRAST)
    expect(chroma('#0B7181')).toBeLessThan(MIN_CHROMA)
  })
})
