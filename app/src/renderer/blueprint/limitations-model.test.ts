/**
 * Tests for the limitations surface (Phase 8).
 *
 * The rule under test throughout: an UNKNOWN is never reported as a zero, a
 * measured gap is reported exactly, and a validator's words survive the trip to
 * the screen unedited.
 */
import type { BlueprintFeatureLimitations } from '../../shared/ipc-contract'

import {
  brainQueryCap,
  buildLimitationsReport,
  derivedCap,
  limitationsLabel,
  type AppliedCap,
} from './limitations-model'

function limits(patch: Partial<BlueprintFeatureLimitations> = {}): BlueprintFeatureLimitations {
  return {
    content: { features: 28, withParts: 28, withLearned: 28, unreadable: 0 },
    views: { total: 1, valid: 1, broken: 0, orphaned: 0, failures: [] },
    ...patch,
  }
}

function rowsOf(report: ReturnType<typeof buildLimitationsReport>, id: string): string[] {
  return (report.sections.find((section) => section.id === id)?.rows ?? []).map((row) => row.label)
}

describe('buildLimitationsReport — the unknown is not a zero', () => {
  it('says the store was never measured rather than reporting it clean', () => {
    const report = buildLimitationsReport({ limitations: null, caps: [] })
    expect(report.clean).toBe(false)
    expect(report.headline).toBe('Store gaps not measured.')
    expect(rowsOf(report, 'missing')).toEqual(['Store gaps not measured'])
  })

  it('still reports the caps it applied itself when the store was not measured', () => {
    const cap: AppliedCap = {
      noun: { one: 'connection', many: 'connections' },
      hidden: 4,
      of: 24,
      cap: 20,
    }
    const report = buildLimitationsReport({ limitations: null, caps: [cap] })
    expect(report.counts.capped).toBe(1)
    expect(rowsOf(report, 'capped')).toEqual(['4 connections hidden'])
    expect(report.headline).toContain('1 cap applied')
  })

  it('reports a genuinely clean store as clean', () => {
    const report = buildLimitationsReport({ limitations: limits(), caps: [] })
    expect(report.clean).toBe(true)
    expect(report.headline).toBe('Nothing broken, nothing hidden, nothing missing.')
    expect(report.sections).toEqual([])
    expect(limitationsLabel(report)).toBe('Limitations: none')
  })
})

describe('buildLimitationsReport — broken artifacts (Task 8.1)', () => {
  it("carries the validator's messages verbatim onto the row", () => {
    const errors = [
      "component 'session' quotes 'a.ts' lines 522..530, but it has 451",
      'view needs a non-empty "feature"',
    ]
    const report = buildLimitationsReport({
      limitations: limits({
        views: {
          total: 1,
          valid: 0,
          broken: 1,
          orphaned: 0,
          failures: [
            { slug: 'feature-view', path: '/p', state: 'invalid', orphaned: false, orphanReason: '', errors },
          ],
        },
      }),
      caps: [],
    })
    const row = report.sections
      .find((section) => section.id === 'broken')
      ?.rows.find((entry) => entry.label.includes('fails the view validator'))
    expect(row?.errors).toEqual(errors)
    expect(row?.detail).toBe('2 refusals')
  })

  it('gives an orphan its OWN row — two faults, two fixes', () => {
    const report = buildLimitationsReport({
      limitations: limits({
        views: {
          total: 1,
          valid: 0,
          broken: 1,
          orphaned: 1,
          failures: [
            {
              slug: 'feature-view',
              path: '/p',
              state: 'invalid',
              orphaned: true,
              orphanReason: 'names no feature',
              errors: ['view needs a non-empty "feature"'],
            },
          ],
        },
      }),
      caps: [],
    })
    expect(rowsOf(report, 'broken')).toEqual([
      'feature-view belongs to no feature',
      'feature-view fails the view validator',
    ])
  })

  it('reports an unreadable artifact without pretending to validate it', () => {
    const report = buildLimitationsReport({
      limitations: limits({
        views: {
          total: 1,
          valid: 0,
          broken: 1,
          orphaned: 0,
          failures: [
            {
              slug: 'chats',
              path: '/p',
              state: 'unreadable',
              orphaned: false,
              orphanReason: '',
              errors: ['is not readable JSON: Unexpected token'],
            },
          ],
        },
      }),
      caps: [],
    })
    expect(rowsOf(report, 'broken')).toEqual(['chats could not be read'])
  })
})

