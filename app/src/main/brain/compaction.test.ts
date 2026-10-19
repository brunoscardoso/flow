// Compaction / promotion tests (#52, Phase 3) — pure compaction + the real
// filesystem pass + the tier boundary that keeps .raw/ out of queries.

import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import {
  compact,
  isWorkingSetMarkdown,
  renderFeatureMemory,
  runCompaction,
  slugify,
  type CompactionDeps,
} from './compaction'
import { isTrustedBrainPath } from './store'
import type { RawWorkingSet } from './types'

function raw(partial: Partial<RawWorkingSet>): RawWorkingSet {
  return {
    threadId: 't1',
    title: 'Add feature X',
    files: [{ path: 'src/a.ts', role: 'edited' }],
    capturedAt: '2026-07-13T00:00:00.000Z',
    ...partial,
  }
}

describe('slugify', () => {
  it('kebab-cases titles and preserves ticket codes', () => {
    expect(slugify('Add feature X')).toBe('add-feature-x')
    expect(slugify('ACME-2109: fix the thing')).toBe('acme-2109-fix-the-thing')
  })

  it('keeps non-Latin scripts as distinct, meaningful stems (#168)', () => {
    // CJK and Cyrillic titles survive (not collapsed to `untitled`)…
    expect(slugify('認証を追加')).toBe('認証を追加')
    expect(slugify('Добавить вход')).toBe('добавить-вход')
    // …and two different non-Latin titles yield different slugs.
    expect(slugify('認証を追加')).not.toBe(slugify('ログイン'))
  })

  it('falls back to a stable per-title hash for symbol/emoji-only titles (#168)', () => {
    expect(slugify('!!!')).toMatch(/^untitled-[0-9a-f]{8}$/)
    expect(slugify('🎉🚀')).toMatch(/^untitled-[0-9a-f]{8}$/)
    // Deterministic, and distinct titles don't collapse into one bucket.
    expect(slugify('!!!')).toBe(slugify('!!!'))
    expect(slugify('!!!')).not.toBe(slugify('🎉🚀'))
  })
})

describe('compact', () => {
  it('groups by feature, merges files (edited wins), drops noise', () => {
    const memories = compact([
      raw({ files: [{ path: 'src/a.ts', role: 'read' }] }),
      raw({
        files: [
          { path: 'src/a.ts', role: 'edited' },
          { path: 'node_modules/x/index.js', role: 'read' },
          { path: 'package-lock.json', role: 'edited' },
          { path: 'src/b.ts', role: 'read' },
        ],
      }),
    ])
    expect(memories).toHaveLength(1)
    expect(memories[0].feature).toBe('add-feature-x')
    expect(memories[0].files).toEqual([
      { path: 'src/a.ts', role: 'edited' },
      { path: 'src/b.ts', role: 'read' },
    ])
  })

  it('drops a record that reduces to zero meaningful files', () => {
    expect(compact([raw({ files: [{ path: 'dist/bundle.js', role: 'edited' }] })])).toEqual([])
  })

  it('separates distinct features', () => {
    const memories = compact([raw({ title: 'Feature A' }), raw({ title: 'Feature B' })])
    expect(memories.map((m) => m.feature)).toEqual(['feature-a', 'feature-b'])
  })
})

describe('renderFeatureMemory', () => {
  it('renders frontmatter + working set list', () => {
    const md = renderFeatureMemory(compact([raw({})])[0])
    expect(md).toContain('feature: add-feature-x')
    expect(md).toContain('# Add feature X')
    expect(md).toContain('- `src/a.ts` — edited')
  })
})

