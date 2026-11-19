import type { ConnectorEntry, ConnectorSuggestion } from '../../shared/connectors'
import {
  ACTION_LABELS,
  FIXED_STRINGS,
  ONLY_THIS_PROJECT_TAG,
  accountLabelOf,
  actionOf,
  connectorSections,
  detailOf,
  managedElsewhereOf,
  pillOf,
  removeConfirmText,
  rowOf,
  sectionKeyOf,
  signInOutcomeLine,
  signOutConfirmText,
  splitArgs,
  suggestedSection,
  MAX_SUGGESTIONS_SHOWN,
  NOT_NOW_LABEL,
  SUGGESTED_SUBTEXT,
  validateAddForm,
  type AddFormInput,
} from './connectors-settings-model'

const CONTEXT = { accountLabel: 'Work', projectName: 'Acme' }

function entry(overrides: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    name: 'linear',
    displayName: 'Linear',
    source: 'account',
    transport: 'web',
    status: 'connected',
    tools: [{ name: 'list_issues' }, { name: 'create_issue' }],
    iconHints: [],
    removable: true,
    scope: 'account',
    askFirst: [],
    ...overrides,
  }
}

function form(overrides: Partial<AddFormInput> = {}): AddFormInput {
  return {
    name: 'linear',
    connectsBy: 'web',
    address: 'https://mcp.linear.app/mcp',
    program: '',
    args: '',
    availableIn: 'account',
    ...overrides,
  }
}

describe('sections', () => {
  const entries: ConnectorEntry[] = [
    entry({ name: 'sentry', displayName: 'Sentry', scope: 'project-local' }),
    entry({ name: 'github', displayName: 'GitHub' }),
    entry({ name: 'db', displayName: 'Database', source: 'project', scope: 'project-shared', transport: 'program' }),
    entry({
      name: 'claude.ai Gmail',
      displayName: 'Gmail',
      source: 'claudeai',
      transport: 'claudeai',
      removable: false,
      scope: undefined,
    }),
    entry({ name: 'plugin:vercel:vercel', displayName: 'Vercel', source: 'plugin', removable: false, scope: undefined }),
  ]

  it('groups account, project, Claude.ai and plugin connectors in that order, with headings', () => {
    const sections = connectorSections(entries, CONTEXT)
    expect(sections.map((section) => section.key)).toEqual(['account', 'project', 'claudeai', 'plugin'])
    expect(sections.map((section) => section.heading)).toEqual([
      'Work · every project on this account',
      'Acme · shared with the team',
      'From Claude.ai · the connectors on your Claude.ai account',
      'From plugins',
    ])
  })

  it('lists a project-local connector with the account, after its own, tagged "Only this project"', () => {
    const account = connectorSections(entries, CONTEXT)[0]
    expect(account?.rows.map((row) => row.name)).toEqual(['github', 'sentry'])
    expect(account?.rows[1]?.tag).toBe(ONLY_THIS_PROJECT_TAG)
    expect(account?.rows[0]?.tag).toBeUndefined()
    expect(sectionKeyOf({ source: 'account', scope: 'project-local' })).toBe('account')
  })

  it('puts only the shared project file under the project heading', () => {
    expect(sectionKeyOf({ source: 'project', scope: 'project-shared' })).toBe('project')
    expect(sectionKeyOf({ source: 'project', scope: undefined })).toBe('project')
  })

  it('leaves out an empty section, and answers nothing for nothing', () => {
    expect(connectorSections([entry()], CONTEXT).map((section) => section.key)).toEqual(['account'])
    expect(connectorSections([], CONTEXT)).toEqual([])
  })

  it('sorts rows by display name, ignoring case', () => {
    const rows = connectorSections(
      [entry({ name: 'b', displayName: 'beta' }), entry({ name: 'a', displayName: 'Alpha' })],
      CONTEXT,
    )[0]?.rows
    expect(rows?.map((row) => row.name)).toEqual(['a', 'b'])
  })
})