describe('buildLimitationsReport — missing content (this repo, measured)', () => {
  const measured = limits({
    content: { features: 28, withParts: 0, withLearned: 0, unreadable: 0 },
    views: {
      total: 1,
      valid: 0,
      broken: 1,
      orphaned: 1,
      failures: [
        {
          slug: 'feature-view',
          path: '/p',
          state: 'invalid',
          orphaned: true,
          orphanReason: 'names no feature',
          errors: ['view needs a non-empty "feature"'],
        },
      ],
    },
  })

  it('names the three gaps this repo actually has', () => {
    const report = buildLimitationsReport({ limitations: measured, caps: [] })
    expect(rowsOf(report, 'missing')).toEqual([
      '28 features have no parts',
      '28 features have nothing learned',
      'No feature has a curated view',
    ])
  })

  it('prints the ratio, never the bare numerator', () => {
    const report = buildLimitationsReport({ limitations: measured, caps: [] })
    const details = (report.sections.find((s) => s.id === 'missing')?.rows ?? []).map((r) => r.detail)
    expect(details[0]).toBe('0 of 28 have them')
    expect(details[1]).toBe('0 of 28 have them')
    // NOT the name of a markdown heading. These read `## Parts on 0 of 28` on
    // a real project's board — a fact about how the store is written, shown to
    // someone looking at a map of their code.
    for (const detail of details) expect(detail).not.toContain('##')
  })

  it('counts an unreadable body as BREAKAGE, not as "nothing learned"', () => {
    const report = buildLimitationsReport({
      limitations: limits({
        content: { features: 3, withParts: 3, withLearned: 2, unreadable: 1 },
      }),
      caps: [],
    })
    const labels = rowsOf(report, 'missing')
    // 3 features, 2 learned, 1 unreadable ⇒ nothing is merely undocumented.
    expect(labels).not.toContain('1 feature has nothing learned')
    expect(labels).toContain('1 feature body could not be read')
    expect(report.counts.broken).toBe(1)
  })

  it('says an empty store is empty rather than fully documented', () => {
    const report = buildLimitationsReport({
      limitations: limits({
        content: { features: 0, withParts: 0, withLearned: 0, unreadable: 0 },
        views: { total: 0, valid: 0, broken: 0, orphaned: 0, failures: [] },
      }),
      caps: [],
    })
    expect(rowsOf(report, 'missing')).toEqual(['No features in the store'])
  })

  it('distinguishes "nothing generated" from "generated and unusable"', () => {
    const none = buildLimitationsReport({
      limitations: limits({ views: { total: 0, valid: 0, broken: 0, orphaned: 0, failures: [] } }),
      caps: [],
    })
    const dead = buildLimitationsReport({
      limitations: limits({
        views: {
          total: 2,
          valid: 0,
          broken: 2,
          orphaned: 0,
          failures: [
            { slug: 'a', path: '/a', state: 'invalid', orphaned: false, orphanReason: '', errors: ['x'] },
            { slug: 'b', path: '/b', state: 'invalid', orphaned: false, orphanReason: '', errors: ['y'] },
          ],
        },
      }),
      caps: [],
    })
    const detailOf = (r: ReturnType<typeof buildLimitationsReport>): string =>
      (r.sections.find((s) => s.id === 'missing')?.rows ?? []).find((row) =>
        row.label === 'No feature has a curated view',
      )?.detail ?? ''
    expect(detailOf(none)).toContain('nothing has been generated')
    expect(detailOf(dead)).toContain('2 artifacts are stored and none of them is usable')
  })
})

