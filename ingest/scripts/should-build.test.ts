// The ingest deploy check skips a build ONLY when GitHub positively says nothing
// that ships changed. Every other path builds — a wrongly skipped build puts
// stale code in production, a needless one costs ~15 s.

import { COMPARE_FILE_CAP, affectsDeploy, decide, fetchCompare } from './should-build.mjs'

const env = { previousSha: 'aaa', commitSha: 'bbb', token: 't' }
const ahead = (files: string[]) => ({ ok: true, status: 'ahead', files: files.map((filename) => ({ filename })) })

describe('affectsDeploy', () => {
  it('counts anything under ingest/ and the upload filter', () => {
    expect(affectsDeploy('ingest/api/events.ts')).toBe(true)
    expect(affectsDeploy('ingest/vercel.json')).toBe(true)
    expect(affectsDeploy('.vercelignore')).toBe(true)
  })

  it('ignores the rest of the repo, including look-alike names', () => {
    expect(affectsDeploy('app/src/main/index.ts')).toBe(false)
    expect(affectsDeploy('ingest-notes.md')).toBe(false)
    expect(affectsDeploy('docs/.vercelignore')).toBe(false)
  })
})

describe('decide', () => {
  it('skips when only files outside the deployment changed', () => {
    const verdict = decide(env, ahead(['app/src/main/index.ts', 'flow/tasklist.md']))
    expect(verdict.build).toBe(false)
    expect(verdict.reason).toContain('2 file(s) changed')
  })

  it('builds when an ingest file changed', () => {
    expect(decide(env, ahead(['app/x.ts', 'ingest/lib/db.ts']))).toEqual({
      build: true,
      reason: 'ingest/lib/db.ts changed',
    })
  })

  it('builds when .vercelignore changed — it decides what is uploaded', () => {
    expect(decide(env, ahead(['.vercelignore'])).build).toBe(true)
  })

  it('builds when a file was moved OUT of ingest/', () => {
    const moved = { ok: true, status: 'ahead', files: [{ filename: 'docs/old.ts', previous_filename: 'ingest/lib/old.ts' }] }
    expect(decide(env, moved).build).toBe(true)
  })

  describe('fails open', () => {
    it.each([
      ['no token', { ...env, token: undefined }, ahead(['app/x.ts'])],
      ['no previous deployment', { ...env, previousSha: undefined }, ahead(['app/x.ts'])],
      ['no commit SHA', { ...env, commitSha: undefined }, ahead(['app/x.ts'])],
      ['a redeploy of the same commit', { ...env, previousSha: 'bbb' }, ahead([])],
      ['GitHub unreachable', env, { ok: false, error: 'timeout' }],
      ['no compare at all', env, null],
      ['history moved backwards', env, { ok: true, status: 'behind', files: [] }],
      ['history diverged (force-push)', env, { ok: true, status: 'diverged', files: [{ filename: 'app/x.ts' }] }],
    ])('builds on %s', (_label, input, compare) => {
      expect(decide(input, compare).build).toBe(true)
    })

    it('builds when the file list may be truncated', () => {
      const many = ahead(Array.from({ length: COMPARE_FILE_CAP }, (_, i) => `app/f${i}.ts`))
      expect(decide(env, many).build).toBe(true)
    })
  })
})

describe('fetchCompare', () => {
  it('asks the compare endpoint with the token and returns status + files', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') })
      return new Response(JSON.stringify({ status: 'ahead', files: [{ filename: 'ingest/a.ts' }] }))
    }) as unknown as typeof fetch

    const result = await fetchCompare({ owner: 'o', repo: 'r', base: 'aaa', head: 'bbb', token: 'tok', fetchFn })

    expect(calls).toEqual([{ url: 'https://api.github.com/repos/o/r/compare/aaa...bbb', auth: 'Bearer tok' }])
    expect(result).toEqual({ ok: true, status: 'ahead', files: [{ filename: 'ingest/a.ts' }] })
  })

  it('reports an HTTP failure instead of throwing', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    expect(await fetchCompare({ owner: 'o', repo: 'r', base: 'a', head: 'b', token: 't', fetchFn })).toEqual({
      ok: false,
      error: 'HTTP 401',
    })
  })

  it('reports a network error instead of throwing', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await fetchCompare({ owner: 'o', repo: 'r', base: 'a', head: 'b', token: 't', fetchFn })).toEqual({
      ok: false,
      error: 'ECONNRESET',
    })
  })
})
