import { featureSlugOfRef } from './feature-ref'

describe('featureSlugOfRef', () => {
  it('reads the slug out of a plain feature id', () => {
    expect(featureSlugOfRef('feature:orders')).toBe('orders')
  })
  it('reads only the slug out of a Workspace feature id — never `project::slug`', () => {
    expect(featureSlugOfRef('feature:backend::orders')).toBe('orders')
  })
  it('leaves a bare slug alone', () => {
    expect(featureSlugOfRef('orders')).toBe('orders')
  })
})