describe('runCompaction (real fs)', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('promotes raw records to features/*.md and consumes the raw files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-compact-'))
    const rawDir = join(dir, 'flow/brain/.raw')
    mkdirSync(rawDir, { recursive: true })
    writeFileSync(join(rawDir, 't1.json'), JSON.stringify(raw({})))

    const result = await runCompaction(dir)

    expect(result).toEqual({ promoted: 1, features: ['add-feature-x'] })
    expect(existsSync(join(dir, 'flow/brain/features/add-feature-x.md'))).toBe(true)
    expect(existsSync(join(rawDir, 't1.json'))).toBe(false) // consumed
    expect(readFileSync(join(dir, 'flow/brain/features/add-feature-x.md'), 'utf8')).toContain(
      '`src/a.ts` — edited',
    )
  })

  it('is a no-op when there are no raw records', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-compact-'))
    expect(await runCompaction(dir)).toEqual({ promoted: 0, features: [] })
  })

  it('MERGES a later session into the same feature — prior files survive (#167)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-compact-'))
    const rawDir = join(dir, 'flow/brain/.raw')
    mkdirSync(rawDir, { recursive: true })
    // Session 1: promotes src/a.ts, then its raw file is removed.
    writeFileSync(join(rawDir, 't1.json'), JSON.stringify(raw({})))
    await runCompaction(dir)
    // Session 2: a disjoint working set for the same feature slug.
    writeFileSync(
      join(rawDir, 't2.json'),
      JSON.stringify(raw({ threadId: 't2', files: [{ path: 'src/z.ts', role: 'read' }] })),
    )
    const second = await runCompaction(dir)

    expect(second.promoted).toBe(1)
    const md = readFileSync(join(dir, 'flow/brain/features/add-feature-x.md'), 'utf8')
    expect(md).toContain('src/z.ts') // the new session's file
    expect(md).toContain('src/a.ts') // the FIRST session's file is NOT lost
    // No duplicate rows when re-promoting the same file with a stronger role.
    expect((md.match(/`src\/a\.ts`/g) ?? []).length).toBe(1)
  })

  it('NEVER overwrites a real feature file on slug collision — diverts the working set (#1681)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-compact-'))
    const rawDir = join(dir, 'flow/brain/.raw')
    const featuresDir = join(dir, 'flow/brain/features')
    mkdirSync(rawDir, { recursive: true })
    mkdirSync(featuresDir, { recursive: true })
    // A REAL feature (no working-set marker) whose name a thread title collides with.
    const realFeature = [
      '---',
      'status: active',
      'created: 2026-08-14',
      '---',
      '',
      '# [[add-feature-x]]',
      '',
      '## Links',
      '',
      '- Plan: [[plan_add_feature_x_v1]]',
      '',
      '## Timeline',
      '',
      '### 2026-08-14 - plan',
      '',
    ].join('\n')
    writeFileSync(join(featuresDir, 'add-feature-x.md'), realFeature)
    writeFileSync(join(rawDir, 't1.json'), JSON.stringify(raw({})))

    const result = await runCompaction(dir)

    // The precious file is byte-identical.
    expect(readFileSync(join(featuresDir, 'add-feature-x.md'), 'utf8')).toBe(realFeature)
    // The working set landed on a diverted, thread-namespaced sibling…
    expect(result.promoted).toBe(1)
    const diverted = readdirSync(featuresDir).filter((n) => /^add-feature-x--ws-/.test(n))
    expect(diverted).toHaveLength(1)
    const divertedMd = readFileSync(join(featuresDir, diverted[0]), 'utf8')
    expect(divertedMd).toContain('`src/a.ts` — edited')
    // …still marked as a working set, so the feature store keeps excluding it.
    expect(isWorkingSetMarkdown(divertedMd)).toBe(true)
    expect(existsSync(join(rawDir, 't1.json'))).toBe(false) // consumed

    // A later session for the same thread MERGES into the diverted file (#167).
    writeFileSync(
      join(rawDir, 't2.json'),
      JSON.stringify(raw({ files: [{ path: 'src/z.ts', role: 'read' }] })),
    )
    await runCompaction(dir)
    expect(readFileSync(join(featuresDir, 'add-feature-x.md'), 'utf8')).toBe(realFeature)
    const merged = readFileSync(join(featuresDir, diverted[0]), 'utf8')
    expect(merged).toContain('src/a.ts')
    expect(merged).toContain('src/z.ts')
  })
})

describe('isWorkingSetMarkdown (#1681)', () => {
  it('detects both working-set markers, either sufficient', () => {
    // renderFeatureMemory's own output carries both markers.
    expect(
      isWorkingSetMarkdown(
        renderFeatureMemory(compact([raw({})])[0]),
      ),
    ).toBe(true)
    expect(isWorkingSetMarkdown('---\nthread_id: t1\n---\n\n# X\n')).toBe(true)
    expect(isWorkingSetMarkdown('# X\n\nWorking set for "X" — 1 file(s).\n')).toBe(true)
    // CRLF files still match the frontmatter fence.
    expect(isWorkingSetMarkdown('---\r\nthread_id: t1\r\n---\r\n\r\n# X\r\n')).toBe(true)
  })

  it('does not mistake real features for working sets', () => {
    expect(
      isWorkingSetMarkdown('---\nstatus: active\n---\n\n# [[f]]\n\n## Links\n\n## Timeline\n'),
    ).toBe(false)
    // A frontmatter title MENTIONING the phrase is not a body marker.
    expect(isWorkingSetMarkdown('---\ntitle: "Working set for x"\n---\n\n# F\n')).toBe(false)
  })
})

