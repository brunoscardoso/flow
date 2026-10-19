import { unpreparedNote } from './unprepared-worktree'

const CARRIED = ['node_modules', '.env*', 'flow']

function input(over: Partial<Parameters<typeof unpreparedNote>[0]> = {}) {
  return {
    setupConfigured: false,
    carried: CARRIED,
    projectHas: () => false,
    ...over,
  }
}

describe('unpreparedNote — the copy that cannot work yet', () => {
  it('speaks up for a project that keeps its environment in the tree', () => {
    const note = unpreparedNote(input({ projectHas: (dir) => dir === '.venv' }))
    expect(note).toContain('Python environment')
    // It says where to fix it in the app's own terms — a reader can open a
    // panel; they cannot press the name of a setting (forbidden-pattern #12).
    expect(note).toContain('Conversation files settings')
    expect(note).not.toMatch(/worktree_setup|workspace_setup|\.flowconfig|uv sync|`/)
    // The section is named as a person reads it — never the internal noun.
    expect(note).not.toMatch(/workspace|worktree/i)
  })

  it('says nothing to a project that already answered the question', () => {
    // Whether the answer is any GOOD is not this function's business — it
    // reports that nobody was asked, not that the command works.
    expect(
      unpreparedNote(input({ setupConfigured: true, projectHas: (dir) => dir === '.venv' })),
    ).toBeNull()
  })

  it('says nothing when the folder is one the cut already carried', () => {
    expect(
      unpreparedNote(
        input({ carried: [...CARRIED, '.venv'], projectHas: (dir) => dir === '.venv' }),
      ),
    ).toBeNull()
  })

  it('says nothing to a project with no such folder beside it', () => {
    // THE EVIDENCE IS THE FOLDER, NOT A MANIFEST. A project can name Python in
    // a pyproject.toml and keep its environment somewhere else entirely.
    expect(unpreparedNote(input())).toBeNull()
  })

  it('leaves the ecosystems that do not need it alone', () => {
    // Go and Rust caches are global — a fresh checkout builds, slowly and
    // correctly — and `vendor/` is tracked in some ecosystems and not others.
    for (const dir of ['target', 'vendor', 'node_modules', '.gradle']) {
      expect(unpreparedNote(input({ projectHas: (asked) => asked === dir }))).toBeNull()
    }
  })
})