describe('pills and actions', () => {
  it('gives one pill per status', () => {
    expect(pillOf('connected')).toEqual({ tone: 'ok', label: 'Connected' })
    expect(pillOf('needs-auth')).toEqual({ tone: 'warn', label: 'Needs sign-in' })
    expect(pillOf('failed')).toEqual({ tone: 'error', label: 'Not working' })
    expect(pillOf('pending')).toEqual({ tone: 'neutral', label: 'Starting' })
    expect(pillOf('disabled')).toEqual({ tone: 'off', label: 'Off' })
    expect(pillOf('off')).toEqual({ tone: 'off', label: 'Off' })
  })

  it('offers Sign in, Retry, Sign out, or nothing', () => {
    expect(actionOf({ status: 'needs-auth', transport: 'web' })).toBe('sign-in')
    expect(actionOf({ status: 'failed', transport: 'program' })).toBe('retry')
    expect(actionOf({ status: 'connected', transport: 'web' })).toBe('sign-out')
    expect(actionOf({ status: 'connected', transport: 'claudeai' })).toBe('sign-out')
    expect(actionOf({ status: 'connected', transport: 'program' })).toBeNull()
    expect(actionOf({ status: 'pending', transport: 'web' })).toBeNull()
    expect(actionOf({ status: 'disabled', transport: 'claudeai' })).toBeNull()
    expect(ACTION_LABELS).toEqual({ 'sign-in': 'Sign in', retry: 'Retry', 'sign-out': 'Sign out' })
  })

  it('reads the quiet line from the error first, then the tool count or state', () => {
    expect(detailOf(entry())).toBe('2 tools')
    expect(detailOf(entry({ tools: [{ name: 'one' }] }))).toBe('1 tool')
    expect(detailOf(entry({ status: 'failed', error: 'This connector could not start.' }))).toBe(
      'This connector could not start.',
    )
    expect(detailOf(entry({ status: 'pending' }))).toBe('Starting…')
    expect(detailOf(entry({ status: 'disabled', source: 'claudeai' }))).toBe('Turned off on Claude.ai.')
    expect(detailOf(entry({ status: 'needs-auth' }))).toBe('Sign in to use it.')
  })
})

describe('removable and managed elsewhere', () => {
  it('lets Flow remove a connector from one of its files, with no managed-elsewhere line', () => {
    const row = rowOf(entry(), CONTEXT)
    expect(row.removable).toBe(true)
    expect(row.scope).toBe('account')
    expect(row.managedElsewhere).toBeUndefined()
  })

  it('never removes a Claude.ai or plugin connector, and says where each is managed', () => {
    const claudeai = rowOf(entry({ source: 'claudeai', transport: 'claudeai', removable: false, scope: undefined }), CONTEXT)
    expect(claudeai.removable).toBe(false)
    expect(claudeai.managedElsewhere).toContain('Claude.ai settings')
    const plugin = rowOf(entry({ source: 'plugin', removable: false, scope: undefined }), CONTEXT)
    expect(plugin.removable).toBe(false)
    expect(plugin.managedElsewhere).toContain('plugin')
    expect(managedElsewhereOf({ source: 'account', removable: false })).toBe(
      'This connector is set up outside Flow, so Flow cannot remove it.',
    )
  })

  it('states how it connects and where it is used', () => {
    expect(rowOf(entry(), CONTEXT).facts).toEqual(['Connects by web address', 'Used in every project on this account'])
    expect(rowOf(entry({ transport: 'program', scope: 'project-local' }), CONTEXT).facts).toEqual([
      'Runs as a program on this computer',
      'Used only in Acme, just for you',
    ])
    expect(rowOf(entry({ source: 'project', scope: 'project-shared' }), CONTEXT).facts[1]).toBe(
      'Shared with the team in Acme',
    )
  })

  it('marks the tools that ask first', () => {
    const row = rowOf(entry({ askFirst: ['create_issue'] }), CONTEXT)
    expect(row.tools).toEqual([
      { name: 'list_issues', askFirst: false },
      { name: 'create_issue', askFirst: true },
    ])
  })

  it('names the account, or a plain fallback', () => {
    expect(accountLabelOf({ status: 'ready', label: 'Personal' })).toBe('Personal')
    expect(accountLabelOf({ status: 'legacy' })).toBe('Your Claude account')
    expect(accountLabelOf(null)).toBe('Your Claude account')
  })
})

