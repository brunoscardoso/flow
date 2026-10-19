// Pure view-model tests for the project accent picker (thread sidebar).
import { PROJECT_ACCENT_PALETTE, projectAccent } from '../project-accent'
import { accentPickerModel } from './accent-picker'

const ROOT = '/Users/dev/projects/picker-me'

describe('accentPickerModel', () => {
  it('with no override: Auto selected, no swatch selected, hash color current', () => {
    const model = accentPickerModel(ROOT, null)
    expect(model.autoSelected).toBe(true)
    expect(model.swatches.every((swatch) => !swatch.selected)).toBe(true)
    expect(model.currentColor).toBe(projectAccent(ROOT).color)
  })

  it('offers exactly the curated palette, in palette order', () => {
    const model = accentPickerModel(ROOT, null)
    expect(model.swatches.map((swatch) => swatch.color)).toEqual(
      PROJECT_ACCENT_PALETTE.map((entry) => entry.color),
    )
  })

  it('with a palette override: that swatch selected, Auto not', () => {
    const override = PROJECT_ACCENT_PALETTE[3].color
    const model = accentPickerModel(ROOT, override)
    expect(model.autoSelected).toBe(false)
    expect(model.swatches.filter((swatch) => swatch.selected).map((s) => s.color)).toEqual([
      override,
    ])
    expect(model.currentColor).toBe(PROJECT_ACCENT_PALETTE[3].paint)
  })

  it('swatches paint theme-aware and store the canonical colour', () => {
    const model = accentPickerModel(ROOT, null)
    expect(model.swatches.map((swatch) => swatch.paint)).toEqual(PROJECT_ACCENT_PALETTE.map((entry) => entry.paint))
  })

  it('a custom colour is a pick too: Auto is not selected, no swatch is', () => {
    const model = accentPickerModel(ROOT, '#123456')
    expect(model.autoSelected).toBe(false)
    expect(model.swatches.some((swatch) => swatch.selected)).toBe(false)
    expect(model.currentColor).toBe('#123456')
  })

  it('a malformed persisted override reads as Auto (matches resolveAccent)', () => {
    const model = accentPickerModel(ROOT, 'not-a-color')
    expect(model.autoSelected).toBe(true)
    expect(model.currentColor).toBe(projectAccent(ROOT).color)
  })
})
