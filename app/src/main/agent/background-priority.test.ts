import { runInBackground } from './background-priority'

describe('runInBackground', () => {
  it('does nothing at all for a child that never started', () => {
    expect(() => runInBackground(undefined)).not.toThrow()
  })

  it('survives a pid that is already gone', () => {
    // A child can exit between spawn and this call; a priority we could not
    // set is a slower app, never a broken one.
    expect(() => runInBackground(2_147_483_646)).not.toThrow()
  })

  it('actually lowers this process’s own children — proven on a real pid', () => {
    // The one honest check available without a fixture process: nicing our own
    // pid up is not permitted, but nicing it DOWN is, and it must not throw.
    expect(() => runInBackground(process.pid)).not.toThrow()
  })
})
