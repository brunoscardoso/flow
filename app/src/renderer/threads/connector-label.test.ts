/**
 * Connector calls in plain words (plan_connectors, note 7): one label rule for
 * the tool card, the work row and the permission card.
 */
import {
  CONNECTOR_HUE_COUNT,
  callDuration,
  connectorCall,
  connectorErrorSentence,
  connectorHueSlot,
  connectorInitial,
  connectorNameFromServer,
  connectorPermissionTitle,
  readableAction,
  toolNameForm,
  usedConnectors,
} from './connector-label'

describe('connectorCall — the forms a connector tool name arrives in', () => {
  it('reads the Claude form', () => {
    expect(connectorCall('mcp__linear__search_issues')).toEqual({
      serverName: 'linear',
      connectorName: 'Linear',
      action: 'Search issues',
    })
  })

  it('reads a Claude.ai connector, sanitized', () => {
    expect(connectorCall('mcp__claude_ai_Linear__search_issues')).toEqual({
      serverName: 'claude_ai_Linear',
      connectorName: 'Linear',
      action: 'Search issues',
    })
    expect(connectorCall('mcp__claude_ai_Google_Drive__fetch')?.connectorName).toBe('Google Drive')
  })

  it('reads a plugin server by its last part', () => {
    expect(connectorCall('mcp__plugin_vercel_vercel__list_projects')).toEqual({
      serverName: 'plugin_vercel_vercel',
      connectorName: 'Vercel',
      action: 'List projects',
    })
  })

  it('keeps a server name holding underscores and hyphens', () => {
    expect(connectorCall('mcp__my_linear-server__getIssue')).toEqual({
      serverName: 'my_linear-server',
      connectorName: 'My Linear Server',
      action: 'Get issue',
    })
  })

  it('lets a known server win a split when the server holds a double underscore', () => {
    const displayNames = new Map([['odd__name', 'Odd']])
    expect(connectorCall('mcp__odd__name__do_it', { displayNames })).toEqual({
      serverName: 'odd__name',
      connectorName: 'Odd',
      action: 'Do it',
    })
    expect(connectorCall('mcp__odd__name__do_it')?.serverName).toBe('odd')
  })

  it('reads the Copilot form', () => {
    expect(connectorCall('github-mcp-server-get_issue')).toEqual({
      serverName: 'github-mcp-server',
      connectorName: 'Github Mcp Server',
      action: 'Get issue',
    })
    expect(connectorCall('linear-search_issues', { displayNames: new Map([['linear', 'Linear']]) })).toEqual({
      serverName: 'linear',
      connectorName: 'Linear',
      action: 'Search issues',
    })
  })

  it('returns null for Flow’s own tools', () => {
    expect(connectorCall('mcp__flow__board_list')).toBeNull()
    expect(connectorCall('flow-board_list')).toBeNull()
  })

  it('returns null for every tool that is not a connector’s', () => {
    for (const name of ['Bash', 'Read', 'Edit', 'Write', 'TodoWrite', 'Task', 'bash', 'view', 'str_replace_editor', 'report_intent', '', 'mcp__', 'mcp__linear', 'mcp__linear__']) {
      expect(connectorCall(name)).toBeNull()
    }
  })

  it('takes the display name from the connector list, by configured name or tool-name form', () => {
    expect(
      connectorCall('mcp__claude_ai_Linear__search_issues', {
        displayNames: new Map([['claude.ai Linear', 'Linear (work)']]),
      })?.connectorName,
    ).toBe('Linear (work)')
    expect(
      connectorCall('mcp__github__list_prs', { displayNames: new Map([['github', 'GitHub']]) })?.connectorName,
    ).toBe('GitHub')
  })
})

