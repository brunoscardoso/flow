import {
  CREATE_SOURCES,
  EMPTY_THREAD_DRAFT,
  SOURCE_PLACEHOLDER,
  sourceLabel,
  submitState,
  taskCheckboxState,
} from './create-modal'

describe('the sources two dialogs share', () => {
  it('offers the same four, in the same order, to both', () => {
    // The point of the module: a fifth source added to one dialog and not the
    // other is exactly the drift this prevents (allowed-pattern #14).
    expect(CREATE_SOURCES.map((source) => source.key)).toEqual([
      'manual',
      'jira',
      'github',
      'azure',
    ])
    expect(sourceLabel('manual')).toBe('From scratch')
    expect(sourceLabel('azure')).toBe('Azure')
  })

  it('asks each imported source for the thing it can actually resolve', () => {
    expect(SOURCE_PLACEHOLDER.jira).toContain('PRJ-123')
    expect(SOURCE_PLACEHOLDER.github).toContain('GitHub issue URL')
    expect(SOURCE_PLACEHOLDER.azure).toContain('_workitems')
  })
})

describe('submitState', () => {
  const base = { title: '', reference: '', noun: 'thread' as const }

  it('will not act on an empty from-scratch title, and says so as a title', () => {
    expect(submitState({ ...base, source: 'manual' })).toEqual({
      ready: false,
      hint: 'Enter a thread title',
    })
    expect(submitState({ ...base, source: 'manual', noun: 'task' }).hint).toBe('Enter a task title')
  })

  it('names the source when a reference is what is missing', () => {
    expect(submitState({ ...base, source: 'jira' }).hint).toBe('Enter a Jira reference')
    expect(submitState({ ...base, source: 'azure' }).hint).toBe('Enter a Azure reference')
  })

  it('treats whitespace as empty', () => {
    expect(submitState({ ...base, source: 'manual', title: '   ' }).ready).toBe(false)
    expect(submitState({ ...base, source: 'github', reference: '  ' }).ready).toBe(false)
  })

  it('acts once the field the SELECTED source uses has something in it', () => {
    // A title filled while Jira is selected must not enable the button — the
    // dialog would submit a reference nobody typed.
    expect(submitState({ ...base, source: 'jira', title: 'Fix the parser' }).ready).toBe(false)
    expect(submitState({ ...base, source: 'jira', reference: 'PF-42' }).ready).toBe(true)
    expect(submitState({ ...base, source: 'manual', title: 'Fix the parser' }).ready).toBe(true)
  })

  it('never puts a command, a path or a field name in the hint (#12)', () => {
    for (const source of CREATE_SOURCES) {
      const { hint } = submitState({ ...base, source: source.key })
      expect(hint).not.toMatch(/planflow-ai|`|--|\/|\.flowconfig|projectRoot/)
    }
  })
})

describe('EMPTY_THREAD_DRAFT', () => {
  it('starts with nothing chosen', () => {
    expect(EMPTY_THREAD_DRAFT.roots).toEqual([])
    expect(EMPTY_THREAD_DRAFT.branch).toBe('')
    expect(EMPTY_THREAD_DRAFT.description).toBe('')
  })
})

describe('taskCheckboxState', () => {
  // From scratch is the ONLY source that can make a thread nobody tracks.
  it('leaves the choice open for a thread typed from scratch', () => {
    expect(taskCheckboxState({ source: 'manual', asTask: false })).toEqual({
      checked: false,
      disabled: false,
      hint: '',
    })
    expect(taskCheckboxState({ source: 'manual', asTask: true }).checked).toBe(true)
  })

  // The three importers do not create a card as a side effect — importing IS
  // creating one. So the box states the outcome instead of offering a choice.
  it.each(['jira', 'github', 'azure'] as const)('is ticked and fixed for %s', (source) => {
    const state = taskCheckboxState({ source, asTask: false })
    expect(state.checked).toBe(true)
    expect(state.disabled).toBe(true)
    expect(state.hint).toContain(sourceLabel(source))
    // forbidden-pattern #12: a disabled control's reason is a sentence about
    // the thing on screen, never a command, path or field name.
    expect(state.hint).not.toMatch(/planflow-ai|`|\.md\b|:\s*(true|false)/)
  })

  it('cannot be talked out of the card by an unticked draft', () => {
    expect(taskCheckboxState({ source: 'jira', asTask: false }).checked).toBe(true)
  })
})

describe('EMPTY_THREAD_DRAFT', () => {
  it('starts from scratch with no card', () => {
    expect(EMPTY_THREAD_DRAFT.source).toBe('manual')
    expect(EMPTY_THREAD_DRAFT.asTask).toBe(false)
  })
})
