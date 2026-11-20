import { RESET_ITEMS, parseResetItems, type ResetInventoryRow } from '../../shared/reset-items'
import {
  RESET_COPY,
  RESET_GROUPS,
  confirmMatches,
  dialogView,
  itemsInGroup,
  orderedSelection,
  outcomeLine,
  selectionLine,
  sizeText,
} from './reset-model'

describe('the Reset Flow list', () => {
  it('every item has copy, and every item is in exactly one drawn group', () => {
    const drawn = RESET_GROUPS.flatMap((group) => itemsInGroup(group))
    expect(drawn.sort()).toEqual([...RESET_ITEMS].sort())
    for (const item of RESET_ITEMS) expect(RESET_COPY[item].item).toBe(item)
  })

  it('names nothing by its path, table or config key', () => {
    const text = RESET_ITEMS.map((item) => `${RESET_COPY[item].label} ${RESET_COPY[item].description}`).join('\n')
    expect(text).not.toMatch(/planflow-ai|\.json|\.flowconfig|\/|`|app_settings|sqlite/i)
  })
})

describe('parsing a reset request', () => {
  it('orders and de-duplicates known items', () => {
    expect(parseResetItems(['tasks', 'app-settings', 'tasks'])).toEqual(['app-settings', 'tasks'])
  })

  it('refuses an empty list, a non-list and an unknown item', () => {
    expect(parseResetItems([])).toBeNull()
    expect(parseResetItems('tasks')).toBeNull()
    expect(parseResetItems(['tasks', 'everything'])).toBeNull()
  })
})

describe('selection and confirmation', () => {
  it('counts the selection', () => {
    expect(selectionLine(new Set())).toBe('Nothing selected')
    expect(selectionLine(new Set(['tasks', 'conversations']))).toBe(`2 of ${String(RESET_ITEMS.length)} selected`)
    expect(orderedSelection(new Set(['tasks', 'app-settings']))).toEqual(['app-settings', 'tasks'])
  })

  it('accepts only the confirmation word', () => {
    expect(confirmMatches('delete')).toBe(true)
    expect(confirmMatches('  DELETE ')).toBe(true)
    expect(confirmMatches('dele')).toBe(false)
    expect(confirmMatches('')).toBe(false)
  })
})

describe('the dialog', () => {
  const rows: ResetInventoryRow[] = [
    { item: 'conversations', size: '214 conversations · 412 MB', empty: false, warning: null },
    { item: 'workspace-knowledge', size: '2 Workspaces', empty: false, warning: '3 Workspace changes were never synced.' },
    { item: 'tasks', size: '0 tasks', empty: true, warning: null },
  ]

  it('lists the selection with sizes and carries the warnings of selected items only', () => {
    const view = dialogView(new Set(['conversations', 'tasks']), rows, null)
    expect(view.title).toBe('Delete 2 kinds of Flow data?')
    expect(view.lines).toEqual([
      { label: 'Conversations', size: '214 conversations · 412 MB' },
      { label: 'Tasks', size: 'Nothing stored' },
    ])
    expect(view.warnings).toEqual([])
    const withKnowledge = dialogView(new Set(['workspace-knowledge']), rows, 'An agent is still working.')
    expect(withKnowledge.title).toBe('Delete 1 kind of Flow data?')
    expect(withKnowledge.warnings).toEqual(['3 Workspace changes were never synced.'])
    expect(withKnowledge.busy).toBe('An agent is still working.')
  })

  it('shows no size for a row it could not read', () => {
    expect(sizeText(undefined)).toBe('')
    expect(sizeText({ item: 'tasks', size: null, empty: false, warning: null })).toBe('')
  })
})

describe('the line after a restart', () => {
  it('is silent without an outcome, counts a success, names a failure', () => {
    expect(outcomeLine(null)).toBeNull()
    expect(outcomeLine({ at: 'x', done: ['tasks', 'logs-caches'], failed: [] })).toEqual({
      text: 'Flow deleted 2 kinds of data.',
      failed: false,
    })
    expect(
      outcomeLine({ at: 'x', done: ['tasks'], failed: [{ item: 'browser-data', detail: 'busy' }] }),
    ).toEqual({ text: 'Flow deleted 1 of 2 kinds of data. Not deleted: Built-in browser data.', failed: true })
  })
})
