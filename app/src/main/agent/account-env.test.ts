import { buildAccountEnv, INHERITED_AUTH_TOKENS } from './account-env'

describe('buildAccountEnv (#107)', () => {
  it('points CLAUDE_CONFIG_DIR at the account and strips every inherited token', () => {
    const base = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      HOME: '/home/me',
    }
    const env = buildAccountEnv('/cfg/account-a', base)

    expect(env['CLAUDE_CONFIG_DIR']).toBe('/cfg/account-a')
    for (const token of INHERITED_AUTH_TOKENS) {
      expect(env[token]).toBeUndefined()
    }
    // Unrelated vars pass through untouched.
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/me')
  })

  it('does not mutate the base env', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-ant-xxx' }
    buildAccountEnv('/cfg/x', base)
    expect(base.ANTHROPIC_API_KEY).toBe('sk-ant-xxx')
  })

  it('is a no-op strip when no tokens are present', () => {
    const env = buildAccountEnv('/cfg/y', { PATH: '/bin' })
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg/y' })
  })
})
