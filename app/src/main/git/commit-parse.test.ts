import {
  MAX_REFS_PER_COMMIT,
  buildCommitFiles,
  parseDecorations,
  parseNameStatusZ,
  parseNumstatZ,
} from './commit-parse'

describe('parseDecorations', () => {
  it('types each ref from its full name and marks the branch HEAD is on', () => {
    expect(
      parseDecorations(
        'HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v0.2.8',
      ),
    ).toEqual([
      { kind: 'branch', name: 'main', current: true },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v0.2.8' },
    ])
  })

  it('tells a local branch named like a remote from the remote branch', () => {
    expect(parseDecorations('refs/heads/origin/x, refs/remotes/origin/x')).toEqual([
      { kind: 'branch', name: 'origin/x' },
      { kind: 'remote', name: 'origin/x' },
    ])
  })

  it('reports a detached HEAD and drops stash and notes', () => {
    expect(parseDecorations('HEAD, refs/stash, refs/notes/commits')).toEqual([{ kind: 'head', name: 'HEAD' }])
    expect(parseDecorations('')).toEqual([])
  })

  it('is bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag: refs/tags/b${i}`).join(', ')
    expect(parseDecorations(many)).toHaveLength(MAX_REFS_PER_COMMIT)
  })
})

describe('commit files', () => {
  const nameStatus = ['M', 'app/src/a.ts', 'A', 'app/new.md', 'R087', 'app/old.ts', 'app/moved.ts', 'D', 'other/x.ts', ''].join('\0')
  const numstat = ['3\t1\tapp/src/a.ts', '10\t0\tapp/new.md', '2\t2\t', 'app/old.ts', 'app/moved.ts', '0\t5\tother/x.ts', '-\t-\tapp/logo.png', ''].join('\0')

  it('parses name-status with renames', () => {
    expect(parseNameStatusZ(nameStatus)).toEqual([
      { state: 'modified', path: 'app/src/a.ts' },
      { state: 'added', path: 'app/new.md' },
      { state: 'renamed', path: 'app/moved.ts', renamedFrom: 'app/old.ts' },
      { state: 'deleted', path: 'other/x.ts' },
    ])
  })

  it('parses numstat, binary files as unknown counts', () => {
    const counts = parseNumstatZ(numstat)
    expect(counts.get('app/moved.ts')).toEqual({ added: 2, deleted: 2 })
    expect(counts.get('app/logo.png')).toEqual({ added: null, deleted: null })
  })

  it('keeps only the project subtree, project-relative, and caps the list', () => {
    const result = buildCommitFiles(nameStatus, numstat, 'app/', 2)
    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.files).toEqual([
      { filePath: 'src/a.ts', state: 'modified', added: 3, deleted: 1 },
      { filePath: 'new.md', state: 'added', added: 10, deleted: 0 },
    ])
    const all = buildCommitFiles(nameStatus, numstat, 'app/', 50)
    expect(all.files[2]).toEqual({ filePath: 'moved.ts', state: 'renamed', renamedFrom: 'old.ts', added: 2, deleted: 2 })
  })
})