describe('runCompaction concurrency (#267)', () => {
  it('serializes overlapping compactions on the same root — no lost working set', async () => {
    // A REAL directory even though every dep below is a fake: the feature-store
    // critical section takes an on-disk advisory lock, and a lock file cannot
    // live under an imaginary root.
    const root = mkdtempSync(join(tmpdir(), 'brain-compact-lock-'))
    const rawStore = new Map<string, string>([
      ['a.json', JSON.stringify(raw({ threadId: 'a', files: [{ path: 'src/a.ts', role: 'edited' }] }))],
      ['b.json', JSON.stringify(raw({ threadId: 'b', files: [{ path: 'src/b.ts', role: 'edited' }] }))],
    ])
    const featureStore = new Map<string, string>()
    const log: string[] = []
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    // Two labelled deps sharing one backing store, each yielding at every await
    // so an unserialized pair WOULD interleave destructively.
    const makeDeps = (tag: string): CompactionDeps => ({
      listRaw: async () => {
        log.push(`${tag}:list`)
        await tick()
        return [...rawStore.keys()]
      },
      readRaw: async (path) => {
        await tick()
        return rawStore.get(basename(path)) ?? ''
      },
      readFeature: async (path) => {
        log.push(`${tag}:readFeat`)
        await tick()
        return featureStore.get(path) ?? null
      },
      writeFeature: async (path, content) => {
        log.push(`${tag}:write`)
        await tick()
        featureStore.set(path, content)
      },
      removeRaw: async (path) => {
        rawStore.delete(basename(path))
      },
    })

    await Promise.all([runCompaction(root, makeDeps('A')), runCompaction(root, makeDeps('B'))])

    // Serialized: one pass' ops fully precede the other's — never interleaved.
    const firstTag = log[0]?.[0]
    const boundary = log.findIndex((entry) => entry[0] !== firstTag)
    expect(boundary).toBeGreaterThan(0)
    expect(log.slice(boundary).every((entry) => entry[0] !== firstTag)).toBe(true)

    // Both threads' working sets are promoted and every raw file is consumed.
    const featureMd = [...featureStore.values()].join('\n')
    expect(featureMd).toContain('src/a.ts')
    expect(featureMd).toContain('src/b.ts')
    expect(rawStore.size).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('tier boundary (isTrustedBrainPath) — .raw/ is never trusted', () => {
  it('trusts features/errors/decisions/structure but not .raw', () => {
    expect(isTrustedBrainPath('flow/brain/features/x.md')).toBe(true)
    expect(isTrustedBrainPath('flow/brain/errors/y.md')).toBe(true)
    expect(isTrustedBrainPath('flow/brain/decisions/z.md')).toBe(true)
    expect(isTrustedBrainPath('flow/brain/.structure/graph.json')).toBe(true)
    expect(isTrustedBrainPath('flow/brain/.raw/t1.json')).toBe(false)
    expect(isTrustedBrainPath('src/a.ts')).toBe(false)
  })
})

// The chain above serializes THIS process. The CLI is the writer it cannot
// see, and a lock file is the only thing both can observe — so what a
// single-process test can prove is that the section is genuinely held while
// the read-merge-write runs.
describe('runCompaction feature-store lock', () => {
  it('holds the shared lock file across the read-merge-write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brain-compact-lockfile-'))
    const lockPath = join(root, 'flow/brain/.structure/features.lock')
    const heldDuring: boolean[] = []
    const deps: CompactionDeps = {
      listRaw: async () => ['a.json'],
      readRaw: async () => JSON.stringify(raw({ threadId: 'a', files: [{ path: 'src/a.ts', role: 'edited' }] })),
      readFeature: async () => {
        heldDuring.push(existsSync(lockPath))
        return null
      },
      writeFeature: async () => {
        heldDuring.push(existsSync(lockPath))
      },
      removeRaw: async () => undefined,
    }

    await runCompaction(root, deps)

    expect(heldDuring).toEqual([true, true])
    // …and released afterwards, so the next writer is not wedged.
    expect(existsSync(lockPath)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

