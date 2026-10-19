import { credentialPath, readConfiguredModel, readCredentials } from './runtime-credentials'

const home = '/Users/qa'
const base = { homedirFn: () => home, env: {} as NodeJS.ProcessEnv }

function withFile(path: string, contents: string): { readFileFn: (p: string) => string } {
  return {
    readFileFn: (target: string) => {
      if (target !== path) throw new Error('ENOENT')
      return contents
    },
  }
}

describe('where each runtime keeps its login', () => {
  it('is the tool’s own file, under the home it documents', () => {
    expect(credentialPath('codex', base)).toBe('/Users/qa/.codex/auth.json')
    expect(credentialPath('copilot', base)).toBe('/Users/qa/.copilot/config.json')
    expect(credentialPath('claude', base)).toBeNull()
  })

  it('honours the documented home override', () => {
    expect(credentialPath('codex', { ...base, env: { CODEX_HOME: '/tmp/cx' } })).toBe(
      '/tmp/cx/auth.json',
    )
  })
})

describe('reading Codex’s auth.json', () => {
  it('is signed in when the file holds tokens — no CLI, so no config error', () => {
    // The shape captured from a real ~/.codex/auth.json.
    const file = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { account_id: 'acct_123', id_token: 'x' },
      last_refresh: '2026-08-01T00:00:00Z',
    })
    const result = readCredentials('codex', {
      ...base,
      ...withFile('/Users/qa/.codex/auth.json', file),
    })
    expect(result).toEqual({ signedIn: true })
  })

  it('counts a stored API key as signed in', () => {
    const file = JSON.stringify({ OPENAI_API_KEY: 'sk-live', tokens: null })
    expect(
      readCredentials('codex', { ...base, ...withFile('/Users/qa/.codex/auth.json', file) }),
    ).toEqual({ signedIn: true })
  })

  it('is not signed in when the file has neither', () => {
    const file = JSON.stringify({ OPENAI_API_KEY: null, tokens: null })
    expect(
      readCredentials('codex', { ...base, ...withFile('/Users/qa/.codex/auth.json', file) })
        .signedIn,
    ).toBe(false)
  })
})

describe('reading Copilot’s config.json', () => {
  it('is signed in when the tool recorded a logged-in user', () => {
    // Captured after a real `copilot login --device-code` completed.
    const file = JSON.stringify({
      firstLaunchAt: '2026-07-28T13:59:20.262Z',
      lastLoggedInUser: { host: 'https://github.com', login: 'dev' },
      loggedInUsers: [{ host: 'https://github.com', login: 'dev' }],
    })
    expect(
      readCredentials('copilot', { ...base, ...withFile('/Users/qa/.copilot/config.json', file) }),
    ).toEqual({ signedIn: true, identity: 'dev' })
  })

  it('is not signed in when the list is empty', () => {
    const file = JSON.stringify({ loggedInUsers: [] })
    expect(
      readCredentials('copilot', { ...base, ...withFile('/Users/qa/.copilot/config.json', file) })
        .signedIn,
    ).toBe(false)
  })
})

describe('an unreadable file is not a login', () => {
  it('answers no for a missing file, a permission error, or half-written JSON', () => {
    expect(readCredentials('codex', base).signedIn).toBe(false)
    expect(
      readCredentials('copilot', {
        ...base,
        ...withFile('/Users/qa/.copilot/config.json', '{ "loggedInU'),
      }).signedIn,
    ).toBe(false)
  })
})

describe('the file is JSON with comments, and the comments are real', () => {
  it('reads a copilot config that opens with // lines', () => {
    // Verbatim from ~/.copilot/config.json — JSON.parse throws on this, which
    // is why a completed device-flow login still read as "not signed in".
    const file = [
      '// User settings belong in settings.json.',
      '// This file is managed automatically.',
      '{',
      '  "lastLoggedInUser": { "host": "https://github.com", "login": "dev" },',
      '  "loggedInUsers": [{ "host": "https://github.com", "login": "dev" }]',
      '}',
    ].join('\n')
    expect(
      readCredentials('copilot', { ...base, ...withFile('/Users/qa/.copilot/config.json', file) }),
    ).toEqual({ signedIn: true, identity: 'dev' })
  })

  it('does not mangle a // inside a value', () => {
    const file = '{ "loggedInUsers": [{ "host": "https://github.com", "login": "qa" }] }'
    expect(
      readCredentials('copilot', { ...base, ...withFile('/Users/qa/.copilot/config.json', file) })
        .identity,
    ).toBe('qa')
  })
})

describe('readConfiguredModel — the model the user already wrote down', () => {
  it('reads a top-level model from the Codex config', () => {
    // Verbatim shape from this machine's ~/.codex/config.toml.
    const file = [
      'projects = { "/x" = { trust_level = "trusted" } }',
      'model = "gpt-5.1-codex-max"',
      'model_reasoning_effort = "xhigh"',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
    ].join('\n')
    expect(
      readConfiguredModel('codex', { ...base, ...withFile('/Users/qa/.codex/config.toml', file) }),
    ).toBe('gpt-5.1-codex-max')
  })

  it('does not claim a model that belongs to a [table]', () => {
    const file = ['[some_provider]', 'model = "not-the-default"'].join('\n')
    expect(
      readConfiguredModel('codex', { ...base, ...withFile('/Users/qa/.codex/config.toml', file) }),
    ).toBeNull()
  })

  it('answers null for a runtime whose config names no model', () => {
    // ~/.copilot/config.json holds logins, not models — inventing one would be
    // a menu entry that fails at send time.
    expect(readConfiguredModel('copilot', base)).toBeNull()
    expect(readConfiguredModel('codex', base)).toBeNull()
  })
})

describe('who is signed in, in words a person can check', () => {
  /** An unsigned OIDC token — payload only, which is all this reads. */
  const idToken = (claims: Record<string, unknown>): string =>
    `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

  it('shows the email from the id_token, not the account UUID', () => {
    // "Signed in — 0c5d7381-b372-4c12-a378-9668c1203dc8" tells a person
    // nothing they can check against the account they think they are using.
    const file = JSON.stringify({
      tokens: {
        account_id: '0c5d7381-b372-4c12-a378-9668c1203dc8',
        id_token: idToken({ email: 'qa@example.com' }),
      },
    })
    expect(
      readCredentials('codex', { ...base, ...withFile('/Users/qa/.codex/auth.json', file) }),
    ).toEqual({ signedIn: true, identity: 'qa@example.com' })
  })

  it('is still signed in when the token carries no email', () => {
    const file = JSON.stringify({ tokens: { id_token: idToken({ sub: 'x' }) } })
    expect(
      readCredentials('codex', { ...base, ...withFile('/Users/qa/.codex/auth.json', file) }),
    ).toEqual({ signedIn: true })
  })

  it('never chokes on a token it cannot read', () => {
    const file = JSON.stringify({ tokens: { id_token: 'not.a.jwt' } })
    expect(
      readCredentials('codex', { ...base, ...withFile('/Users/qa/.codex/auth.json', file) })
        .signedIn,
    ).toBe(true)
  })
})
