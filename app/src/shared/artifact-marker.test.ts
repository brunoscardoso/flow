// Artifact-marker classifier tests (#1056) — writer (main) and reader
// (renderer) share this one module, so the round-trip is the contract.

import {
  ARTIFACT_MARKER_PREFIX,
  formatArtifactMarker,
  parseArtifactMarker,
} from './artifact-marker'

describe('formatArtifactMarker', () => {
  it('serializes to the machine-parseable prefix + kind + path', () => {
    expect(formatArtifactMarker('plan', 'flow/plans/plan_foo_v1.md')).toBe(
      '[artifact] plan flow/plans/plan_foo_v1.md',
    )
  })
})

describe('artifact markers for a doc in an attached project (2026-10-09)', () => {
  it('appends the root only when one is given — a primary-project doc keeps its exact old content', () => {
    expect(formatArtifactMarker('discovery', 'flow/discovery/discovery_x_v1.md')).toBe(
      '[artifact] discovery flow/discovery/discovery_x_v1.md',
    )
    expect(formatArtifactMarker('discovery', 'flow/discovery/discovery_x_v1.md', '/Users/me/Projects/sibling')).toBe(
      '[artifact] discovery flow/discovery/discovery_x_v1.md @/Users/me/Projects/sibling',
    )
  })

  it('round-trips a root, including one with spaces and a Windows drive', () => {
    for (const root of ['/Users/me/Projects/sibling', '/Users/me/Library/Application Support/x', 'C:\\work\\repo']) {
      const content = formatArtifactMarker('plan', 'flow/plans/plan_x_v1.md', root)
      expect(parseArtifactMarker(content)).toEqual({ kind: 'plan', path: 'flow/plans/plan_x_v1.md', root })
    }
  })

  it('an old marker (no root) parses exactly as before, and a path holding " @" is not split', () => {
    expect(parseArtifactMarker('[artifact] plan flow/plans/plan_x_v1.md')).toEqual({ kind: 'plan', path: 'flow/plans/plan_x_v1.md' })
    expect(parseArtifactMarker('[artifact] brainstorm flow/brainstorms/my @idea.md')).toEqual({
      kind: 'brainstorm',
      path: 'flow/brainstorms/my @idea.md',
    })
  })
})

describe('parseArtifactMarker', () => {
  it('round-trips every kind through format → parse', () => {
    for (const kind of ['discovery', 'plan', 'brainstorm'] as const) {
      const path = `flow/x/${kind}_thing_v2.md`
      expect(parseArtifactMarker(formatArtifactMarker(kind, path))).toEqual({ kind, path })
    }
  })

  it('parses a path containing spaces (everything after the kind)', () => {
    expect(parseArtifactMarker('[artifact] brainstorm flow/brainstorms/my idea.md')).toEqual({
      kind: 'brainstorm',
      path: 'flow/brainstorms/my idea.md',
    })
  })

  it('returns null for ordinary system notes', () => {
    expect(parseArtifactMarker('Interrupted by you')).toBeNull()
    expect(parseArtifactMarker('Agent turn failed: boom')).toBeNull()
  })

  it('returns null for the bare prefix and prefix-without-space forms', () => {
    expect(parseArtifactMarker(ARTIFACT_MARKER_PREFIX)).toBeNull()
    expect(parseArtifactMarker('[artifact]plan flow/plans/p.md')).toBeNull()
  })

  it('returns null for an unknown kind or a missing path', () => {
    expect(parseArtifactMarker('[artifact] contract flow/contracts/x.md')).toBeNull()
    expect(parseArtifactMarker('[artifact] plan')).toBeNull()
    expect(parseArtifactMarker('[artifact] plan   ')).toBeNull()
  })
})
