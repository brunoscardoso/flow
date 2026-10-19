/**
 * A failed bundled-CLI run through the CLI host must carry a reason. Live
 * 2026-10-09: "[BasicDiscovery] derive failed for orbit-app:" with nothing
 * after the colon — the host reports a non-zero exit with no `error`, and this
 * CLI writes its refusals to stdout (allowed-pattern #15).
 */
jest.mock('../cli-host/client', () => ({ runInCliHost: jest.fn() }))

import { runInCliHost } from '../cli-host/client'
import { runBundledCliCapturing } from './learn-session'

const CLI = { execPath: '/electron', cliPath: '/planflow-ai.mjs' }
const hosted = runInCliHost as jest.MockedFunction<typeof runInCliHost>

describe('runBundledCliCapturing through the CLI host', () => {
  it('names a stdout refusal when the host reports a bare non-zero exit', async () => {
    hosted.mockReturnValueOnce(
      Promise.resolve({ ok: false, stdout: 'Deriving…\n  x derive refused: flow/ is not a directory\n', stderr: '' }),
    )
    const result = await runBundledCliCapturing(CLI, '/repo', ['blueprint', 'derive'])
    expect(result).toMatchObject({ ok: false, error: 'x derive refused: flow/ is not a directory' })
  })

  it('prefers stderr, keeps the host error, and never answers an empty reason', async () => {
    hosted.mockReturnValueOnce(Promise.resolve({ ok: false, stdout: 'out\n', stderr: 'boom\n' }))
    expect((await runBundledCliCapturing(CLI, '/repo', ['x'])).error).toBe('boom')
    hosted.mockReturnValueOnce(Promise.resolve({ ok: false, stdout: '', stderr: '', error: 'timed out' }))
    expect((await runBundledCliCapturing(CLI, '/repo', ['x'])).error).toBe('timed out')
    hosted.mockReturnValueOnce(Promise.resolve({ ok: false, stdout: '', stderr: '' }))
    expect((await runBundledCliCapturing(CLI, '/repo', ['x'])).error).toBe('exited with an error')
  })
})
