import {
  canSignInHere,
  canSignOutHere,
  claudeOnlyNote,
  installConfirm,
  installingMessage,
  noCheckAnswer,
  projectAccountSurface,
  requirementsMet,
  runtimeName,
  runtimeRequirements,
  signInUnconfirmed,
  signOutConfirm,
  type RuntimeAuthAnswer,
} from './runtime-ready'

describe('runtimeRequirements — two questions, and only two', () => {
  const answer = (provider: string, status: RuntimeAuthAnswer['status']): RuntimeAuthAnswer => ({
    provider,
    status,
    // A detail that must NEVER reach the screen: relaying it is what produced
    // "Flow could not confirm that Codex is signed in — Error loading
    // configuration: unknown variant `xhigh`…".
    detail: 'Error loading configuration: unknown variant `xhigh`',
  })

  it('reports both requirements for an external runtime', () => {
    const requirements = runtimeRequirements(answer('codex', 'ready'))
    expect(requirements.map((r) => r.label)).toEqual(['Installed', 'Signed in'])
    expect(requirementsMet(requirements)).toBe(true)
  })

  it('marks a missing tool unmet, with Install as the one action', () => {
    const [installed, signedIn] = runtimeRequirements(answer('copilot', 'not-installed'))
    expect(installed).toMatchObject({ met: false, action: 'install' })
    // And the sign-in row carries no action, because there is nothing to sign
    // into yet — offering both at once asks for an order nobody can follow.
    expect(signedIn).toMatchObject({ met: false, action: null })
  })

  it('marks a signed-out tool unmet, with Sign in as the one action', () => {
    const [installed, signedIn] = runtimeRequirements(answer('codex', 'not-signed-in'))
    expect(installed.met).toBe(true)
    expect(signedIn).toMatchObject({ met: false, action: 'sign-in' })
  })

  it('treats "could not tell" as UNMET — an unverified runtime fails at the first turn', () => {
    const requirements = runtimeRequirements(answer('codex', 'unknown'))
    expect(requirementsMet(requirements)).toBe(false)
    expect(requirements[1]).toMatchObject({ met: false, action: 'sign-in' })
  })

  it('carries no CLI text into any label', () => {
    for (const status of ['ready', 'not-installed', 'not-signed-in', 'unknown'] as const) {
      for (const requirement of runtimeRequirements(answer('codex', status))) {
        expect(requirement.label).not.toMatch(/xhigh|Error|configuration/i)
      }
    }
  })

  it('gives Claude ONE requirement — Flow ships its runtime, so nothing installs', () => {
    const requirements = runtimeRequirements(answer('claude', 'not-signed-in'))
    expect(requirements).toHaveLength(1)
    expect(requirements[0]).toMatchObject({ label: 'Account connected', met: false, action: null })
    expect(requirementsMet(runtimeRequirements(answer('claude', 'ready')))).toBe(true)
  })
})

describe('signInUnconfirmed — the difference that keeps the escape hatch honest', () => {
  it('is true only when the check could not reach an answer', () => {
    expect(signInUnconfirmed({ provider: 'codex', status: 'unknown', detail: '' })).toBe(true)
    expect(signInUnconfirmed({ provider: 'codex', status: 'not-signed-in', detail: '' })).toBe(false)
    expect(signInUnconfirmed({ provider: 'codex', status: 'ready', detail: '' })).toBe(false)
  })

  it('is never true for Claude — its answer comes from Flow’s own account store', () => {
    expect(signInUnconfirmed({ provider: 'claude', status: 'unknown', detail: '' })).toBe(false)
  })
})

describe('claudeOnlyNote — the settings below say whose they are', () => {
  it('says nothing when Claude IS the runtime', () => {
    expect(claudeOnlyNote('claude', 'accounts')).toBeNull()
    expect(claudeOnlyNote('claude', 'routing')).toBeNull()
  })

  it('explains the accounts without hiding them', () => {
    const note = claudeOnlyNote('codex', 'accounts')
    expect(note).toContain('Codex')
    expect(note).toContain('apply to Claude threads')
  })

  it('explains the routing the same way — Haiku/Sonnet/Opus are Claude’s', () => {
    const note = claudeOnlyNote('copilot', 'routing')
    expect(note).toContain('Copilot')
    expect(note).toContain('picks its own model')
  })
})