describe('sign-in outcomes', () => {
  it('leaves a line only when a sign-in did not finish', () => {
    expect(signInOutcomeLine('connected')).toBeNull()
    expect(signInOutcomeLine('cancelled')).toBeNull()
    expect(signInOutcomeLine('timed-out')).toContain('too long')
    expect(signInOutcomeLine('failed')).toContain('did not finish')
  })
})

describe('the add form', () => {
  it('makes a web connector for the chosen scope', () => {
    expect(validateAddForm(form())).toEqual({
      ok: true,
      name: 'linear',
      scope: 'account',
      config: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    })
    expect(validateAddForm(form({ address: 'http://localhost:3000/sse', availableIn: 'project-shared' }))).toEqual({
      ok: true,
      name: 'linear',
      scope: 'project-shared',
      config: { type: 'sse', url: 'http://localhost:3000/sse' },
    })
  })

  it('makes a program connector, with its arguments split and quotes kept whole', () => {
    expect(
      validateAddForm(
        form({ connectsBy: 'program', program: 'npx', args: '-y "my server" --port 3', availableIn: 'project-local' }),
      ),
    ).toEqual({
      ok: true,
      name: 'linear',
      scope: 'project-local',
      config: { type: 'stdio', command: 'npx', args: ['-y', 'my server', '--port', '3'] },
    })
    expect(validateAddForm(form({ connectsBy: 'program', program: 'server' }))).toMatchObject({
      ok: true,
      config: { type: 'stdio', command: 'server' },
    })
  })

  it('refuses each problem with a sentence and the field it is about', () => {
    expect(validateAddForm(form({ name: '  ' }))).toMatchObject({ ok: false, field: 'name' })
    expect(validateAddForm(form({ name: 'Flow' }))).toMatchObject({ ok: false, field: 'name', problem: expect.stringContaining('reserved') })
    expect(validateAddForm(form({ name: 'has space' }))).toMatchObject({ ok: false, field: 'name' })
    expect(validateAddForm(form(), ['Linear'])).toMatchObject({ ok: false, field: 'name', problem: expect.stringContaining('already') })
    expect(validateAddForm(form({ address: 'mcp.linear.app' }))).toMatchObject({ ok: false, field: 'address' })
    expect(validateAddForm(form({ address: 'ftp://example.com' }))).toMatchObject({ ok: false, field: 'address' })
    expect(validateAddForm(form({ connectsBy: 'program', program: ' ' }))).toMatchObject({ ok: false, field: 'program' })
    expect(validateAddForm(form({ connectsBy: 'program', program: 'x', args: '"open' }))).toMatchObject({ ok: false, field: 'args' })
  })

  it('splits arguments', () => {
    expect(splitArgs('')).toEqual([])
    expect(splitArgs("a 'b c' \"\"")).toEqual(['a', 'b c', ''])
    expect(splitArgs('"x')).toBeNull()
  })
})

// ── forbidden-pattern #12 ───────────────────────────────────────────────────

function everyString(): string[] {
  const out = [...FIXED_STRINGS]
  const statuses = ['connected', 'needs-auth', 'failed', 'pending', 'disabled', 'off'] as const
  const sources = ['account', 'project', 'claudeai', 'plugin'] as const
  for (const source of sources) {
    for (const status of statuses) {
      const row = rowOf(entry({ source, status, removable: false, scope: undefined }), CONTEXT)
      out.push(row.detail, row.pill.label, ...row.facts)
      if (row.managedElsewhere !== undefined) out.push(row.managedElsewhere)
    }
  }
  out.push(...connectorSections([entry({ scope: 'project-local' })], CONTEXT).map((section) => section.heading))
  out.push(removeConfirmText('Linear'), signOutConfirmText('Linear'))
  for (const outcome of ['timed-out', 'failed'] as const) out.push(signInOutcomeLine(outcome) ?? '')
  const problems: AddFormInput[] = [
    form({ name: '' }),
    form({ name: 'flow' }),
    form({ name: 'a b' }),
    form({ address: 'nope' }),
    form({ connectsBy: 'program', program: '' }),
    form({ connectsBy: 'program', program: 'x', args: '"' }),
  ]
  for (const input of problems) {
    const result = validateAddForm(input)
    if (!result.ok) out.push(result.problem)
  }
  out.push((validateAddForm(form(), ['linear']) as { problem: string }).problem)
  return out
}

