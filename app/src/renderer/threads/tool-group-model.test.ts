import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import {
  COMMAND_GROUP_KEY,
  commandGroupHeaderLabel,
  CONTEXT_GROUP_KEY,
  contextGroupHeaderLabel,
  FILE_GROUPING_TOOLS,
  GROUP_THRESHOLD,
  groupHeaderLabel,
  groupPresentation,
  groupStatus,
  parseFileGroupKey,
  planToolGroups,
  toolCallGroupKey,
  toolFilePath,
  toolVerb,
  unknownGroupHeaderLabel,
  commandNames,
  MAX_NAMED_COMMANDS,
} from './tool-group-model'

// ── Fixtures ────────────────────────────────────────────────────────────────

type Entry =
  | { kind: 'tool'; toolCall: ToolCallRecord }
  | { kind: 'message'; id: string }

let seq = 0
const toolCall = (
  toolName: string,
  input: Record<string, unknown> | null,
  status: ToolCallStatus = 'success',
): ToolCallRecord => ({
  id: `tc-${(seq += 1)}`,
  threadId: 't1',
  messageId: null,
  toolName,
  inputJson: input === null ? null : JSON.stringify(input),
  outputJson: null,
  status,
  startedAt: '2026-09-07T00:00:00.000Z',
  completedAt: null,
})

const tool = (
  toolName: string,
  input: Record<string, unknown> | null,
  status: ToolCallStatus = 'success',
): Entry => ({ kind: 'tool', toolCall: toolCall(toolName, input, status) })

const message = (): Entry => ({ kind: 'message', id: `m-${(seq += 1)}` })

const keyOf = (entry: Entry): string | null =>
  entry.kind === 'tool' ? toolCallGroupKey(entry.toolCall) : null

// ── toolFilePath / toolCallGroupKey ──────────────────────────────────────────

describe('toolFilePath', () => {
  it('reads a string file_path', () => {
    expect(toolFilePath(toolCall('Edit', { file_path: 'src/a.ts' }))).toBe('src/a.ts')
  })
  it('is null with no input, no file_path, blank, or malformed json', () => {
    expect(toolFilePath(toolCall('Edit', null))).toBeNull()
    expect(toolFilePath(toolCall('Edit', { pattern: 'x' }))).toBeNull()
    expect(toolFilePath(toolCall('Edit', { file_path: '   ' }))).toBeNull()
    expect(toolFilePath({ ...toolCall('Edit', null), inputJson: 'not json' })).toBeNull()
  })
  it("reads NotebookEdit's notebook_path, which is not called file_path (F-14)", () => {
    // The whole tool states its target under a different key. Reading only
    // `file_path` made every notebook edit look like a call that touched
    // nothing — no group, and zero files in the turn summary.
    expect(toolFilePath(toolCall('NotebookEdit', { notebook_path: 'nb/a.ipynb' }))).toBe(
      'nb/a.ipynb',
    )
    expect(toolFilePath(toolCall('NotebookEdit', { notebook_path: '  ' }))).toBeNull()
  })
  it('prefers file_path when a call somehow carries both', () => {
    const both = toolCall('NotebookEdit', { file_path: 'a.ts', notebook_path: 'b.ipynb' })
    expect(toolFilePath(both)).toBe('a.ts')
  })
})

describe('FILE_GROUPING_TOOLS', () => {
  it('covers every tool that writes a file, MultiEdit included (F-14)', () => {
    // `turnSummary` counts files through this set, so a tool missing from it
    // does not merely fail to group — its whole turn reports no files touched.
    expect([...FILE_GROUPING_TOOLS].sort()).toEqual(['edit', 'multiedit', 'notebookedit', 'write'])
  })
})

