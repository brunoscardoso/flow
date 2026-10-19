import {
  classifyPullFailure,
  commits,
  folderBehindView,
  type FolderBehindInput,
  type FolderBehindStatus,
} from './folder-behind-model'

const status = (over: Partial<FolderBehindStatus> = {}): FolderBehindStatus => ({
  branch: 'main',
  ahead: 0,
  behind: 7,
  dirtyFiles: 0,
  ...over,
})

const view = (over: Partial<FolderBehindInput> = {}) =>
  folderBehindView({ branch: 'main', status: status(), action: { phase: 'idle' }, ...over })

describe('commits', () => {
  it('counts in whole commits', () => {
    expect(commits(1)).toBe('1 commit')
    expect(commits(7)).toBe('7 commits')
  })
})

describe('folderBehindView — nothing pressed yet', () => {
  it('says how far behind, and offers the action', () => {
    const result = view()
    expect(result.headline).toBe('Your project folder is 7 commits behind main.')
    expect(result.sub).toBe('This conversation starts from where the folder is.')
    expect(result.control).toEqual({ label: 'Bring it up to date', kind: 'pull', busy: false })
    expect(result.tone).toBe('behind')
  })

  it('still offers it with the person’s own edits in the folder, and says they are kept', () => {
    const result = view({ status: status({ dirtyFiles: 3 }) })
    expect(result.sub).toBe('You have uncommitted changes in 3 files. They are kept.')
    expect(result.control?.kind).toBe('pull')
  })

  it('tells a diverged folder without offering to merge it', () => {
    const result = view({ status: status({ ahead: 2 }) })
    expect(result.headline).toBe('Your project folder is 7 commits behind main, and 2 commits ahead.')
    expect(result.control).toEqual({ label: 'Open the changes', kind: 'changes', busy: false })
  })

  it('reads the LIVE numbers, not the row’s — a folder pulled elsewhere says so', () => {
    // The stored row carries no count for exactly this case: somebody pulled in
    // the git panel, or in a terminal, and the transcript row is still here.
    const result = view({ status: status({ behind: 0 }) })
    expect(result.headline).toBe('Your project folder was behind main when this conversation began.')
    expect(result.sub).toBe('It is up to date now.')
    expect(result.control).toBeNull()
    expect(result.tone).toBe('quiet')
  })

  it('falls back to the past tense when the comparison cannot be read', () => {
    const result = view({ status: null })
    expect(result.headline).toBe('Your project folder was behind main when this conversation began.')
    expect(result.control).toBeNull()
  })

  it('names the branch the folder is on NOW when the two differ', () => {
    // The row was written about `main`; the folder has since been checked out
    // onto something else and is behind THAT. The live name is the true one.
    const result = view({ status: status({ branch: 'develop', behind: 2 }) })
    expect(result.headline).toBe('Your project folder is 2 commits behind develop.')
  })
})

