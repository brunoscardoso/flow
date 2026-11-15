// Command usage — the terminal line buffer, the one-shot filter, the cap, the
// ranking and the merge with the file-based suggestions. Pure: no timers run,
// no settings are touched beyond an in-memory fake.

import type { RunSuggestion } from '../../shared/run-setup'
import {
  isRecordableCommand,
  rankSuggestions,
  addUsage,
  CommandUsageStore,
  feedLine,
  MAX_USAGE_ENTRIES,
  newLineBuffer,
  onceUsageSuggestions,
  parseUsageEntries,
  rankOnceSuggestions,
  usageScore,
  usageSuggestions,
  type UsageEntry,
} from './command-usage'
import { looksLongRunningCommand, looksOneShotCommand, nameForCommand } from './run-suggest'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

describe('feedLine — the terminal hot path', () => {
  it('completes a plainly typed line on Enter, one keystroke at a time', () => {
    const buffer = newLineBuffer()
    const out: string[] = []
    for (const key of 'npm run dev') out.push(...feedLine(buffer, key))
    expect(out).toEqual([])
    expect(feedLine(buffer, '\r')).toEqual(['npm run dev'])
    expect(buffer).toEqual({ text: '', tainted: false })
  })

  it('applies backspace and trims', () => {
    const buffer = newLineBuffer()
    expect(feedLine(buffer, '  npm run devx\x7f  \r')).toEqual(['npm run dev'])
  })

  it('drops a line with an escape sequence (arrow keys, history recall)', () => {
    const buffer = newLineBuffer()
    expect(feedLine(buffer, '\x1b[A\r')).toEqual([])
    expect(feedLine(buffer, 'npm run \x1b[Ddev\r')).toEqual([])
    // …and only that line: the next one counts again.
    expect(feedLine(buffer, 'make up\r')).toEqual(['make up'])
  })

  it('drops a Tab-completed line, and Ctrl-C / Ctrl-U start over', () => {
    const buffer = newLineBuffer()
    expect(feedLine(buffer, 'npm run d\t\r')).toEqual([])
    expect(feedLine(buffer, 'rm -rf build\x03npm start\r')).toEqual(['npm start'])
    expect(feedLine(buffer, 'oops\x15make dev\r')).toEqual(['make dev'])
  })

  it('ignores empty lines', () => {
    expect(feedLine(newLineBuffer(), '\r\r   \r')).toEqual([])
  })
})

describe('the one-shot filter', () => {
  it('knows the programs and words that do a job and end', () => {
    for (const command of ['cd app', 'ls -la', 'git status', 'cat README.md', 'clear', 'exit', 'npm install', 'npm run build', 'pnpm test', 'cargo build', 'FOO=1 git push'])
      expect(looksOneShotCommand(command)).toBe(true)
    for (const command of ['npm run dev', 'temporal server start-dev', 'uv run python -m jupiter_core', 'docker compose up kafka'])
      expect(looksOneShotCommand(command)).toBe(false)
  })

  it('tells a long-running command by its words', () => {
    expect(looksLongRunningCommand('npm run dev')).toBe(true)
    expect(looksLongRunningCommand('temporal server start-dev')).toBe(true)
    expect(looksLongRunningCommand('docker compose up kafka postgres')).toBe(true)
    expect(looksLongRunningCommand('uv run python -m jupiter_core')).toBe(false)
    expect(looksLongRunningCommand('npm run build')).toBe(false)
  })

  it('names a command briefly', () => {
    expect(nameForCommand('npm run dev')).toBe('dev')
    expect(nameForCommand('docker compose up kafka postgres')).toBe('kafka postgres')
    expect(nameForCommand('temporal server start-dev')).toBe('temporal server')
  })
})