describe('toolCallGroupKey', () => {
  it('keys file-oriented tools by lowercased tool + file_path', () => {
    const NL = String.fromCharCode(10)
    expect(toolCallGroupKey(toolCall('Edit', { file_path: 'src/a.ts' }))).toBe('edit' + NL + 'src/a.ts')
    expect(toolCallGroupKey(toolCall('NotebookEdit', { file_path: 'n.ipynb' }))).toBe(
      'notebookedit' + NL + 'n.ipynb',
    )
  })
  it('groups MultiEdit and a real NotebookEdit input (F-14)', () => {
    const NL = String.fromCharCode(10)
    expect(toolCallGroupKey(toolCall('MultiEdit', { file_path: 'src/a.ts' }))).toBe(
      'multiedit' + NL + 'src/a.ts',
    )
    expect(toolCallGroupKey(toolCall('NotebookEdit', { notebook_path: 'nb/a.ipynb' }))).toBe(
      'notebookedit' + NL + 'nb/a.ipynb',
    )
  })
  it('keys read-only exploratory tools by the shared context key, ignoring file/pattern', () => {
    expect(toolCallGroupKey(toolCall('Read', { file_path: 'src/a.ts' }))).toBe('context')
    expect(toolCallGroupKey(toolCall('Grep', { pattern: 'x' }))).toBe('context')
    expect(toolCallGroupKey(toolCall('Glob', { pattern: '**/*.ts' }))).toBe('context')
    expect(toolCallGroupKey(toolCall('WebSearch', { query: 'x' }))).toBe('context')
    expect(toolCallGroupKey(toolCall('WebFetch', { url: 'https://x' }))).toBe('context')
  })
  it('keys a shell command by the shared command key, distinct from context', () => {
    // A command and a file read are different activities; folding bash into
    // `Gathered context` would tell the reader they are the same one.
    expect(toolCallGroupKey(toolCall('Bash', { command: 'ls' }))).toBe(COMMAND_GROUP_KEY)
    expect(COMMAND_GROUP_KEY).not.toBe('context')
  })
  it('never groups a brain-search bash call, which has its own Knowledge search card', () => {
    expect(
      toolCallGroupKey(toolCall('Bash', { command: 'planflow-ai brain search "turn fold"' })),
    ).toBeNull()
    // A mere MENTION of the invocation is an ordinary command and still groups —
    // the exclusion asks tool-card-model's matcher, so the two can't disagree.
    expect(
      toolCallGroupKey(toolCall('Bash', { command: 'grep -n "planflow-ai brain search" src/a.ts' })),
    ).toBe(COMMAND_GROUP_KEY)
  })
  it('is null for unhandled tools and for file tools without a file_path', () => {
    expect(toolCallGroupKey(toolCall('TodoWrite', { todos: [] }))).toBeNull()
    expect(toolCallGroupKey(toolCall('Edit', null))).toBeNull()
  })
  it('distinguishes different files and file tools from context tools', () => {
    const a = toolCallGroupKey(toolCall('Edit', { file_path: 'src/a.ts' }))
    const b = toolCallGroupKey(toolCall('Edit', { file_path: 'src/b.ts' }))
    const r = toolCallGroupKey(toolCall('Read', { file_path: 'src/a.ts' }))
    expect(a).not.toBe(b)
    expect(a).not.toBe(r)
  })
})

// ── planToolGroups ────────────────────────────────────────────────────────────

