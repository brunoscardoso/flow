import { extractDocSummary } from './doc-summary'

describe('extractDocSummary (#understanding-summary)', () => {
  it('takes the first prose paragraph after the title + Overview heading', () => {
    const doc = [
      '# `app` Module — Flow IDE',
      '',
      '## Overview',
      '',
      'The app directory is the Electron application that implements the IDE.',
      'It is split into three process layers.',
      '',
      '## Preload Bridge',
      'other stuff',
    ].join('\n')
    expect(extractDocSummary(doc)).toBe(
      'The app directory is the Electron application that implements the IDE. It is split into three process layers.',
    )
  })

  it('works with no Overview heading (title then prose)', () => {
    expect(extractDocSummary('# graphql\n\nGraphQL schema + resolvers for the API.')).toBe(
      'GraphQL schema + resolvers for the API.',
    )
  })

  it('strips inline emphasis/code markers', () => {
    expect(extractDocSummary('# t\n\nThe `builder` wires **schema** to _resolvers_.')).toBe(
      'The builder wires schema to resolvers.',
    )
  })

  it('caps a long paragraph with an ellipsis', () => {
    const long = 'x'.repeat(400)
    const out = extractDocSummary(`# t\n\n${long}`, 50)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(50)
  })

  it('returns empty string for a doc with no prose (only headings)', () => {
    expect(extractDocSummary('# title\n\n## Overview\n\n### Sub')).toBe('')
    expect(extractDocSummary('')).toBe('')
  })

  it('skips a horizontal rule before the prose', () => {
    expect(extractDocSummary('# t\n\n---\n\nReal summary line.')).toBe('Real summary line.')
  })
})
