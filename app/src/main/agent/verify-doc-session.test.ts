import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildVerifyPrompt,
  parseVerifyOutput,
  rollupOutcome,
  runVerifyDoc,
  salvageVerifyOutput,
} from './verify-doc-session'
import type { BundledCli } from '../blueprint/derive-runner'

const CLI: BundledCli = { execPath: '/x/electron', cliPath: '/x/cli.mjs' } as BundledCli

const CLAIMS_JSON = JSON.stringify({
  claims: [
    { claim: 'Auth uses sessions', outcome: 'corroborated', witnesses: ['src/auth.ts'], note: 'session store found' },
    { claim: 'Rate limit is 100/min', outcome: 'contradicted', witnesses: ['src/limits.ts'], note: 'constant is 60' },
  ],
})

describe('parse + salvage + rollup', () => {
  it('parses strict output and enforces shape', () => {
    const claims = parseVerifyOutput(CLAIMS_JSON)
    expect(claims).toHaveLength(2)
    expect(claims?.[0]).toMatchObject({ outcome: 'corroborated', witnesses: ['src/auth.ts'] })
    expect(parseVerifyOutput('{"claims":[]}')).toBeNull()
    expect(parseVerifyOutput('{"claims":[{"claim":"x","outcome":"maybe","witnesses":[]}]}')).toBeNull()
    expect(parseVerifyOutput('not json')).toBeNull()
  })

  it('salvages a JSON object wrapped in prose/fences', () => {
    const wrapped = 'Here is my analysis:\n```json\n' + CLAIMS_JSON + '\n```\nDone.'
    expect(salvageVerifyOutput(wrapped)).toHaveLength(2)
  })

  it('rollup: contradicted > unverifiable > corroborated', () => {
    const c = (outcome: 'corroborated' | 'contradicted' | 'unverifiable') => ({ claim: 'x', outcome, witnesses: [] })
    expect(rollupOutcome([c('corroborated')])).toBe('corroborated')
    expect(rollupOutcome([c('corroborated'), c('unverifiable')])).toBe('unverifiable')
    expect(rollupOutcome([c('unverifiable'), c('contradicted')])).toBe('contradicted')
  })
})

describe('runVerifyDoc', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pf-verify-session-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'api.md'), '# API\nAuth uses sessions.\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('runs session → adjudicate (claims-json, verify-agent) → promote, and reports the rollup', async () => {
    const cliCalls: string[][] = []
    const result = await runVerifyDoc(root, 'docs/api.md', {
      bundledCli: CLI,
      runSession: async ({ prompt }) => {
        expect(prompt).toContain('docs/api.md')
        expect(prompt).toContain('Auth uses sessions.')
        return CLAIMS_JSON
      },
      runCli: async (_cli, _cwd, args) => {
        cliCalls.push([...args])
        return args[1] === 'promote-doc'
          ? { ok: true, stdout: 'promoted: docs/api.md — 1 claim(s) → x, 1 contradiction observation(s)\n' }
          : { ok: true, stdout: 'adjudicated: docs/api.md contradicted\n' }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.verdict).toBe('contradicted') // rollup of the two claims
    expect(result.promoted).toBe(1)
    expect(result.observations).toBe(1)
    const adjudicate = cliCalls[0]
    expect(adjudicate).toContain('--claims-json')
    expect(adjudicate).toContain('--provenance')
    expect(adjudicate[adjudicate.indexOf('--provenance') + 1]).toBe('verify-agent')
    expect(adjudicate[adjudicate.indexOf('--against') + 1]).toBe('src/auth.ts,src/limits.ts')
    expect(cliCalls[1][1]).toBe('promote-doc')
  })

  it('fail-soft: malformed session output refuses without recording anything', async () => {
    const cliCalls: string[][] = []
    const result = await runVerifyDoc(root, 'docs/api.md', {
      bundledCli: CLI,
      runSession: async () => 'I could not produce JSON, sorry!',
      runCli: async (_cli, _cwd, args) => {
        cliCalls.push([...args])
        return { ok: true, stdout: '' }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('malformed')
    expect(cliCalls).toHaveLength(0)
  })

  it('missing doc refuses with a one-line reason', async () => {
    const result = await runVerifyDoc(root, 'docs/nope.md', { bundledCli: CLI, runSession: async () => '', runCli: async () => ({ ok: true, stdout: '' }) })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cannot read')
  })

  it('prompt carries the caps and the honest-unverifiable instruction', () => {
    const prompt = buildVerifyPrompt({ docPath: 'docs/a.md', docContent: 'x' })
    expect(prompt).toContain('up to 8 DISCRETE')
    expect(prompt).toContain('never guess')
  })
})
