import { describeBootstrapError } from './bootstrap-error'

describe('describeBootstrapError (#163)', () => {
  it('special-cases a newer-schema downgrade with an "update Flow" message', () => {
    const err = new Error(
      '[Store] Database schema version 9 is newer than this app supports (7). Refusing to open.',
    )
    const dialog = describeBootstrapError(err)
    expect(dialog.title).toMatch(/can.t open your data/i)
    expect(dialog.message).toMatch(/update Flow/i)
    expect(dialog.message).not.toContain('Details:') // clean, actionable copy
  })

  it('treats any other error as an open/corrupt failure and includes the detail', () => {
    const dialog = describeBootstrapError(new Error('database disk image is malformed'))
    expect(dialog.message).toMatch(/corrupt|locked|disk/i)
    expect(dialog.message).toContain('database disk image is malformed')
  })

  it('stringifies a non-Error value', () => {
    expect(describeBootstrapError('boom').message).toContain('boom')
  })
})