describe('addUsage and the cap', () => {
  it('counts repeats and stamps the last run', () => {
    let entries: UsageEntry[] = []
    entries = addUsage(entries, 'npm run dev', NOW - DAY)
    entries = addUsage(entries, 'npm  run   dev', NOW)
    expect(entries).toEqual([{ command: 'npm run dev', count: 2, lastUsedAt: iso(NOW) }])
  })

  it(`keeps at most ${MAX_USAGE_ENTRIES}, dropping the lowest-ranked and never the one just run`, () => {
    let entries: UsageEntry[] = []
    for (let i = 0; i < MAX_USAGE_ENTRIES; i += 1) entries.push({ command: `cmd ${i}`, count: i === 0 ? 1 : 5, lastUsedAt: iso(NOW - (i === 0 ? 90 * DAY : DAY)) })
    entries = addUsage(entries, 'brand new', NOW)
    expect(entries).toHaveLength(MAX_USAGE_ENTRIES)
    expect(entries.map((entry) => entry.command)).toContain('brand new')
    expect(entries.map((entry) => entry.command)).not.toContain('cmd 0')
  })

  it('ranks by count × recency', () => {
    expect(usageScore(6, iso(NOW), NOW)).toBeGreaterThan(usageScore(6, iso(NOW - 30 * DAY), NOW))
    expect(usageScore(2, iso(NOW), NOW)).toBeGreaterThan(usageScore(1, iso(NOW), NOW))
    expect(usageScore(4, iso(NOW - 14 * DAY), NOW)).toBeCloseTo(2)
  })

  it('reads stored entries defensively', () => {
    expect(parseUsageEntries('junk')).toEqual([])
    expect(parseUsageEntries([{ command: 'a', count: 2, lastUsedAt: iso(NOW) }, { command: 1 }, null, { command: 'a', count: 9 }])).toEqual([
      { command: 'a', count: 2, lastUsedAt: iso(NOW) },
    ])
  })
})

describe('CommandUsageStore — the one writer', () => {
  function harness() {
    const rows = new Map<string, unknown>()
    const writes: string[] = []
    let timer: (() => void) | null = null
    const store = new CommandUsageStore({
      settings: {
        getRunUsage: (root) => rows.get(root) ?? null,
        setRunUsage: (root, entries) => {
          writes.push(root)
          rows.set(root, entries)
        },
      },
      now: () => NOW,
      setTimer: (fn) => {
        timer = fn
        return 1
      },
      clearTimer: () => {
        timer = null
      },
    })
    return { store, rows, writes, fire: () => timer?.() }
  }

  it('keeps one-shots out, and writes once after a quiet moment, not per record', () => {
    const h = harness()
    h.store.record('/p', 'git status')
    h.store.record('/p', 'npm run dev')
    h.store.record('/p', 'npm run dev')
    expect(h.writes).toEqual([])
    h.fire()
    expect(h.writes).toEqual(['/p'])
    expect(h.rows.get('/p')).toEqual([{ command: 'npm run dev', count: 2, lastUsedAt: iso(NOW) }])
    expect(h.store.entries('/p')).toHaveLength(1)
  })

  it('flush writes what is pending (quit)', () => {
    const h = harness()
    h.store.record('/a', 'make dev')
    h.store.flush()
    expect(h.writes).toEqual(['/a'])
    h.store.flush()
    expect(h.writes).toEqual(['/a'])
  })
})