describe('applied caps (Task 8.4) — every cap says what it hid', () => {
  it('reports a derived-level cap that bit, with the ratio and the limit', () => {
    const cap = derivedCap({ hidden: { pairs: 66 }, totalPairs: 86, cap: 20 })
    const report = buildLimitationsReport({ limitations: limits(), caps: [cap as AppliedCap] })
    const row = (report.sections.find((s) => s.id === 'capped')?.rows ?? [])[0]
    expect(row.label).toBe('66 connections hidden in the derived level')
    expect(row.detail).toBe('showing 20 of 86 — the cap is 20')
  })

  it('emits no row for a cap that did not bite — silence is the honest answer', () => {
    const cap = derivedCap({ hidden: { pairs: 0 }, totalPairs: 17, cap: 20 })
    const report = buildLimitationsReport({ limitations: limits(), caps: [cap as AppliedCap] })
    expect(report.clean).toBe(true)
    expect(report.sections).toEqual([])
  })

  it('reports no derived cap when there is no derived level', () => {
    expect(derivedCap(null)).toBeNull()
  })

  it('says nothing about the brain query while it is under its limit', () => {
    expect(brainQueryCap(3, 12)).toBeNull()
    expect(brainQueryCap(0, 12)).toBeNull()
  })

  it('discloses a FULL brain answer without inventing a hidden count', () => {
    const cap = brainQueryCap(12, 12)
    expect(cap?.unquantified).toBe(true)
    expect(cap?.hidden).toBe(0)
    const report = buildLimitationsReport({ limitations: limits(), caps: [cap as AppliedCap] })
    const row = (report.sections.find((s) => s.id === 'capped')?.rows ?? [])[0]
    expect(row.label).toBe('matches beyond the cap are not shown in the brain query')
    expect(row.detail).toContain('not knowable from here')
  })

  it('pluralises from the given words, never by appending an s', () => {
    const cap: AppliedCap = { noun: { one: 'match', many: 'matches' }, hidden: 1, of: 13, cap: 12 }
    const report = buildLimitationsReport({ limitations: limits(), caps: [cap] })
    expect(rowsOf(report, 'capped')).toEqual(['1 match hidden'])
  })
})

describe('what the directory held that is not a capability (Phase 5)', () => {
  const withExcluded = (excluded: BlueprintFeatureLimitations['excluded']) =>
    buildLimitationsReport({ caps: [], limitations: limits({ excluded }) })

  it('names every excluded file and says why — a count cannot be acted on', () => {
    const report = withExcluded([
      { slug: 'tenant-note', reason: 'capture-note', dropped: true },
      { slug: 'orbit-core-oidc-jwks-cache', reason: 'no-kind', dropped: false },
    ])
    const section = report.sections.find((s) => s.id === 'excluded')
    expect(section?.title).toBe('Not drawn as a capability')
    expect(section?.rows.map((r) => r.label)).toEqual([
      'tenant-note — not shown',
      'orbit-core-oidc-jwks-cache — shown as a capability',
    ])
    expect(section?.rows[1]?.detail).toContain('does not say whether it is a capability or a change')
  })

  it('distinguishes a file that was dropped from one drawn on a guess', () => {
    const rows = withExcluded([
      { slug: 'a', reason: 'capture-note', dropped: true },
      { slug: 'b', reason: 'no-kind', dropped: false },
    ]).sections.find((s) => s.id === 'excluded')?.rows
    expect(rows?.map((r) => r.severity)).toEqual(['missing', 'unknown'])
  })

  it('says nothing when nothing was excluded, and stays clean', () => {
    const report = withExcluded([])
    expect(report.sections.find((s) => s.id === 'excluded')).toBeUndefined()
    expect(report.counts.excluded).toBe(0)
  })

  it('an older CLI that cannot answer is not read as "nothing excluded"', () => {
    // The field is absent, not empty — no rows, and no claim either way.
    const report = buildLimitationsReport({ caps: [], limitations: limits() })
    expect(report.sections.find((s) => s.id === 'excluded')).toBeUndefined()
  })
})

describe('the headline and the collapsed label', () => {
  it('counts every kind and never renders blank', () => {
    const report = buildLimitationsReport({
      limitations: limits({
        content: { features: 28, withParts: 0, withLearned: 0, unreadable: 0 },
        views: {
          total: 1,
          valid: 0,
          broken: 1,
          orphaned: 1,
          failures: [
            {
              slug: 'feature-view',
              path: '/p',
              state: 'invalid',
              orphaned: true,
              orphanReason: 'names no feature',
              errors: ['view needs a non-empty "feature"'],
            },
          ],
        },
      }),
      caps: [{ noun: { one: 'connection', many: 'connections' }, hidden: 4, of: 24, cap: 20 }],
    })
    expect(report.counts).toEqual({ broken: 2, missing: 3, capped: 1, excluded: 0 })
    expect(report.headline).toBe('2 things broken · 3 gaps · 1 cap applied.')
    expect(limitationsLabel(report)).toBe('Limitations: 6')
  })

  it('is deterministic — the same input builds the same report', () => {
    const input = { limitations: limits(), caps: [] }
    expect(buildLimitationsReport(input)).toEqual(buildLimitationsReport(input))
  })
})
