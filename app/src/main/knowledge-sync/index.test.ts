import { commitLabelFor, projectRootOfThread } from './index'

describe('projectRootOfThread', () => {
  it("maps a thread working in its own checkout to its PROJECT — the one knowledge repo, never a second clone", () => {
    // A thread's checkout links flow/ to the project's flow/ (worktree.ts), so a
    // turn there writes the project's knowledge repo.
    expect(
      projectRootOfThread({ projectRoot: '/projects/app', worktreePath: '/projects/.app-threads/fix-login' }),
    ).toBe('/projects/app')
    expect(projectRootOfThread({ projectRoot: '/projects/app', worktreePath: null })).toBe('/projects/app')
  })

  it('no thread, no project', () => {
    expect(projectRootOfThread(null)).toBeNull()
    expect(projectRootOfThread({ projectRoot: '' })).toBeNull()
  })
})

describe('commitLabelFor', () => {
  it('names the skill and the project folder', () => {
    expect(commitLabelFor('/projects/app', '/execute-plan plan_login_v1.md')).toBe('/execute-plan in app')
    expect(commitLabelFor('/projects/app', '  /Review-Code')).toBe('/review-code in app')
  })

  it('a plain turn is a turn — the message text never becomes the label', () => {
    const secret = 'Draft the layoff announcement for Acme'
    expect(commitLabelFor('/projects/app', secret)).toBe('turn in app')
    expect(commitLabelFor('/projects/app', null)).toBe('turn in app')
    expect(commitLabelFor('/projects/app', '/etc/passwd please')).toBe('turn in app')
  })

  it('only the command name of a skill, never its arguments', () => {
    const label = commitLabelFor('/projects/app', '/brainstorm a private acquisition idea')
    expect(label).toBe('/brainstorm in app')
    expect(label).not.toContain('acquisition')
  })
})
