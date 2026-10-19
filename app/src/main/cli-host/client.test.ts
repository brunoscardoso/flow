import { resetCliHostForTests, runInCliHost } from './client'

/**
 * The host is an optimisation, and an optimisation that can break a feature is
 * not one. Every caller keeps its own spawn for the cases this cannot serve.
 */
describe('runInCliHost', () => {
  afterEach(() => resetCliHostForTests())

  it('answers null when no host has been configured — the caller spawns itself', () => {
    // Which is the state in every unit test, and in any build where the host
    // script is missing: callers must be none the wiser.
    expect(
      runInCliHost({
        execPath: '/bin/echo',
        args: ['hello'],
        cwd: '/tmp',
        captureStdout: true,
        timeoutMs: 1_000,
      }),
    ).toBeNull()
  })
})