describe('planToolGroups', () => {
  it('collapses a contiguous run of >=2 same tool+file into one group', () => {
    const entries = [
      tool('Edit', { file_path: 'src/a.ts' }),
      tool('Edit', { file_path: 'src/a.ts' }),
      tool('Edit', { file_path: 'src/a.ts' }),
    ]
    const units = planToolGroups(entries, keyOf)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ grouped: true })
    if (units[0].grouped) expect(units[0].entries).toHaveLength(3)
  })

  it('leaves a single call ungrouped', () => {
    const units = planToolGroups([tool('Edit', { file_path: 'src/a.ts' })], keyOf)
    expect(units).toEqual([{ grouped: false, entry: expect.anything() }])
  })

  it('breaks a run on a different file', () => {
    const units = planToolGroups(
      [
        tool('Edit', { file_path: 'src/a.ts' }),
        tool('Edit', { file_path: 'src/a.ts' }),
        tool('Edit', { file_path: 'src/b.ts' }),
        tool('Edit', { file_path: 'src/b.ts' }),
      ],
      keyOf,
    )
    expect(units).toHaveLength(2)
    expect(units.every((u) => u.grouped)).toBe(true)
  })

  it('breaks a run on a different tool', () => {
    const units = planToolGroups(
      [
        tool('Edit', { file_path: 'src/a.ts' }),
        tool('Read', { file_path: 'src/a.ts' }),
        tool('Edit', { file_path: 'src/a.ts' }),
      ],
      keyOf,
    )
    // three lone calls — no two contiguous share a key
    expect(units).toHaveLength(3)
    expect(units.every((u) => !u.grouped)).toBe(true)
  })

  it('breaks a run on an interleaved message', () => {
    const units = planToolGroups(
      [
        tool('Edit', { file_path: 'src/a.ts' }),
        message(),
        tool('Edit', { file_path: 'src/a.ts' }),
      ],
      keyOf,
    )
    expect(units).toHaveLength(3)
    expect(units.every((u) => !u.grouped)).toBe(true)
  })

  it('never groups a tool with no file_path or an ungrouped tool', () => {
    const units = planToolGroups(
      [
        tool('TodoWrite', { todos: [] }),
        tool('TodoWrite', { todos: [] }),
        tool('Edit', null),
        tool('Edit', null),
      ],
      keyOf,
    )
    expect(units).toHaveLength(4)
    expect(units.every((u) => !u.grouped)).toBe(true)
  })

  it('collapses a contiguous run of >=2 shell commands into one command group', () => {
    const units = planToolGroups(
      [
        tool('Bash', { command: 'git status' }),
        tool('Bash', { command: 'npm test' }),
        tool('Bash', { command: 'git diff' }),
      ],
      keyOf,
    )
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ grouped: true, key: COMMAND_GROUP_KEY })
    if (units[0].grouped) expect(units[0].entries).toHaveLength(3)
  })

  it('breaks a command run on an intervening message', () => {
    // Contiguity is deliberate: the feed's chronology is never reordered, so a
    // command before and after the agent's prose are two runs, not one.
    const units = planToolGroups(
      [
        tool('Bash', { command: 'git status' }),
        tool('Bash', { command: 'npm test' }),
        message(),
        tool('Bash', { command: 'git diff' }),
        tool('Bash', { command: 'git log' }),
      ],
      keyOf,
    )
    expect(units.map((u) => u.grouped)).toEqual([true, false, true])
  })

  it('does not swallow a brain search into a surrounding command run', () => {
    const units = planToolGroups(
      [
        tool('Bash', { command: 'git status' }),
        tool('Bash', { command: 'npm test' }),
        tool('Bash', { command: 'planflow-ai brain search "turn fold"' }),
        tool('Bash', { command: 'git diff' }),
        tool('Bash', { command: 'git log' }),
      ],
      keyOf,
    )
    // The Knowledge search card stays its own row, and it breaks the run.
    expect(units.map((u) => u.grouped)).toEqual([true, false, true])
  })

  it('keeps a command run and a context run as two groups, not one', () => {
    const units = planToolGroups(
      [
        tool('Bash', { command: 'git status' }),
        tool('Bash', { command: 'npm test' }),
        tool('Read', { file_path: 'src/a.ts' }),
        tool('Read', { file_path: 'src/b.ts' }),
      ],
      keyOf,
    )
    expect(units).toHaveLength(2)
    expect(units.map((u) => (u.grouped ? u.key : null))).toEqual([
      COMMAND_GROUP_KEY,
      'context',
    ])
  })

  it('groups two adjacent runs and keeps a lone call between them ungrouped', () => {
    const units = planToolGroups(
      [
        tool('Edit', { file_path: 'src/a.ts' }),
        tool('Edit', { file_path: 'src/a.ts' }),
        tool('Bash', { command: 'npm test' }),
        tool('Read', { file_path: 'src/b.ts' }),
        tool('Read', { file_path: 'src/b.ts' }),
      ],
      keyOf,
    )
    expect(units.map((u) => u.grouped)).toEqual([true, false, true])
  })

  it('preserves order and every entry (grouped + ungrouped) round-trips', () => {
    const entries = [
      tool('Edit', { file_path: 'src/a.ts' }),
      tool('Edit', { file_path: 'src/a.ts' }),
      message(),
      tool('Bash', { command: 'ls' }),
    ]
    const units = planToolGroups(entries, keyOf)
    const flat = units.flatMap((u) => (u.grouped ? u.entries : [u.entry]))
    expect(flat).toEqual(entries)
  })

  it('uses GROUP_THRESHOLD as the minimum run length', () => {
    expect(GROUP_THRESHOLD).toBe(2)
  })
})

// ── Labels + status ───────────────────────────────────────────────────────────

describe('groupHeaderLabel', () => {
  it('picks a past-tense verb and count noun per tool', () => {
    expect(groupHeaderLabel('Edit', 'src/foo.ts', 3)).toBe('Edited src/foo.ts · 3 changes')
    expect(groupHeaderLabel('Write', 'src/foo.ts', 2)).toBe('Wrote src/foo.ts · 2 writes')
    expect(groupHeaderLabel('Read', 'src/foo.ts', 4)).toBe('Read src/foo.ts · 4 reads')
    expect(groupHeaderLabel('NotebookEdit', 'n.ipynb', 2)).toBe('Edited n.ipynb · 2 changes')
  })
  it('toolVerb falls back to the raw name for unknown tools', () => {
    expect(toolVerb('Custom')).toBe('Custom')
  })
  it('reads MultiEdit as an edit, not as its own raw name', () => {
    expect(toolVerb('MultiEdit')).toBe('Edited')
    expect(groupHeaderLabel('MultiEdit', 'src/foo.ts', 2)).toBe('Edited src/foo.ts · 2 changes')
  })
})

