/**
 * The composer's connectors chip and per-chat list (plan_connectors, Phase 6).
 */
import type { ConnectorEntry } from '../../shared/connectors'
import {
  changeConcerns,
  connectorChipView,
  connectorOn,
  findConnectorEntry,
  emptySentence,
  onOfTotal,
  signInOutcomeSentence,
} from './connector-chip-model'

function entry(name: string, patch: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    source: 'account',
    transport: 'web',
    status: 'connected',
    tools: [{ name: 'a' }, { name: 'b' }],
    iconHints: [],
    removable: true,
    askFirst: [],
    ...patch,
  }
}

describe('connectorChipView — the chip', () => {
  it('is hidden when the project has no connectors', () => {
    const view = connectorChipView({ entries: [], mode: 'thread' })
    expect(view.visible).toBe(false)
    expect(view.groups).toEqual([])
    expect(view.noMatch).toBe(false)
  })

  it('counts the connectors on for this chat, and labels them', () => {
    const view = connectorChipView({
      entries: [entry('linear'), entry('vercel'), entry('sentry', { status: 'off', offInThread: true })],
      mode: 'thread',
    })
    expect(view.visible).toBe(true)
    expect(view.onCount).toBe(2)
    expect(view.total).toBe(3)
    expect(view.label).toBe('2 connectors')
    expect(onOfTotal(view)).toBe('2 of 3 on')
    expect(connectorChipView({ entries: [entry('linear')], mode: 'thread' }).label).toBe('1 connector')
  })

  it('draws up to three icons, of connectors that are on, by name', () => {
    const view = connectorChipView({
      entries: [entry('zed'), entry('alpha'), entry('mid'), entry('beta'), entry('off', { status: 'off', offInThread: true })],
      mode: 'thread',
    })
    expect(view.icons.map((icon) => icon.name)).toEqual(['alpha', 'beta', 'mid'])
  })

  it('raises attention for an on connector that is not working, never for one left out of the list', () => {
    expect(connectorChipView({ entries: [entry('a')], mode: 'thread' }).attention).toBe(false)
    // Needs sign-in: left out of the composer list, so no dot either.
    expect(connectorChipView({ entries: [entry('a', { status: 'needs-auth' })], mode: 'thread' }).attention).toBe(false)
    expect(connectorChipView({ entries: [entry('a', { status: 'failed' })], mode: 'thread' }).attention).toBe(true)
    // Switched off on the new-chat page: nobody needs to look at it.
    expect(
      connectorChipView({ entries: [entry('a', { status: 'failed' })], mode: 'draft', draftOff: new Set(['a']) }).attention,
    ).toBe(false)
  })
})

describe('connectorChipView — the list', () => {
  const entries = [
    entry('plugin_vercel', { source: 'plugin', displayName: 'Vercel' }),
    entry('claude.ai Linear', { source: 'claudeai', displayName: 'Linear', transport: 'claudeai' }),
    entry('sentry', { source: 'project' }),
    entry('github', { source: 'account', displayName: 'GitHub' }),
    entry('asana', { source: 'account' }),
  ]

  it('groups rows by source in a fixed order, sorted by name', () => {
    const view = connectorChipView({ entries, mode: 'thread' })
    expect(view.groups.map((group) => group.label)).toEqual(['This account', 'This project', 'From Claude.ai', 'From a plugin'])
    expect(view.groups[0]?.rows.map((row) => row.displayName)).toEqual(['Asana', 'GitHub'])
  })

  it('filters by display name or configured name, case-insensitively', () => {
    expect(connectorChipView({ entries, mode: 'thread', filter: 'LIN' }).groups.map((g) => g.rows.map((r) => r.name))).toEqual([
      ['claude.ai Linear'],
    ])
    expect(connectorChipView({ entries, mode: 'thread', filter: 'plugin_' }).groups[0]?.rows[0]?.name).toBe('plugin_vercel')
    const none = connectorChipView({ entries, mode: 'thread', filter: 'nothing' })
    expect(none.groups).toEqual([])
    expect(none.noMatch).toBe(true)
    // The chip itself is not filtered.
    expect(none.onCount).toBe(5)
  })

  it('picks one control per row: switch, sign in, or not working', () => {
    const view = connectorChipView({
      entries: [
        entry('ok'),
        entry('broken', { status: 'failed', error: 'This connector could not start.' }),
        entry('pending', { status: 'pending', tools: [] }),
      ],
      mode: 'thread',
    })
    const rows = Object.fromEntries(view.groups.flatMap((g) => g.rows).map((row) => [row.name, row]))
    expect(rows['ok']).toMatchObject({ control: 'switch', on: true, toggleable: true, detail: '2 tools' })
    expect(rows['auth']).toBeUndefined()
    expect(rows['broken']).toMatchObject({ control: 'not-working', detail: 'This connector could not start.' })
    expect(rows['pending']).toMatchObject({ control: 'switch', detail: 'Connecting' })
  })

  it('shows a connector this chat turned off as an off switch', () => {
    const row = connectorChipView({ entries: [entry('a', { status: 'off', offInThread: true })], mode: 'thread' }).groups[0]?.rows[0]
    expect(row).toMatchObject({ control: 'switch', on: false, toggleable: true, detail: 'Off for this chat' })
  })

  it('lists only what is enabled; the filter never reaches the rest', () => {
    const disabled = entry('claude.ai Notion', { source: 'claudeai', status: 'disabled', displayName: 'Notion' })
    const auth = entry('claude.ai Figma', { source: 'claudeai', status: 'needs-auth', displayName: 'Figma' })
    const entries = [disabled, auth, entry('a'), entry('b', { status: 'off', offInThread: true })]
    const view = connectorChipView({ entries, mode: 'thread' })
    // The positive first (#28): the enabled ones, and the one this chat turned off, are listed.
    expect(view.groups.flatMap((g) => g.rows.map((r) => r.name))).toEqual(['a', 'b'])
    expect(view).toMatchObject({ onCount: 1, total: 2, hiddenCount: 2 })
    expect(emptySentence(view)).toBeNull()
    // …and a filter does not bring back what is not enabled.
    expect(connectorChipView({ entries, mode: 'thread', filter: 'fig' })).toMatchObject({ groups: [], noMatch: true })
    // Nothing enabled: the chip still shows, the list says where to go.
    const none = connectorChipView({ entries: [auth, disabled], mode: 'thread' })
    expect(none).toMatchObject({ visible: true, label: 'Connectors', total: 0, groups: [] })
    expect(emptySentence(none)).toBe('No connector is set up yet. Manage connectors to sign in to one.')
    // A runtime-disabled connector is never on, not even in a draft.
    expect(connectorOn(disabled, 'draft', new Set())).toBe(false)
  })
})