describe('canSignInHere — who Flow can sign in without a terminal', () => {
  it('is both external runtimes: each has a login that prints a URL and exits', () => {
    // Measured, not assumed: `copilot login --device-code` prints a github.com
    // device URL and a code; `codex login` runs a browser/loopback flow.
    expect(canSignInHere('codex')).toBe(true)
    expect(canSignInHere('copilot')).toBe(true)
  })

  it('is false for Claude — its login is this app’s own, one screen away', () => {
    expect(canSignInHere('claude')).toBe(false)
  })
})

describe('a missing tool is an install, not an instruction', () => {
  it('gives the Install action to the runtimes Flow can actually install', () => {
    for (const provider of ['codex', 'copilot']) {
      const [installed] = runtimeRequirements({ provider, status: 'not-installed', detail: '' })
      expect(installed).toMatchObject({ met: false, action: 'install' })
    }
  })

  it('offers no install for a runtime it has no package for — no button that fails', () => {
    const [installed] = runtimeRequirements({ provider: 'gemini', status: 'not-installed', detail: '' })
    expect(installed).toMatchObject({ met: false, action: null })
  })
})

describe('installConfirm', () => {
  it('asks a question the reader can decline, and names what will happen', () => {
    const confirmed = installConfirm('copilot')
    expect(confirmed.question).toBe('Install GitHub Copilot on this machine?')
    expect(confirmed.accept).toBe('Install GitHub Copilot')
    expect(confirmed.detail).toContain('npm')
    // The one thing an install is NOT: a sign-in. Saying so here stops the
    // reader waiting for a login that is never coming.
    expect(confirmed.detail).toMatch(/does not sign you in/i)
  })

  it('says it in the runtime\u2019s own name, not a generic one', () => {
    expect(installConfirm('codex').question).toContain('Codex')
    expect(installingMessage('codex')).toBe('Installing Codex… this can take a minute.')
  })
})

describe('noCheckAnswer — a build that cannot ask', () => {
  it('reports the same "could not tell" as an unreadable tool, escape hatch and all', () => {
    const answer = noCheckAnswer('codex')
    expect(requirementsMet(runtimeRequirements(answer))).toBe(false)
    expect(signInUnconfirmed(answer)).toBe(true)
  })
})

describe('runtimeName', () => {
  it('names the runtimes and passes anything else through unchanged', () => {
    // The FULL product name: "Copilot" alone is also Microsoft's, and the
    // ambiguity sent a user looking for the wrong sign-in.
    expect(runtimeName('copilot')).toBe('GitHub Copilot')
    expect(runtimeName('gemini')).toBe('gemini')
  })
})

describe('projectAccountSurface — the account block follows the RESOLVED provider', () => {
  it('gives a project pinned to Claude its per-project account picker', () => {
    expect(projectAccountSurface('claude')).toBe('claude-picker')
  })

  it('gives every other runtime the honest runtime block, not a Claude account list', () => {
    // Copilot and Codex keep a single global sign-in, not a per-project account,
    // so an Anthropic picker here would answer a question they never ask (#12).
    expect(projectAccountSurface('copilot')).toBe('runtime-block')
    expect(projectAccountSurface('codex')).toBe('runtime-block')
  })
})

describe('canSignOutHere — only where Flow can honour it', () => {
  it('is Codex, which has its own logout command', () => {
    expect(canSignOutHere('codex')).toBe(true)
  })

  it('is Copilot too, by removing what it stored', () => {
    // Measured: `copilot logout` → "Invalid command format", so there is no
    // command to run. What there is: a keychain item and a signed-in record.
    expect(canSignOutHere('copilot')).toBe(true)
  })

  it('says out loud what a Copilot sign-out actually does', () => {
    // A bigger promise than running a tool's own command, so it is not made
    // behind a button that looks identical to Codex's.
    const said = signOutConfirm('copilot')
    expect(said).toContain('no sign-out command')
    expect(said).toContain('keychain')
    expect(said).toContain('sign back in')
    // Codex's is the plain one — its own command does its own cleanup.
    expect(signOutConfirm('codex')).not.toContain('keychain')
  })

  it('is not Claude, whose accounts are removed in their own section', () => {
    expect(canSignOutHere('claude')).toBe(false)
  })
})