describe('folderBehindView — the press', () => {
  it('keeps the control in place while it works', () => {
    const result = view({ action: { phase: 'working' } })
    expect(result.control).toEqual({ label: 'Bringing it up to date', kind: 'pull', busy: true })
    expect(result.headline).toBe('Your project folder is 7 commits behind main.')
  })

  it('reports what actually arrived', () => {
    const result = view({ action: { phase: 'done', received: 7 } })
    expect(result.headline).toBe('Your project folder is up to date. 7 commits arrived.')
    expect(result.control).toBeNull()
    expect(result.tone).toBe('done')
  })

  it('does not claim commits arrived when none did', () => {
    // #1336's lesson: "Up to date" over a 20-commit pull was an outright false
    // claim. The inverse — claiming commits for a no-op — is the same bug.
    const result = view({ action: { phase: 'done', received: 0 } })
    expect(result.headline).toBe('Your project folder was already up to date.')
    expect(result.tone).toBe('quiet')
  })

  it('claims no count when main could not measure one', () => {
    const result = view({ action: { phase: 'done', received: null } })
    expect(result.headline).toBe('Your project folder is up to date.')
  })

  it('prefers the press’s outcome over a stale comparison', () => {
    // POSITIVE FIRST: the status still says 7 behind — the scan that answered
    // began before the pull — and the view must not contradict what it just did.
    const stale = status({ behind: 7 })
    const result = folderBehindView({
      branch: 'main',
      status: stale,
      action: { phase: 'done', received: 7 },
    })
    expect(stale.behind).toBe(7)
    expect(result.headline).toContain('up to date')
    expect(result.headline).not.toContain('behind')
  })

  it('says what a refusal was about, in its own words', () => {
    const result = view({ action: { phase: 'refused', reason: 'local-changes' } })
    expect(result.headline).toBe('Your folder was left as it is.')
    expect(result.sub).toBe(
      'Files in your folder would have been overwritten by the new commits, so nothing was changed.',
    )
    expect(result.tone).toBe('bad')
  })

  /**
   * A REFUSAL MAY NOT BLAME THE READER FOR FLOW'S OWN EDITS.
   *
   * The provisioner writes a marker block into `.gitignore` and into a Tailwind
   * entry stylesheet IN PLACE and never commits them, so every managed project
   * is permanently dirty with Flow's own work. The old sentence called those
   * "your own uncommitted changes" and told the reader to commit them — which
   * would put Flow's block in their history — or set them aside, which the
   * provisioner undoes on the next open.
   */
  it('does not call the files the reader’s own, and prescribes nothing', () => {
    const sub = view({ action: { phase: 'refused', reason: 'local-changes' } }).sub ?? ''
    // POSITIVE FIRST (#28): there IS a sentence, so the absences below are
    // evidence about its wording rather than about an empty string.
    expect(sub.length).toBeGreaterThan(20)
    expect(sub.toLowerCase()).not.toContain('your own')
    expect(sub.toLowerCase()).not.toContain('commit them')
    expect(sub.toLowerCase()).not.toContain('stash')
  })

  it('offers the action that can help, not a press that will fail the same way', () => {
    // Retrying a pull blocked by files in the way fails identically, so "Try
    // again" there is a control that cannot do what it says
    // (forbidden-pattern #12). A remote that was unreachable may well succeed.
    expect(view({ action: { phase: 'refused', reason: 'local-changes' } }).control)
      .toEqual({ label: 'Open the changes', kind: 'changes', busy: false })
    for (const reason of ['unreachable', 'other'] as const) {
      expect(view({ action: { phase: 'refused', reason } }).control)
        .toEqual({ label: 'Try again', kind: 'pull', busy: false })
    }
  })

  it('points a conflicted pull at the changes', () => {
    const result = view({ action: { phase: 'conflicted', files: 4 } })
    expect(result.headline).toBe('4 files need you to resolve them.')
    expect(result.sub).toContain('Nothing is lost.')
    expect(result.control?.kind).toBe('changes')
  })

  it('never puts a command, a path or a setting key on screen', () => {
    // forbidden-pattern #12, over every state this notice can reach.
    const every = [
      view(),
      view({ status: status({ dirtyFiles: 2 }) }),
      view({ status: status({ ahead: 1 }) }),
      view({ status: status({ behind: 0 }) }),
      view({ status: null }),
      view({ action: { phase: 'working' } }),
      view({ action: { phase: 'done', received: 7 } }),
      view({ action: { phase: 'done', received: 0 } }),
      view({ action: { phase: 'conflicted', files: 4 } }),
      view({ action: { phase: 'refused', reason: 'local-changes' } }),
      view({ action: { phase: 'refused', reason: 'unreachable' } }),
      view({ action: { phase: 'refused', reason: 'other' } }),
    ]
    for (const one of every) {
      const text = [one.headline, one.sub ?? '', one.control?.label ?? ''].join(' ')
      expect(text).not.toMatch(/git |planflow-ai|`|--|\.flowconfig|git stash|git pull/)
    }
  })
})

describe('classifyPullFailure', () => {
  it('recognizes the person’s own changes standing in the way', () => {
    expect(
      classifyPullFailure(
        'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\nPlease commit your changes or stash them before you merge.',
      ),
    ).toBe('local-changes')
    expect(classifyPullFailure('cannot pull with rebase: You have unstaged changes.')).toBe(
      'local-changes',
    )
  })

  it('recognizes a remote it could not reach', () => {
    expect(classifyPullFailure('ssh: Could not resolve hostname github.com')).toBe('unreachable')
    expect(classifyPullFailure('fatal: Could not read from remote repository.')).toBe('unreachable')
  })

  it('refuses to guess at anything else', () => {
    // An unnamed cause beats a mis-guessed one: `other`'s sentence promises
    // nothing about why and is true whatever happened.
    expect(classifyPullFailure('fatal: refusing to merge unrelated histories')).toBe('other')
    expect(classifyPullFailure('')).toBe('other')
  })
})