describe('usageSuggestions and the merge', () => {
  const project = { root: '/app', name: 'jupiter-app' }

  it('keeps long-running commands, and anything run 3+ times that is not a one-shot', () => {
    const found = usageSuggestions(
      project,
      [
        { command: 'npm run dev', count: 1, lastUsedAt: iso(NOW) },
        { command: 'uv run python -m jupiter_core', count: 3, lastUsedAt: iso(NOW) },
        { command: 'uv run python -m once', count: 2, lastUsedAt: iso(NOW) },
        { command: 'npm run build', count: 9, lastUsedAt: iso(NOW) },
      ],
      [],
      NOW,
    )
    expect(found.map((suggestion) => suggestion.command)).toEqual(['uv run python -m jupiter_core', 'npm run dev'])
    expect(found[0]).toMatchObject({ source: 'you ran it 3 times', kind: 'usage', projectName: 'jupiter-app' })
    expect(found[1]?.source).toBe('you ran it once')
  })

  it('offers what the agent started in the background, labelled plainly', () => {
    const found = usageSuggestions(project, [], [
      { command: 'temporal server start-dev', startedAt: iso(NOW) },
      { command: 'temporal server start-dev', startedAt: iso(NOW - DAY) },
      { command: 'git log', startedAt: iso(NOW) },
    ], NOW)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ command: 'temporal server start-dev', source: 'the agent started it' })
  })

  it('a command both ran keeps the person’s label and the higher rank', () => {
    const found = usageSuggestions(
      project,
      [{ command: 'npm run dev', count: 1, lastUsedAt: iso(NOW) }],
      [{ command: 'npm run dev', startedAt: iso(NOW) }],
      NOW,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.source).toBe('you ran it once')
    expect(found[0]?.score).toBeCloseTo(2)
  })

  it('names no path or setting in a label (forbidden-pattern #12)', () => {
    const labels = usageSuggestions(project, [{ command: 'npm run dev', count: 6, lastUsedAt: iso(NOW) }], [{ command: 'make serve', startedAt: iso(NOW) }], NOW).map(
      (suggestion) => suggestion.source,
    )
    for (const label of labels) expect(label).not.toMatch(/\/|run_usage|_|`/)
  })
})

describe('isRecordableCommand — only runner lines, never secrets', () => {
  it('keeps a runner line, with leading env assignments', () => {
    expect(isRecordableCommand('npm run dev')).toBe(true)
    expect(isRecordableCommand('PORT=4000 uv run python -m api')).toBe(true)
    expect(isRecordableCommand('temporal server start-dev')).toBe(true)
  })
  it('never keeps what could be typed at a password prompt or an arbitrary program', () => {
    expect(isRecordableCommand('hunter2')).toBe(false)
    expect(isRecordableCommand('correct horse battery staple')).toBe(false)
    expect(isRecordableCommand('vim notes.md')).toBe(false)
  })
  it('never keeps a line that looks like it carries a credential', () => {
    expect(isRecordableCommand('API_KEY=abc npm run dev')).toBe(false)
    expect(isRecordableCommand('GITHUB_TOKEN=x node server.js')).toBe(false)
    expect(isRecordableCommand('docker login --password s3cret')).toBe(false)
    expect(isRecordableCommand('node seed.js postgres://me:pw@localhost/db')).toBe(false)
  })
})

describe('rankSuggestions — the way to run each project first', () => {
  const s = (projectRoot: string, name: string, command: string, source: string): RunSuggestion => ({
    projectRoot, projectName: projectRoot.slice(1), name, command, source,
  })
  it('puts each project’s run command first, the main project first, extras last', () => {
    const files = [
      s('/app', 'storybook', 'npm run storybook', 'package.json'),
      s('/app', 'codegen:watch', 'npm run codegen:watch', 'package.json'),
      s('/app', 'dev', 'npm run dev', 'package.json'),
      s('/core', 'postgres', 'docker compose up postgres', 'Docker Compose'),
      s('/core', 'api', 'uv run python -m jupiter_core', 'README'),
      s('/desk', 'preview', 'npm run preview', 'package.json'),
      s('/desk', 'dev', 'npm run dev', 'package.json'),
    ]
    const ranked = rankSuggestions(files, [], ['/app', '/core', '/desk'])
    expect(ranked.slice(0, 3).map((x) => `${x.projectRoot} ${x.command}`)).toEqual([
      '/app npm run dev',
      '/core uv run python -m jupiter_core',
      '/desk npm run dev',
    ])
    expect(ranked[ranked.length - 1]!.name).toMatch(/storybook|preview/)
  })
  it('what the person ran lifts a declared command and says so', () => {
    const files = [s('/app', 'dev', 'npm run dev', 'package.json'), s('/app', 'start', 'npm start', 'package.json')]
    const usage = [{ ...s('/app', 'start', 'npm start', 'you ran it 6 times'), kind: 'usage' as const, score: 6 }]
    const ranked = rankSuggestions(files, usage, ['/app'])
    expect(ranked[0]!.command).toBe('npm start')
    expect(ranked[0]!.source).toBe('package.json · you ran it 6 times')
  })
})

describe('usageSuggestions — agent background noise is left out', () => {
  it('drops waits and test runs the agent started', () => {
    const out = usageSuggestions(
      { root: '/app', name: 'app' },
      [],
      [
        { command: 'sleep 240; echo done', startedAt: '2026-11-14T10:00:00Z' },
        { command: '.venv/bin/pytest tests/services', startedAt: '2026-11-14T10:00:00Z' },
        { command: 'npm run dev', startedAt: '2026-11-14T10:00:00Z' },
      ],
      Date.parse('2026-11-14T12:00:00Z'),
    )
    expect(out.map((x) => x.command)).toEqual(['npm run dev'])
  })
})

describe('one-time actions — the one-shot jobs a person typed', () => {
  const NOW_MS = Date.parse('2026-11-14T12:00:00Z')
  const at = (hoursAgo: number): string => new Date(NOW_MS - hoursAgo * 3_600_000).toISOString()

  it('records one-shot runner jobs now, but never housekeeping, a bare runner or a secret', () => {
    for (const line of ['npm run build', 'uv run alembic upgrade head', 'npx prisma migrate dev', 'pytest tests/api', 'npm test'])
      expect([line, isRecordableCommand(line)]).toEqual([line, true])
    for (const line of ['npm install', 'npm i lodash', 'pnpm add zod', 'uv add httpx', 'npm --version', 'node', 'python', 'npm login', 'git status', 'DB_PASSWORD=x alembic upgrade head'])
      expect([line, isRecordableCommand(line)]).toEqual([line, false])
  })

  it('offers typed one-shots for a one-time action, marked once — and keeps them out of a running step’s list', () => {
    const typed: UsageEntry[] = [
      { command: 'uv run alembic upgrade head', count: 4, lastUsedAt: at(1) },
      { command: 'npm run codegen', count: 1, lastUsedAt: at(2) },
      { command: 'npm run dev', count: 9, lastUsedAt: at(1) },
      { command: 'npm run build', count: 5, lastUsedAt: at(1) },
    ]
    const once = onceUsageSuggestions({ root: '/core', name: 'jupiter-core' }, typed, NOW_MS)
    expect(once.map((x) => x.command)).toEqual(['npm run build', 'uv run alembic upgrade head', 'npm run codegen'])
    expect(once.every((x) => x.use === 'once' && x.projectName === 'jupiter-core')).toBe(true)
    expect(once[1]!.source).toBe('you ran it 4 times')
    const running = usageSuggestions({ root: '/core', name: 'jupiter-core' }, typed, [], NOW_MS)
    expect(running.map((x) => x.command)).toEqual(['npm run dev'])
    expect(running.every((x) => x.use === undefined)).toBe(true)
  })

  it('ranks migrations first, lifts what the person ran, and keeps project order', () => {
    const file = (projectRoot: string, name: string, command: string, source: string): RunSuggestion => ({
      projectRoot, projectName: projectRoot.slice(1), name, command, source, use: 'once',
    })
    const files = [
      file('/app', 'test', 'npm test', 'package.json'),
      file('/app', 'codegen', 'npm run codegen', 'package.json'),
      file('/core', 'migrate', 'uv run alembic upgrade head', 'Alembic'),
      file('/app', 'db:migrate', 'npm run db:migrate', 'package.json'),
    ]
    const usage = [{ ...file('/app', 'codegen', 'npm run codegen', 'you ran it 5 times'), kind: 'usage' as const, score: 5 }]
    const ranked = rankOnceSuggestions(files, usage, ['/app', '/core'])
    expect(ranked.map((x) => `${x.projectRoot} ${x.command}`)).toEqual([
      '/app npm run codegen',
      '/app npm run db:migrate',
      '/app npm test',
      '/core uv run alembic upgrade head',
    ])
    expect(ranked[0]!.source).toBe('package.json · you ran it 5 times')
    expect(ranked.every((x) => x.use === 'once')).toBe(true)
  })
})