describe('contextGroupHeaderLabel', () => {
  it('pluralizes step count', () => {
    expect(contextGroupHeaderLabel(1)).toContain('1 step')
    expect(contextGroupHeaderLabel(3)).toContain('3 steps')
    expect(contextGroupHeaderLabel(3)).toContain('Gathered context')
  })
})

describe('commandGroupHeaderLabel', () => {
  it('pluralizes the command count', () => {
    expect(commandGroupHeaderLabel(1)).toBe('Ran 1 command')
    expect(commandGroupHeaderLabel(6)).toBe('Ran 6 commands')
  })
  it('reads as a different activity from a context run', () => {
    expect(commandGroupHeaderLabel(3)).not.toContain('Gathered context')
  })
})

describe('groupStatus', () => {
  it('is running when any call is pending or running', () => {
    expect(groupStatus(['success', 'running', 'success'])).toBe('running')
    expect(groupStatus(['pending', 'success'])).toBe('running')
  })
  it('surfaces a real failure as error', () => {
    expect(groupStatus(['success', 'error'])).toBe('error')
  })
  it('keeps denied and interrupted as their own glyphs, not error', () => {
    // #1217: a user-stopped run must stay neutral, never render as a failure.
    expect(groupStatus(['success', 'denied'])).toBe('denied')
    expect(groupStatus(['success', 'interrupted'])).toBe('interrupted')
    expect(groupStatus(['interrupted', 'interrupted'])).toBe('interrupted')
  })
  it('is success only when every call succeeded', () => {
    expect(groupStatus(['success', 'success'])).toBe('success')
  })
  it('ranks worst-first: running > error > denied > interrupted > success', () => {
    expect(groupStatus(['error', 'running'])).toBe('running')
    expect(groupStatus(['interrupted', 'error'])).toBe('error')
    expect(groupStatus(['interrupted', 'denied'])).toBe('denied')
  })
})

// ── parseFileGroupKey + groupPresentation ────────────────────────────────────

describe('parseFileGroupKey', () => {
  it('reads back exactly what toolCallGroupKey wrote', () => {
    const key = toolCallGroupKey(toolCall('Edit', { file_path: 'src/a.ts' }))
    expect(key).not.toBeNull()
    expect(parseFileGroupKey(key as string)).toEqual({ toolName: 'edit', filePath: 'src/a.ts' })
  })
  it('is null for the shared keys and for anything that is not a file key', () => {
    expect(parseFileGroupKey(CONTEXT_GROUP_KEY)).toBeNull()
    expect(parseFileGroupKey(COMMAND_GROUP_KEY)).toBeNull()
    expect(parseFileGroupKey('')).toBeNull()
    // A separator with nothing on one side is not a file key either — that is
    // precisely the empty path the old fallback used to render.
    expect(parseFileGroupKey(String.fromCharCode(10) + 'src/a.ts')).toBeNull()
    expect(parseFileGroupKey('edit' + String.fromCharCode(10))).toBeNull()
  })
})

/**
 * F-8. `groupPresentation` decides BOTH halves of a collapsed group's header,
 * and nothing asserted either — least of all the icon, which is the half a
 * reader uses to tell a run of commands from a run of reads without expanding
 * anything.
 */