describe('connectorChipView — draft vs chat', () => {
  it('draft mode reads the page draft, not the chat answer', () => {
    const entries = [entry('a'), entry('b')]
    const view = connectorChipView({ entries, mode: 'draft', draftOff: new Set(['b']) })
    expect(view.onCount).toBe(1)
    expect(view.groups[0]?.rows.find((row) => row.name === 'b')).toMatchObject({ on: false, control: 'switch' })
  })

  it('thread mode ignores a draft and reads offInThread', () => {
    const entries = [entry('a', { offInThread: false }), entry('b', { offInThread: true, status: 'off' })]
    const view = connectorChipView({ entries, mode: 'thread', draftOff: new Set(['a']) })
    expect(view.groups[0]?.rows.map((row) => [row.name, row.on])).toEqual([
      ['a', true],
      ['b', false],
    ])
  })
})

describe('findConnectorEntry — the icon loader name mapping', () => {
  const entries = [entry('claude.ai Linear'), entry('plugin:vercel:vercel'), entry('linear')]

  it('prefers the exact configured name', () => {
    expect(findConnectorEntry(entries, 'linear')?.name).toBe('linear')
    expect(findConnectorEntry(entries, 'claude.ai Linear')?.name).toBe('claude.ai Linear')
  })

  it('maps the tool-name form back to the configured name', () => {
    expect(findConnectorEntry(entries, 'claude_ai_Linear')?.name).toBe('claude.ai Linear')
    expect(findConnectorEntry(entries, 'plugin_vercel_vercel')?.name).toBe('plugin:vercel:vercel')
  })

  it('answers null for a name nobody lists', () => {
    expect(findConnectorEntry(entries, 'sentry')).toBeNull()
  })
})

describe('changeConcerns — which lists a change makes stale', () => {
  const chat = { projectRoot: '/p', threadId: 't1' }
  const project = { projectRoot: '/p' }
  const other = { projectRoot: '/q', threadId: 't2' }

  it('a chat on/off concerns that chat only', () => {
    const event = { projectRoot: '/p', threadId: 't1' }
    expect(changeConcerns(event, chat)).toBe(true)
    expect(changeConcerns(event, project)).toBe(false)
    expect(changeConcerns(event, other)).toBe(false)
  })

  it('a write concerns every list (an account entry reaches every project)', () => {
    expect(changeConcerns({ projectRoot: '/p' }, other)).toBe(true)
    expect(changeConcerns({}, chat)).toBe(true)
  })

  it('a sign-in end concerns the whole project', () => {
    const event = { projectRoot: '/p', threadId: 't1', signIn: { name: 'a', outcome: 'connected' as const } }
    expect(changeConcerns(event, project)).toBe(true)
    expect(changeConcerns(event, chat)).toBe(true)
    expect(changeConcerns(event, other)).toBe(false)
  })
})

describe('signInOutcomeSentence', () => {
  it('says nothing for a connected sign-in, and a sentence otherwise', () => {
    expect(signInOutcomeSentence('Linear', 'connected')).toBeNull()
    expect(signInOutcomeSentence('Linear', 'timed-out')).toBe('Signing in to Linear took too long. Try again.')
    expect(signInOutcomeSentence('Linear', 'failed')).toContain('Linear')
  })
})
