import {
  buildCommitMessagePrompt,
  generateCommitMessage,
  summarizeDiff,
} from './commit-message'

describe('summarizeDiff', () => {
  it('labels new / deleted / modified / unchanged', () => {
    expect(summarizeDiff('', 'a\nb')).toContain('new file')
    expect(summarizeDiff('a', '')).toContain('deleted file')
    expect(summarizeDiff('a', 'a')).toBe('(no textual change)')
    expect(summarizeDiff('a\nb', 'a\nb\nc')).toContain('2 → 3 lines')
  })

  it('includes a NEW file’s content so the wand can summarize it (#143)', () => {
    const content = 'export function greet() {\n  return "hi"\n}\n'
    const summary = summarizeDiff('', content)
    expect(summary).toContain('new file')
    expect(summary).toContain('export function greet') // the actual content, not just a line count
  })

  it('truncates a huge new file to the diff cap', () => {
    const huge = 'x\n'.repeat(5000)
    expect(summarizeDiff('', huge).length).toBeLessThan(huge.length)
  })
})

describe('buildCommitMessagePrompt', () => {
  it('includes each file and asks for a Conventional Commits message', () => {
    const prompt = buildCommitMessagePrompt([
      { path: 'src/a.ts', diff: 'added foo' },
      { path: 'src/b.ts', diff: 'removed bar' },
    ])
    expect(prompt).toContain('Conventional Commits')
    expect(prompt).toContain('### src/a.ts')
    expect(prompt).toContain('added foo')
  })

  it('asks for a concise, single-line message with no emoji/icons (#149)', () => {
    const prompt = buildCommitMessagePrompt([{ path: 'a.ts', diff: 'x' }])
    expect(prompt).toMatch(/no emoji or icons/i)
    expect(prompt).toMatch(/one line/i)
  })

  it('truncates a huge diff', () => {
    const prompt = buildCommitMessagePrompt([{ path: 'big.ts', diff: 'x'.repeat(10000) }])
    expect(prompt.length).toBeLessThan(5000)
  })
})

describe('generateCommitMessage', () => {
  const deps = (message: string | null) => ({
    getDiff: async (_root: string, filePath: string) => ({
      beforeContent: 'old',
      afterContent: `new for ${filePath}`,
    }),
    generate: async (_root: string, _prompt: string) => message,
  })

  it('returns null for zero files without calling generate', async () => {
    let called = false
    const result = await generateCommitMessage(
      { getDiff: deps('x').getDiff, generate: async () => ((called = true), 'x') },
      '/root',
      [],
    )
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('trims the generated message', async () => {
    expect(await generateCommitMessage(deps('  feat: thing\n'), '/root', ['a.ts'])).toBe('feat: thing')
  })

  it('is null when the AI returns nothing', async () => {
    expect(await generateCommitMessage(deps(''), '/root', ['a.ts'])).toBeNull()
  })

  it('still contributes a file whose diff cannot be read', async () => {
    let seenPrompt = ''
    const result = await generateCommitMessage(
      {
        getDiff: async () => {
          throw new Error('no diff')
        },
        generate: async (_root, prompt) => {
          seenPrompt = prompt
          return 'feat: x'
        },
      },
      '/root',
      ['broken.ts'],
    )
    expect(result).toBe('feat: x')
    expect(seenPrompt).toContain('broken.ts')
    expect(seenPrompt).toContain('diff unavailable')
  })
})

describe('empty-source guard (#1285)', () => {
  // The ✨ wand reads the STAGED diff. Offered over a group with nothing
  // approved, every file summarized to "(no textual change)" and the model
  // wrote a message from the file NAMES alone — observed live as
  // "chore(logger): touch file with no functional changes" over a full
  // rewrite of the file, which then committed verbatim.
  const unchanged = { beforeContent: 'same\n', afterContent: 'same\n' }
  const changed = { beforeContent: 'before\n', afterContent: 'after\n' }

  it('does not ask the model when every staged diff is empty', async () => {
    const generate = jest.fn(async () => 'chore(logger): touch file with no functional changes')
    const message = await generateCommitMessage(
      { getDiff: async () => unchanged, generate },
      '/root',
      ['src/logger.ts', 'src/other.ts'],
    )
    expect(message).toBeNull()
    // The point is not just the null — the model is never consulted about
    // content nobody showed it.
    expect(generate).not.toHaveBeenCalled()
  })

  it('still generates when ANY file has real staged content', async () => {
    const generate = jest.fn(async () => 'feat(payments): charge a customer card')
    const message = await generateCommitMessage(
      {
        getDiff: async (_root, filePath) => (filePath === 'src/a.ts' ? changed : unchanged),
        generate,
      },
      '/root',
      ['src/a.ts', 'src/b.ts'],
    )
    expect(message).toBe('feat(payments): charge a customer card')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('still generates when a diff is unreadable — that is unknown, not empty', async () => {
    // "(diff unavailable)" is a read failure, not proof there is nothing to
    // describe; refusing there would silently disable the feature on a flake.
    const generate = jest.fn(async () => 'chore: update files')
    const message = await generateCommitMessage(
      {
        getDiff: async () => {
          throw new Error('git exploded')
        },
        generate,
      },
      '/root',
      ['src/a.ts'],
    )
    expect(message).toBe('chore: update files')
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
