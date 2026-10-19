import { describe, expect, it, jest } from '@jest/globals'

import type { CliRunResult } from '../agent/learn-session'
import type { FeaturePortsAnswer } from '../../shared/ipc-contract'
import {
  FEATURE_PORTS_TIMEOUT_MS,
  createFeaturePortsCache,
  parseFeaturePortsStdout,
  refusalSentence,
  runFeaturePorts,
  type FeaturePortsDeps,
  type FeaturePortsRequest,
} from './feature-ports-runner'

const CLI = { execPath: '/electron', cliPath: '/bundle/planflow-ai.mjs' }
const ROOT = '/repo'
const GENERIC = "Flow couldn't read what connects to this feature."

const PORTS = {
  action: 'features-ports',
  feature: 'feature:chats',
  slug: 'chats',
  name: 'Chats',
  part: null,
  project: 'app',
  workspace: { name: 'Team', slug: 'team' },
  in: [
    {
      direction: 'in',
      crosses: 'POST /api/chat',
      far: { project: 'web', feature: 'composer', local: false },
      internalNode: 'send',
      trust: 'code',
      source: 'connection',
    },
  ],
  out: [],
  linked: [],
  more: { in: 0, out: 2, linked: 0 },
  unreadableLinks: 1,
}

interface Call {
  cwd: string
  args: readonly string[]
  options: { timeoutMs?: number } | undefined
}

function fakeRun(answer: CliRunResult): { run: NonNullable<FeaturePortsDeps['run']>; calls: Call[] } {
  const calls: Call[] = []
  const run = jest.fn(async (_cli: unknown, cwd: string, args: readonly string[], options?: Call['options']) => {
    calls.push({ cwd, args, options })
    return answer
  }) as unknown as NonNullable<FeaturePortsDeps['run']>
  return { run, calls }
}

describe('parseFeaturePortsStdout', () => {
  it('takes the last features-ports line and ignores noise and other actions', () => {
    const stdout = ['warming up', '{"action":"other","in":[],"out":[],"linked":[]}', JSON.stringify(PORTS), '{not json'].join('\n')
    expect(parseFeaturePortsStdout(stdout)).toEqual(PORTS)
  })

  it('fills a missing more / unreadableLinks with zeros', () => {
    const { more: _more, unreadableLinks: _unreadable, ...bare } = PORTS
    const answer = parseFeaturePortsStdout(JSON.stringify(bare))
    expect(answer).toMatchObject({ more: { in: 0, out: 0, linked: 0 }, unreadableLinks: 0 })
  })

  it('rejects a result missing a side', () => {
    const { out: _out, ...partial } = PORTS
    expect(parseFeaturePortsStdout(JSON.stringify(partial))).toBeNull()
  })

  it('turns a refusal payload into the reader sentence, never the CLI text', () => {
    const stdout = [
      JSON.stringify({ action: 'features-ports', refused: 'unknown-feature', feature: 'feature:gone' }),
      "features refused: unknown-feature — no feature or part named 'feature:gone' in this project",
    ].join('\n')
    expect(parseFeaturePortsStdout(stdout)).toEqual({
      ports: null,
      reason: 'unknown-feature',
      sentence: "Flow couldn't find this feature any more.",
    })
  })

  it('maps an unknown reason to the generic sentence', () => {
    expect(refusalSentence('something-new')).toBe(GENERIC)
  })
})

describe('runFeaturePorts', () => {
  it('runs the verb on the root with the named timeout', async () => {
    const { run, calls } = fakeRun({ ok: true, stdout: `${JSON.stringify(PORTS)}\n` })
    const answer = await runFeaturePorts({ bundledCli: CLI, run }, { rootId: ROOT, feature: 'feature:chats' })
    expect(answer).toEqual(PORTS)
    expect(calls).toEqual([
      {
        cwd: ROOT,
        args: ['blueprint', 'features', 'ports', '--feature', 'feature:chats', '--target', ROOT, '--json'],
        options: { timeoutMs: FEATURE_PORTS_TIMEOUT_MS },
      },
    ])
    expect(FEATURE_PORTS_TIMEOUT_MS).toBe(15_000)
  })

  it('answers unavailable on a timeout, a missing CLI, a throwing runner or an empty feature', async () => {
    const timedOut = fakeRun({ ok: false, stdout: '', error: 'timed out' })
    const expected = { ports: null, reason: 'unavailable', sentence: GENERIC }
    expect(await runFeaturePorts({ bundledCli: CLI, run: timedOut.run }, { rootId: ROOT, feature: 'x' })).toEqual(expected)
    expect(await runFeaturePorts({ bundledCli: null }, { rootId: ROOT, feature: 'x' })).toEqual(expected)

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const throwing = jest.fn(async () => {
      throw new Error('boom')
    }) as unknown as NonNullable<FeaturePortsDeps['run']>
    expect(await runFeaturePorts({ bundledCli: CLI, run: throwing }, { rootId: ROOT, feature: 'x' })).toEqual(expected)
    warn.mockRestore()

    const never = fakeRun({ ok: true, stdout: '' })
    const empty = await runFeaturePorts({ bundledCli: CLI, run: never.run }, { rootId: ROOT, feature: '  ' })
    expect(empty).toMatchObject({ ports: null, reason: 'arguments' })
    expect(never.calls).toEqual([])
  })
})

describe('createFeaturePortsCache', () => {
  function counting(answer: FeaturePortsAnswer) {
    const requests: FeaturePortsRequest[] = []
    const read = async (request: FeaturePortsRequest): Promise<FeaturePortsAnswer> => {
      requests.push(request)
      return answer
    }
    return { read, requests }
  }

  it('shares one run between concurrent asks and keeps it until the root is cleared', async () => {
    const { read, requests } = counting(PORTS as unknown as FeaturePortsAnswer)
    const cache = createFeaturePortsCache(read)
    const request = { rootId: ROOT, feature: 'feature:chats' }
    const [first, second] = await Promise.all([cache.get(request), cache.get(request)])
    expect(first).toBe(second)
    await cache.get(request)
    expect(requests).toHaveLength(1)

    await cache.get({ rootId: '/other', feature: 'feature:chats' })
    cache.clear('/other')
    await cache.get(request)
    expect(requests).toHaveLength(2)

    cache.clear(ROOT)
    await cache.get(request)
    expect(requests).toHaveLength(3)
  })

  it('does not keep a failed read, but keeps a refusal', async () => {
    const failed = counting({ ports: null, reason: 'unavailable', sentence: GENERIC })
    const failing = createFeaturePortsCache(failed.read)
    await failing.get({ rootId: ROOT, feature: 'a' })
    await failing.get({ rootId: ROOT, feature: 'a' })
    expect(failed.requests).toHaveLength(2)

    const refused = counting({ ports: null, reason: 'unknown-feature', sentence: 'x' })
    const refusing = createFeaturePortsCache(refused.read)
    await refusing.get({ rootId: ROOT, feature: 'a' })
    await refusing.get({ rootId: ROOT, feature: 'a' })
    expect(refused.requests).toHaveLength(1)
  })
})
