// claude-history parser tests — pure `parseSession` over synthetic JSONL, plus
// escape-scheme checks and a guarded live check against the real ~/.claude store.

import { existsSync, readFileSync } from 'node:fs'

import {
  escapeProjectPath,
  claudeProjectDir,
  listSessionFiles,
  parseSession,
} from './claude-history'

/** Build one JSONL line from an object. */
function line(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('escapeProjectPath', () => {
  it('replaces every slash with a dash', () => {
    expect(escapeProjectPath('/Users/x/Projects/plan-flow')).toBe(
      '-Users-x-Projects-plan-flow',
    )
  })

  it('preserves existing hyphens and strips a trailing slash', () => {
    expect(escapeProjectPath('/a/b-c/')).toBe('-a-b-c')
  })

  it('claudeProjectDir lands under ~/.claude/projects', () => {
    expect(claudeProjectDir('/a/b')).toContain('/.claude/projects/-a-b')
  })
})

describe('listSessionFiles', () => {
  it('returns [] for a project with no Claude Code history (missing dir)', () => {
    expect(listSessionFiles('/nonexistent/project/xyz-123')).toEqual([])
  })
})

describe('parseSession', () => {
  it('parses string content, derives title from ai-title, and timestamps', () => {
    const lines = [
      line({ type: 'file-history-snapshot' }), // noise
      line({
        type: 'user',
        sessionId: 'abc',
        timestamp: '2026-05-28T15:34:29.896Z',
        message: { role: 'user', content: 'do the thing' },
      }),
      line({ type: 'ai-title', sessionId: 'abc', aiTitle: 'Do the thing' }),
      line({
        type: 'assistant',
        sessionId: 'abc',
        timestamp: '2026-05-28T15:34:41.099Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }),
    ]
    const session = parseSession(lines)
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe('abc')
    expect(session!.title).toBe('Do the thing')
    expect(session!.messages).toHaveLength(2)
    expect(session!.messages[0]).toMatchObject({ role: 'user', content: 'do the thing' })
    expect(session!.createdAt).toBe('2026-05-28T15:34:29.896Z')
    expect(session!.updatedAt).toBe('2026-05-28T15:34:41.099Z')
  })

  it('renders tool_use as a compact marker and omits tool_result payloads', () => {
    const lines = [
      line({
        type: 'assistant',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me look' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'x' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } },
          ],
        },
      }),
      line({
        type: 'user',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'HUGE OUTPUT', is_error: false }],
        },
      }),
    ]
    const session = parseSession(lines)
    expect(session).not.toBeNull()
    // The tool_result-only user turn produces no content → dropped.
    expect(session!.messages).toHaveLength(1)
    expect(session!.messages[0]!.content).toBe('let me look\n⤷ Bash: npm test\n⤷ Edit: src/foo.ts')
    expect(session!.messages[0]!.content).not.toContain('HUGE OUTPUT')
  })

  it('falls back to the first user message for the title when no ai-title', () => {
    const session = parseSession([
      line({
        type: 'user',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'First line here\nsecond line' },
      }),
    ])
    expect(session!.title).toBe('First line here')
  })

  it('uses the default title when there is no ai-title and no user text', () => {
    const session = parseSession([
      line({
        type: 'assistant',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
    ])
    expect(session!.title).toBe('Claude Code session')
  })

  it('skips malformed lines instead of failing the whole session', () => {
    const session = parseSession([
      'not json at all {',
      line({
        type: 'user',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'survives' },
      }),
      '',
    ])
    expect(session).not.toBeNull()
    expect(session!.messages).toHaveLength(1)
  })

  it('returns null for a session with zero usable messages', () => {
    expect(parseSession([line({ type: 'system' }), line({ type: 'mode' })])).toBeNull()
    expect(parseSession([])).toBeNull()
  })

  it('caps oversized message content', () => {
    const huge = 'x'.repeat(20_000)
    const session = parseSession([
      line({
        type: 'user',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: huge },
      }),
    ])
    expect(session!.messages[0]!.content.length).toBeLessThanOrEqual(8_000)
  })

  it('latest ai-title wins', () => {
    const session = parseSession([
      line({ type: 'ai-title', aiTitle: 'first' }),
      line({
        type: 'user',
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'hey' },
      }),
      line({ type: 'ai-title', aiTitle: 'second' }),
    ])
    expect(session!.title).toBe('second')
  })
})

// Guarded live check (FR/NFR realism): only runs if this machine actually has a
// Claude Code session dir for THIS repo — otherwise it is skipped, so the suite
// never depends on developer-specific state.
describe('parseSession (live)', () => {
  const repoRoot = '/Users/dev/Projects/Personal/plan-flow'
  const dir = claudeProjectDir(repoRoot)
  const hasStore = existsSync(dir) && listSessionFiles(repoRoot).length > 0

  const maybe = hasStore ? it : it.skip
  maybe('produces at least one readable thread from the real store', () => {
    const files = listSessionFiles(repoRoot)
    const parsed = files
      .map((f) => parseSession(readFileSync(f, 'utf8').split('\n')))
      .filter((s): s is NonNullable<typeof s> => s !== null)
    expect(parsed.length).toBeGreaterThan(0)
    for (const session of parsed) {
      expect(session.sessionId).toBeTruthy()
      expect(session.title.length).toBeGreaterThan(0)
      expect(session.messages.length).toBeGreaterThan(0)
    }
  })
})