describe('forbidden-pattern #12: no commands, paths, keys or emoji', () => {
  const strings = everyString()

  it('collected a real surface to scan (the positive before the absence)', () => {
    expect(strings.length).toBeGreaterThan(60)
    expect(strings).toContain('Needs sign-in')
    expect(strings).toContain('Every project on this account')
  })

  const FORBIDDEN: [string, RegExp][] = [
    ['a slash path', /[A-Za-z0-9_~-]\/[A-Za-z0-9_~-]|^\/|\s\/|\\/],
    ['a dotfile or config file', /(^|\s)\.[a-z]|\.json\b|\.mcp\b/i],
    ['the CLI', /planflow|plan-flow|\bclaude mcp\b/i],
    ['a flag', /(^|\s)--?[a-z][a-z-]*/],
    ['a URL', /https?:|www\.|:\/\//i],
    ['a backtick', /`/],
    ['a config key', /\b[a-z]+_[a-z_]+\b|\b(stdio|sse|mcpServers|command|args)\b/],
    ['an internal word', /\b(MCP|IPC|JSON|scope|transport|payload|OAuth|token)\b/],
    ['an emoji', /\p{Extended_Pictographic}/u],
  ]

  it.each(FORBIDDEN)('contains no %s', (_what, pattern) => {
    expect(strings.filter((text) => pattern.test(text))).toEqual([])
  })
})

describe('Suggested for <project>', () => {
  function suggestion(name: string, reasonKind: ConnectorSuggestion['reasonKind'] = 'files'): ConnectorSuggestion {
    return { name, displayName: name.toUpperCase(), reasonKind, reason: 'Named in this project\u2019s docs.' }
  }

  it('is shown with a heading, the sub-text and one line of why per row', () => {
    const section = suggestedSection([suggestion('linear', 'repo')], 'Acme')
    expect(section).toEqual({
      heading: 'Suggested for Acme',
      subtext: SUGGESTED_SUBTEXT,
      rows: [{ name: 'linear', displayName: 'LINEAR', reason: 'Named in this project\u2019s docs.' }],
      fingerprints: ['linear|repo'],
    })
  })

  it('is hidden when there is nothing to suggest', () => {
    expect(suggestedSection([], 'Acme')).toBeNull()
  })

  it('shows at most three rows, while "Not now" covers every suggestion', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => suggestion(name))
    const section = suggestedSection(many, 'Acme')
    expect(MAX_SUGGESTIONS_SHOWN).toBe(3)
    expect(section?.rows.map((row) => row.name)).toEqual(['a', 'b', 'c'])
    expect(section?.fingerprints).toEqual(['a|files', 'b|files', 'c|files', 'd|files', 'e|files'])
  })

  it('leaves out what "Not now" hid, and hides the section when nothing is left', () => {
    const list = [suggestion('linear'), suggestion('sentry')]
    expect(suggestedSection(list, 'Acme')?.rows).toHaveLength(2)
    expect(suggestedSection(list, 'Acme', new Set(['linear|files']))?.rows.map((row) => row.name)).toEqual(['sentry'])
    expect(suggestedSection(list, 'Acme', new Set(['linear|files', 'sentry|files']))).toBeNull()
    // A new kind of reason is a different fingerprint: shown again.
    expect(suggestedSection([suggestion('linear', 'used')], 'Acme', new Set(['linear|files']))?.rows).toHaveLength(1)
  })

  it('drops a row once its connector no longer asks to sign in', () => {
    const list = [suggestion('linear'), suggestion('sentry')]
    const section = suggestedSection(list, 'Acme', new Set(), (name) => name !== 'linear')
    expect(section?.rows.map((row) => row.name)).toEqual(['sentry'])
  })

  it('names no command, path or config key', () => {
    for (const text of [SUGGESTED_SUBTEXT, NOT_NOW_LABEL, suggestedSection([suggestion('x')], 'Acme')?.heading ?? '']) {
      expect(text).not.toMatch(/[`/\\]|planflow|\.json|=/)
    }
  })
})
