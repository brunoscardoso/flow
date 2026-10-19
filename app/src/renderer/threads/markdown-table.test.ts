// Guards the md-preview table detection (#704). GFM delimiter cells are `:?-+:?`
// — one OR more dashes — but the renderer required two+ (`-{2,}`), so a
// single-dash table (or any divider with even one single-dash cell) failed
// detection and rendered as raw pipe text. isTableDivider is the pure predicate
// the renderer's table-block detection calls. isTableStart (#1015) is the
// shared header+divider predicate used both by the block scanner and by the
// paragraph-break test, so a table written on the line right after prose
// interrupts the paragraph instead of rendering as literal pipe text.
import { isTableDivider, isTableStart } from './markdown-table-detect'

describe('isTableDivider (#704)', () => {
  it('accepts multi-dash dividers (the case that always worked)', () => {
    expect(isTableDivider('|---|---|')).toBe(true)
    expect(isTableDivider('| --- | --- |')).toBe(true)
    expect(isTableDivider('---|---')).toBe(true) // no outer pipes
  })

  it('accepts SINGLE-dash dividers — valid GFM the old -{2,} dropped', () => {
    expect(isTableDivider('|-|-|')).toBe(true)
    expect(isTableDivider('| - | - |')).toBe(true)
    expect(isTableDivider('|-|')).toBe(true) // single column
  })

  it('accepts alignment colons with single OR multi dash', () => {
    expect(isTableDivider('|:--|--:|:-:|')).toBe(true) // mixed; the :-: cell is single-dash
    expect(isTableDivider('|:-:|:-:|')).toBe(true)
    expect(isTableDivider('| :- | -: |')).toBe(true)
  })

  it('rejects non-divider lines (header rows, prose, blank)', () => {
    expect(isTableDivider('| Name | Age |')).toBe(false)
    expect(isTableDivider('hello world')).toBe(false)
    expect(isTableDivider('')).toBe(false)
    expect(isTableDivider('| a | b |')).toBe(false)
  })
})

describe('isTableStart (#1015)', () => {
  it('detects a header row followed by a divider row', () => {
    expect(isTableStart('| Option | Cost |', '| --- | --- |')).toBe(true)
    expect(isTableStart('Option | Cost', '--- | ---')).toBe(true) // no outer pipes
    expect(isTableStart('| a | b |', '|-|-|')).toBe(true) // single-dash (#704)
  })

  it('rejects when the header row has no pipe', () => {
    expect(isTableStart('Here is the comparison:', '| --- | --- |')).toBe(false)
  })

  it('rejects when the successor is not a divider', () => {
    expect(isTableStart('| Option | Cost |', '| A | low |')).toBe(false)
    expect(isTableStart('| Option | Cost |', 'plain prose')).toBe(false)
    expect(isTableStart('| Option | Cost |', '')).toBe(false)
  })

  it('rejects at end of input (no successor line)', () => {
    expect(isTableStart('| Option | Cost |', undefined)).toBe(false)
  })

  it('rejects a dashless divider shape (bare pipes)', () => {
    expect(isTableStart('| a | b |', '| | |')).toBe(false)
  })
})
