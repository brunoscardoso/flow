import { expandCommandBody, expandSlashCommand, parseSlashCommand } from './slash-command'

describe('parseSlashCommand', () => {
  it('splits a command from its arguments', () => {
    expect(parseSlashCommand('/discovery-plan  that plan again')).toEqual({ name: 'discovery-plan', args: 'that plan again' })
    expect(parseSlashCommand('/create-plan')).toEqual({ name: 'create-plan', args: '' })
  })

  it('is null for ordinary text, even text containing a slash', () => {
    expect(parseSlashCommand('lets regenerate this /discovery-plan')).toBeNull()
    expect(parseSlashCommand('src/a.ts is broken')).toBeNull()
  })
})

describe('expandCommandBody', () => {
  it('drops the frontmatter and appends the arguments, as Claude Code does', () => {
    const file = '---\ndescription: x\n---\n\n# Create Discovery\n\nSteps.\n'
    expect(expandCommandBody(file, 'user auth')).toBe('# Create Discovery\n\nSteps.\n\nARGUMENTS: user auth')
  })

  it('fills $ARGUMENTS where the file names it', () => {
    expect(expandCommandBody('Review $ARGUMENTS carefully.', 'pr 12')).toBe('Review pr 12 carefully.')
  })

  it('adds no ARGUMENTS line when there are none', () => {
    expect(expandCommandBody('Body.', '')).toBe('Body.')
  })
})

describe('expandSlashCommand', () => {
  const files = new Map([
    ['/proj/.claude/commands/discovery-plan.md', '---\nd: x\n---\nRun discovery.'],
    ['/proj/.claude/commands/flow/set.md', 'Set a key.'],
  ])
  const read = async (path: string): Promise<string> => {
    const file = files.get(path)
    if (file === undefined) throw new Error('ENOENT')
    return file
  }

  it('expands from the first root that defines the command', async () => {
    // The worktree has no .claude/commands (it is gitignored); the project does.
    await expect(expandSlashCommand('/discovery-plan again', ['/worktree', '/proj'], read)).resolves.toBe(
      'Run discovery.\n\nARGUMENTS: again',
    )
  })

  it('maps a namespaced command to a nested file', async () => {
    await expect(expandSlashCommand('/flow:set', ['/proj'], read)).resolves.toBe('Set a key.')
  })

  it('leaves text unchanged when no root defines the command', async () => {
    await expect(expandSlashCommand('/unknown thing', ['/proj'], read)).resolves.toBe('/unknown thing')
  })
})