describe('groupPresentation', () => {
  const anyRecord = toolCall('Edit', { file_path: 'src/a.ts' })

  it('presents a context run as gathered context, with the search icon', () => {
    const p = groupPresentation(CONTEXT_GROUP_KEY, [toolCall('Read', { file_path: 'src/a.ts' })], 3)
    expect(p.label).toBe(contextGroupHeaderLabel(3))
    expect(p.icon).toBe('search')
  })

  it('presents a command run as commands ran, with the terminal icon', () => {
    const p = groupPresentation(COMMAND_GROUP_KEY, [toolCall('Bash', { command: 'ls' })], 6)
    // The row NAMES what ran (user call 2026-09-08) — 'Ran 6 commands' alone
    // read identically whether those were six greps or six force-pushes.
    expect(p.label).toBe('Ran 6 commands ' + String.fromCharCode(183) + ' ls')
    expect(p.icon).toBe('terminal')
    // The bug this function was written for: a bash group taking the
    // file-oriented arm and rendering the wrong noun over an empty path.
    expect(p.label).not.toContain('changes')
  })

  it("presents a file run with the path from the key and the tool's own icon", () => {
    const record = toolCall('Edit', { file_path: 'src/a.ts' })
    const key = toolCallGroupKey(record) as string
    const p = groupPresentation(key, [record], 3)
    expect(p.label).toBe('Edited src/a.ts · 3 changes')
    expect(p.icon).toBe('pencil')
  })

  it("takes a notebook run's path from the key, not from a re-read of file_path", () => {
    const record = toolCall('NotebookEdit', { notebook_path: 'nb/a.ipynb' })
    const key = toolCallGroupKey(record) as string
    expect(groupPresentation(key, [record], 2).label).toBe('Edited nb/a.ipynb · 2 changes')
  })

  it('does NOT hand an unrecognised key to the file arm (F-8)', () => {
    // The arm that renders a file must be REACHED BY RECOGNITION. Collapsing
    // the pane's two ternaries into this function left the file case as the
    // `else`, so a fourth kind of group would land there exactly as bash did:
    // a noun asserting a change that may not have happened, over a path that
    // does not exist. This is the assertion that would have been red.
    const record = toolCall('TodoWrite', { todos: [] })
    const p = groupPresentation('some-future-group-kind', [record], 3)
    expect(p.label).not.toContain('changes')
    expect(p.label).not.toContain('Edited')
    expect(p.label).toBe(unknownGroupHeaderLabel('TodoWrite', 3))
    expect(p.label).toContain('TodoWrite')
    expect(p.label).toContain('3 steps')
    expect(p.icon).toBe('check')
  })

  it('never renders a header with an empty path where a path belongs', () => {
    for (const key of [CONTEXT_GROUP_KEY, COMMAND_GROUP_KEY, 'unknown', 'edit']) {
      const label = groupPresentation(key, [anyRecord], 2).label
      expect(label).not.toContain('  ')
      expect(label.trim()).toBe(label)
    }
  })
})

describe('unknownGroupHeaderLabel', () => {
  it('names the tool and counts the calls, and claims nothing more', () => {
    expect(unknownGroupHeaderLabel('TodoWrite', 1)).toBe('TodoWrite · 1 step')
    expect(unknownGroupHeaderLabel('TodoWrite', 4)).toBe('TodoWrite · 4 steps')
  })
})

describe('commandNames — the row says what ran, and judges nothing', () => {
  const bash = (command: string): ToolCallRecord => toolCall('Bash', { command })

  it('names each distinct command in the order it ran', () => {
    expect(commandNames([bash('git commit -m x'), bash('git push'), bash('rm -rf ./tmp')])).toEqual([
      'git commit',
      'git push',
      'rm',
    ])
  })

  it('keeps a driver with its subcommand, because that is the command', () => {
    expect(commandNames([bash('npm run build')])).toEqual(['npm run'])
    expect(commandNames([bash('npx jest src/a.test.ts')])).toEqual(['npx jest'])
  })

  it('does not read a flag as a subcommand', () => {
    expect(commandNames([bash('git --version')])).toEqual(['git'])
  })

  it('deduplicates, because the count is already on the row', () => {
    expect(commandNames([bash('grep -n a'), bash('grep -n b'), bash('grep -n c')])).toEqual(['grep'])
  })

  it('elides past the cap rather than filling the row', () => {
    const names = commandNames([bash('a'), bash('b'), bash('c'), bash('d'), bash('e')])
    expect(names).toHaveLength(MAX_NAMED_COMMANDS + 1)
    expect(names[names.length - 1]).toBe(String.fromCharCode(8230))
  })

  it('skips a call whose input cannot be read, rather than guessing', () => {
    const broken: ToolCallRecord = { ...bash('ls'), inputJson: '{not json' }
    expect(commandNames([broken, bash('ls')])).toEqual(['ls'])
  })

  it('never classifies — a destructive command is named, not judged', () => {
    // The plan ruled out reading argv to decide what is dangerous. This reports
    // what ran and lets the reader recognise it.
    const label = commandGroupHeaderLabel(2, commandNames([bash('rm -rf /'), bash('ls')]))
    expect(label).toContain('rm')
    expect(label).not.toMatch(/danger|destructive|warning/i)
  })
})
