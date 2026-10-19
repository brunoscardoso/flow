import { describe, expect, it, jest } from '@jest/globals'

import type { CliRunResult } from '../agent/learn-session'
import { FEATURE_HOME_TIMEOUT_MS, parseFeatureHomeStdout, runFeatureHome, type FeatureHomeDeps } from './feature-home-runner'

const CLI = { execPath: '/electron', cliPath: '/bundle/planflow-ai.mjs' }
const ROOT = '/repo'

interface Call {
  cwd: string
  args: readonly string[]
  options: { timeoutMs?: number } | undefined
}

function fakeRun(answer: CliRunResult): { run: NonNullable<FeatureHomeDeps['run']>; calls: Call[] } {
  const calls: Call[] = []
  const run = jest.fn(async (_cli: unknown, cwd: string, args: readonly string[], options?: Call['options']) => {
    calls.push({ cwd, args, options })
    return answer
  }) as unknown as NonNullable<FeatureHomeDeps['run']>
  return { run, calls }
}

describe('parseFeatureHomeStdout', () => {
  it('reads a success, ignoring noise', () => {
    const stdout = ['warming up', JSON.stringify({ action: 'features-home', feature: 'billing', part: null, home: 'src/billing', previous: null })].join('\n')
    expect(parseFeatureHomeStdout(stdout, 'src/billing')).toEqual({ ok: true, home: 'src/billing', previous: null })
  })

  it('reads a refusal as its reason and folder — never the sentence', () => {
    const stdout = [
      JSON.stringify({ action: 'features-home', refused: 'missing-folder', folder: 'src/gone', nearest: 'src' }),
      "features refused: missing-folder — there is no folder 'src/gone' in this project",
    ].join('\n')
    expect(parseFeatureHomeStdout(stdout, 'src/gone')).toEqual({ ok: false, reason: 'missing-folder', folder: 'src/gone' })
  })

  it('ignores other actions and garbage', () => {
    expect(parseFeatureHomeStdout('{"action":"other"}\n{nope', null)).toBeNull()
  })
})

describe('runFeatureHome', () => {
  it('runs the one writer in the root, with a timeout', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: '{"action":"features-home","feature":"billing","part":null,"home":"src/billing","previous":null}\n' })
    const answer = await runFeatureHome({ bundledCli: CLI, run }, { rootId: ROOT, featureRef: 'feature:billing', folder: 'src/billing' })
    expect(answer).toEqual({ ok: true, home: 'src/billing', previous: null })
    expect(calls).toEqual([
      {
        cwd: ROOT,
        args: ['blueprint', 'features', 'home', '--feature', 'feature:billing', '--folder', 'src/billing', '--json'],
        options: { timeoutMs: FEATURE_HOME_TIMEOUT_MS },
      },
    ])
  })

  it('clears with --clear', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: '{"action":"features-home","feature":"billing","part":null,"home":null,"previous":"src/billing"}\n' })
    const answer = await runFeatureHome({ bundledCli: CLI, run }, { rootId: ROOT, featureRef: 'billing', clear: true })
    expect(answer).toEqual({ ok: true, home: null, previous: 'src/billing' })
    expect(calls[0]?.args).toEqual(['blueprint', 'features', 'home', '--feature', 'billing', '--clear', '--json'])
  })

  it('refuses both-or-neither before spawning anything', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: '' })
    await expect(runFeatureHome({ bundledCli: CLI, run }, { rootId: ROOT, featureRef: 'x' })).resolves.toEqual({ ok: false, reason: 'arguments', folder: null })
    await expect(runFeatureHome({ bundledCli: CLI, run }, { rootId: ROOT, featureRef: 'x', folder: 'a', clear: true })).resolves.toMatchObject({ ok: false, reason: 'arguments' })
    await expect(runFeatureHome({ bundledCli: CLI, run }, { rootId: ROOT, featureRef: ' ', folder: 'a' })).resolves.toMatchObject({ ok: false, reason: 'arguments' })
    expect(calls).toEqual([])
  })

  it('answers unavailable without a CLI, timed out on a timeout', async () => {
    await expect(runFeatureHome({ bundledCli: null }, { rootId: ROOT, featureRef: 'x', folder: 'a' })).resolves.toEqual({ ok: false, reason: 'unavailable', folder: 'a' })
    const { run } = fakeRun({ ok: false, stdout: '', error: 'timed out' })
    await expect(runFeatureHome({ bundledCli: CLI, run }, { rootId: ROOT, featureRef: 'x', folder: 'a' })).resolves.toEqual({ ok: false, reason: 'timed out', folder: 'a' })
  })
})
