import { fetchCopilotCatalog, clearCopilotCatalogCache } from './copilot-catalog'
import { COPILOT_BUILTIN_MODEL_IDS } from '../../../shared/runtime-models'

/** A fetch that answers one body with 200, recording the headers it was sent. */
function okFetch(body: unknown): { fetchFn: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

// A value that already carries `tid=` is a Copilot SESSION token, so the reader
// uses it directly and skips the exchange — keeps these tests to a single fetch.
const token = async (): Promise<string | null> => 'tid=sess-abc'

beforeEach(() => clearCopilotCatalogCache())

describe('fetchCopilotCatalog — #1929', () => {
  it('parses a bare array, keeping id/label/context window', async () => {
    const { fetchFn } = okFetch([
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', capabilities: { limits: { max_context_window_tokens: 200_000 } } },
      { id: 'gpt-5-mini', capabilities: { limits: { max_prompt_tokens: 128_000 } } },
    ])
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models).toEqual([
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', contextWindowTokens: 200_000 },
      { id: 'gpt-5-mini', contextWindowTokens: 128_000 },
    ])
  })

  it('parses the OpenAI-style { data: [...] } envelope', async () => {
    const { fetchFn } = okFetch({ data: [{ id: 'claude-sonnet-5' }] })
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5'])
  })

  it('sends the Copilot bearer token and integration id', async () => {
    const { fetchFn, calls } = okFetch([{ id: 'gpt-5-mini' }])
    await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(calls[0]?.url).toContain('api.githubcopilot.com/models')
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tid=sess-abc')
    expect(calls[0]?.headers['Copilot-Integration-Id']).toBe('vscode-chat')
  })

  it('exchanges a GitHub OAuth token for a session token before /models', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    // URL-aware: the exchange endpoint returns a session token; /models returns
    // the catalogue only when called with that session token as Bearer.
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const headers = (init?.headers as Record<string, string>) ?? {}
      calls.push({ url: u, headers })
      if (u.includes('copilot_internal/v2/token')) {
        return { ok: true, status: 200, json: async () => ({ token: 'tid=exchanged' }) } as Response
      }
      if (headers['Authorization'] !== 'Bearer tid=exchanged') {
        return { ok: false, status: 401, json: async () => ({}) } as Response
      }
      return { ok: true, status: 200, json: async () => [{ id: 'claude-sonnet-5' }] } as Response
    }) as unknown as typeof fetch
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: async () => 'gho_rawtoken' })
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5'])
    expect(calls[0]?.url).toContain('copilot_internal/v2/token')
    expect(calls[0]?.headers['Authorization']).toBe('token gho_rawtoken')
    expect(calls[1]?.url).toContain('api.githubcopilot.com/models')
  })

  it('returns [] when the token exchange is refused', async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('copilot_internal/v2/token')) {
        return { ok: false, status: 401, json: async () => ({}) } as Response
      }
      return { ok: true, status: 200, json: async () => [{ id: 'x' }] } as Response
    }) as unknown as typeof fetch
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: async () => 'gho_bad' })
    expect(models.map((m) => m.id)).toEqual(COPILOT_BUILTIN_MODEL_IDS)
  })

  it('drops models the plan has disabled — never offer a turn that refuses', async () => {
    const { fetchFn } = okFetch([
      { id: 'gpt-5', model_picker_enabled: false },
      { id: 'gpt-5-mini', enabled: false },
      { id: 'claude-sonnet-4.5' },
    ])
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-4.5'])
  })

  it('falls back to the built-in catalogue with no token (never signed in)', async () => {
    const { fetchFn, calls } = okFetch([{ id: 'x' }])
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: async () => null })
    expect(models.map((m) => m.id)).toEqual(COPILOT_BUILTIN_MODEL_IDS)
    expect(calls).toHaveLength(0) // never even called the network
  })

  it('falls back to the built-in catalogue on a non-ok response', async () => {
    const fetchFn = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response) as unknown as typeof fetch
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models.map((m) => m.id)).toEqual(COPILOT_BUILTIN_MODEL_IDS)
  })

  it('falls back to the built-in catalogue when the network throws', async () => {
    const fetchFn = (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models.map((m) => m.id)).toEqual(COPILOT_BUILTIN_MODEL_IDS)
  })

  it('falls back to the built-in catalogue on a body that is neither array nor { data }', async () => {
    const { fetchFn } = okFetch({ nope: true })
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models.map((m) => m.id)).toEqual(COPILOT_BUILTIN_MODEL_IDS)
  })

  it('caches — a second call in the TTL does not hit the network again', async () => {
    const { fetchFn, calls } = okFetch([{ id: 'gpt-5-mini' }])
    await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(calls).toHaveLength(1)
  })

  it('de-dupes ids and skips malformed rows', async () => {
    const { fetchFn } = okFetch([
      { id: 'gpt-5-mini' },
      { id: 'gpt-5-mini' },
      { id: 'has space' },
      { notAnId: true },
      null,
    ])
    const models = await fetchCopilotCatalog({ fetchFn, tokenFn: token })
    expect(models.map((m) => m.id)).toEqual(['gpt-5-mini'])
  })
})