describe('readableAction', () => {
  it('reads snake, camel and kebab case as plain words', () => {
    expect(readableAction('search_issues')).toBe('Search issues')
    expect(readableAction('getIssue')).toBe('Get issue')
    expect(readableAction('list-pull-requests')).toBe('List pull requests')
  })

  it('keeps acronyms readable', () => {
    expect(readableAction('get_PR_URL')).toBe('Get PR URL')
    expect(readableAction('getURLForId')).toBe('Get URL for id')
    expect(readableAction('list_PRs')).toBe('List PRs')
    expect(readableAction('SEARCH_ISSUES')).toBe('Search issues')
  })
})

describe('connectorNameFromServer / toolNameForm', () => {
  it('mirrors the runtime’s sanitizing', () => {
    expect(toolNameForm('claude.ai Linear')).toBe('claude_ai_Linear')
    expect(toolNameForm('plugin:vercel:vercel')).toBe('plugin_vercel_vercel')
    expect(connectorNameFromServer('linear-server')).toBe('Linear Server')
  })
})

describe('usedConnectors', () => {
  it('returns the distinct connectors in order of first use', () => {
    const used = usedConnectors([
      { toolName: 'Read' },
      { toolName: 'mcp__sentry__get_event' },
      { toolName: 'mcp__linear__search_issues' },
      { toolName: 'mcp__sentry__list_issues' },
      { toolName: 'mcp__flow__board_list' },
    ])
    expect(used).toEqual([
      { serverName: 'sentry', connectorName: 'Sentry' },
      { serverName: 'linear', connectorName: 'Linear' },
    ])
  })
})

describe('the initial icon', () => {
  it('picks a stable hue slot within the palette', () => {
    const slot = connectorHueSlot('linear')
    expect(slot).toBe(connectorHueSlot('linear'))
    expect(slot).toBeGreaterThanOrEqual(0)
    expect(slot).toBeLessThan(CONNECTOR_HUE_COUNT)
    const slots = new Set(['linear', 'github', 'sentry', 'vercel', 'notion', 'slack', 'figma', 'stripe'].map(connectorHueSlot))
    expect(slots.size).toBeGreaterThan(1)
  })

  it('shows the first letter or digit, upper-cased', () => {
    expect(connectorInitial('linear')).toBe('L')
    expect(connectorInitial('  (beta) notion')).toBe('B')
    expect(connectorInitial('42 things')).toBe('4')
    expect(connectorInitial('---')).toBe('?')
  })
})

describe('connectorPermissionTitle', () => {
  it('asks in plain words', () => {
    expect(connectorPermissionTitle({ connectorName: 'Linear', action: 'Search issues' })).toBe(
      'Allow Linear to search issues?',
    )
    expect(connectorPermissionTitle({ connectorName: 'GitHub', action: 'PR comments' })).toBe(
      'Allow GitHub to PR comments?',
    )
  })
})

describe('connectorErrorSentence', () => {
  it('reads the error’s own sentence', () => {
    expect(connectorErrorSentence('{"error":"Not signed in"}')).toBe('Not signed in')
    expect(connectorErrorSentence('{"message":"Rate limited"}')).toBe('Rate limited')
    expect(connectorErrorSentence('"Boom"')).toBe('Boom')
    expect(connectorErrorSentence('plain text failure')).toBe('plain text failure')
    expect(connectorErrorSentence(null)).toBeNull()
    expect(connectorErrorSentence('{"content":[]}')).toBeNull()
  })
})

describe('callDuration', () => {
  it('reads short words for a finished call', () => {
    expect(callDuration('2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.420Z')).toBe('420 ms')
    expect(callDuration('2026-10-08T10:00:00.000Z', '2026-10-08T10:00:01.200Z')).toBe('1.2 s')
    expect(callDuration('2026-10-08T10:00:00.000Z', '2026-10-08T10:02:00.000Z')).toBe('2 min')
    expect(callDuration('2026-10-08T10:00:00.000Z', null)).toBeNull()
    expect(callDuration('nope', '2026-10-08T10:00:00.000Z')).toBeNull()
  })
})
