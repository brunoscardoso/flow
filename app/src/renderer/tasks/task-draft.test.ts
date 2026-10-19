import {
  draftRef,
  emptyTaskDraft,
  newTaskDraftHasContent,
  restorableDraft,
  type PersistedNewTaskDraft,
} from './task-draft'

describe('task draft (#442)', () => {
  it('starts blank', () => {
    expect(emptyTaskDraft()).toEqual({ title: '', description: '', refs: {} })
  })

  it('round-trips title/description/refs so a tab switch preserves them', () => {
    const draft = emptyTaskDraft()
    draft.title = 'Careful title'
    draft.description = 'Long description.'
    draft.refs['jira'] = 'PROJ-1'
    // Simulate switch away and back — the cached values survive.
    expect(draft.title).toBe('Careful title')
    expect(draft.description).toBe('Long description.')
    expect(draftRef(draft, 'jira')).toBe('PROJ-1')
  })

  it('draftRef defaults to empty for an untyped source', () => {
    expect(draftRef(emptyTaskDraft(), 'github')).toBe('')
  })

  describe('newTaskDraftHasContent (#561)', () => {
    it('is false for a blank draft + blank start', () => {
      expect(newTaskDraftHasContent(emptyTaskDraft(), '')).toBe(false)
      expect(newTaskDraftHasContent(emptyTaskDraft(), '   ')).toBe(false)
    })

    it('is true when a title, description, ref, or start-with holds content', () => {
      expect(newTaskDraftHasContent({ ...emptyTaskDraft(), title: 'x' }, '')).toBe(true)
      expect(newTaskDraftHasContent({ ...emptyTaskDraft(), description: 'y' }, '')).toBe(true)
      expect(newTaskDraftHasContent({ ...emptyTaskDraft(), refs: { jira: 'PROJ-1' } }, '')).toBe(true)
      expect(newTaskDraftHasContent(emptyTaskDraft(), '/review-pr')).toBe(true)
    })

    it('ignores whitespace-only refs', () => {
      expect(newTaskDraftHasContent({ ...emptyTaskDraft(), refs: { jira: '  ' } }, '')).toBe(false)
    })

    // #996 — ticking a Context folder and nothing else is still a deliberate
    // choice, so the draft must be worth preserving on an accidental dismiss.
    it('is true when only a context folder was picked', () => {
      expect(newTaskDraftHasContent(emptyTaskDraft(), '', ['/proj/b'])).toBe(true)
    })

    it('is false for a blank draft with no context folders', () => {
      expect(newTaskDraftHasContent(emptyTaskDraft(), '', [])).toBe(false)
    })
  })

  describe('restorableDraft (#591)', () => {
    const saved: PersistedNewTaskDraft = {
      rootPath: '/proj/a',
      draft: { ...emptyTaskDraft(), title: 'A task' },
      selected: 'manual',
      start: '',
    }

    it('restores a draft only for the project it was typed in', () => {
      expect(restorableDraft(saved, '/proj/a')).toBe(saved)
    })

    it('does NOT leak a draft into another project', () => {
      expect(restorableDraft(saved, '/proj/b')).toBeNull()
    })

    it('is null when nothing is saved', () => {
      expect(restorableDraft(null, '/proj/a')).toBeNull()
    })

    // #996 — the picked context folders ride along with the text, so the whole
    // form comes back rather than a convincing-looking partial restore.
    it('carries the picked context folders back with the text', () => {
      const withRoots: PersistedNewTaskDraft = { ...saved, contextRoots: ['/proj/b'] }
      expect(restorableDraft(withRoots, '/proj/a')?.contextRoots).toEqual(['/proj/b'])
    })

    // Drafts written before the field existed must still restore.
    it('tolerates a legacy draft with no contextRoots field', () => {
      expect(restorableDraft(saved, '/proj/a')?.contextRoots).toBeUndefined()
    })
  })
})
