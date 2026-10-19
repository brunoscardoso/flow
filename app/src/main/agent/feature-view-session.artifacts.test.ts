/**
 * BOTH ARTIFACTS, ON DISK, THROUGH THE REAL STORE WRITERS.
 *
 * The unit suite proves `runFeatureViewPass` ATTEMPTS both writes and reports
 * which landed, with the CLI mocked. That is not the same claim as "the files
 * exist afterwards": the two writes go through different CLI verbs, each with
 * its own validator and its own refusals, and a mock cannot refuse the way the
 * real ones do. This spawns the built `planflow-ai` against a temp repo and
 * then LOOKS at the disk.
 *
 * The model session is canned — no model time is spent here. The point is the
 * write path, not the reading.
 *
 * SKIPPED when the CLI has not been built (`npm run build` at the repo root).
 * A skipped check says "not measured"; a check that quietly passed without the
 * CLI would say something false.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runFeatureViewPass } from './feature-view-session'

const CLI_PATH = resolve(__dirname, '../../../../dist/cli/index.js')
const suite = existsSync(CLI_PATH) ? describe : describe.skip

suite('runFeatureViewPass — both artifacts reach the disk', () => {
  let root = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fv-artifacts-'))
    mkdirSync(join(root, 'src', 'ingest'), { recursive: true })
    writeFileSync(join(root, 'src', 'ingest', 'reader.ts'), 'export const read = (): number => 1\n')
    const features = join(root, 'flow', 'brain', 'features')
    mkdirSync(features, { recursive: true })
    writeFileSync(
      join(features, 'ingest-pipeline.md'),
      [
        '---',
        'id: feature:ingest-pipeline',
        'name: Ingest Pipeline',
        'kind: core',
        'anchors: [module:src/ingest]',
        'relates: []',
        'lastFullRead: null',
        'patchCount: 0',
        '---',
        '',
        '# Ingest Pipeline',
        '',
        'Seeded with NO ## Learned section, so anything found there was written here.',
      ].join('\n'),
    )
  })

  afterAll(() => {
    if (root.length > 0) rmSync(root, { recursive: true, force: true })
  })

  it('writes the curated view AND the learnings from ONE session', async () => {
    let sessions = 0
    const result = await runFeatureViewPass(
      {
        rootPath: root,
        featureRef: 'ingest-pipeline',
        featureName: 'Ingest Pipeline',
        files: [{ path: 'src/ingest/reader.ts', size: 40 }],
        // process.execPath is the jest node binary; the runner passes
        // ELECTRON_RUN_AS_NODE, which plain node ignores.
        bundledCli: { execPath: process.execPath, cliPath: CLI_PATH },
        now: () => new Date('2026-08-09T10:00:00.000Z'),
      },
      {
        runSession: () => {
          sessions += 1
          return Promise.resolve(
            JSON.stringify({
              meta: { title: 'Ingest Pipeline' },
              brief: {},
              learnings: [
                'Rows are committed once per poll batch, not once per row.',
                'A reader failure leaves the batch offset unmoved, so it replays.',
              ],
              views: {
                root: {
                  title: 'Ingest Pipeline',
                  summary: 'Reads rows and writes them.',
                  nodes: [
                    { id: 'reader', kind: 'module', title: 'Ingest Reader', delta: 'stable' },
                    { id: 'writer', kind: 'module', title: 'Ingest Writer', delta: 'stable' },
                  ],
                  edges: [{ from: 'reader', to: 'writer', label: 'parsed rows', delta: 'kept' }],
                },
              },
            }),
          )
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.learnings).toBe(2)
    // ONE read produced both. Two sessions over the same ranked files was the
    // waste the Learn/Draw collapse removed.
    expect(sessions).toBe(1)

    // HALF ONE, on disk.
    const viewPath = join(
      root,
      'flow',
      'brain',
      '.structure',
      'feature-views',
      'ingest-pipeline.json',
    )
    expect(existsSync(viewPath)).toBe(true)
    const stored = JSON.parse(readFileSync(viewPath, 'utf-8')) as Record<string, unknown>
    expect(stored.feature).toBe('ingest-pipeline')
    // The prose never rides along inside the picture.
    expect(stored.learnings).toBeUndefined()

    // HALF TWO, on disk, in the feature's own markdown.
    const body = readFileSync(
      join(root, 'flow', 'brain', 'features', 'ingest-pipeline.md'),
      'utf-8',
    )
    expect(body).toContain('## Learned')
    expect(body).toContain('Rows are committed once per poll batch')
    expect(body).toContain('A reader failure leaves the batch offset unmoved')

    // AND THE BOARD AGREES. The graph is what the board renders; a feature with
    // both artifacts must report `learned` rather than looking unexamined.
    const out = execFileSync(
      process.execPath,
      [CLI_PATH, 'blueprint', 'features', 'graph', '--json'],
      { cwd: root, encoding: 'utf-8' },
    )
    const graph = JSON.parse(out) as {
      nodes: Array<{ slug: string; understanding: string }>
      limitations: { views: { validSlugs: string[] }; content: { withLearned: number } }
    }
    expect(graph.nodes.find((n) => n.slug === 'ingest-pipeline')?.understanding).toBe('learned')
    expect(graph.limitations.views.validSlugs).toEqual(['ingest-pipeline'])
    expect(graph.limitations.content.withLearned).toBe(1)
  }, 60_000)

  /**
   * THE RE-RUN, which the curated level now offers ("Understand it again").
   *
   * Overwriting is the point — a drawing that cites lines the file no longer
   * has is worse than no drawing (#1435) — but the control promises the
   * previous one survives, and a promise the writer does not keep is worse than
   * no promise. `writeFeatureView` renames the old artifact to `.prev.json`
   * before writing; this is that claim, measured rather than read.
   */
  it('a second pass REPLACES the drawing and rotates the old one to .prev.json', async () => {
    const viewDir = join(root, 'flow', 'brain', '.structure', 'feature-views')
    const current = join(viewDir, 'ingest-pipeline.json')
    const rotated = join(viewDir, 'ingest-pipeline.prev.json')
    // The first pass ran in the test above; nothing has been rotated yet.
    expect(existsSync(current)).toBe(true)
    expect(existsSync(rotated)).toBe(false)
    const before = JSON.parse(readFileSync(current, 'utf-8')) as { generatedAt: string }

    const result = await runFeatureViewPass(
      {
        rootPath: root,
        featureRef: 'ingest-pipeline',
        featureName: 'Ingest Pipeline',
        files: [{ path: 'src/ingest/reader.ts', size: 40 }],
        bundledCli: { execPath: process.execPath, cliPath: CLI_PATH },
        now: () => new Date('2026-08-11T10:00:00.000Z'),
      },
      {
        runSession: () =>
          Promise.resolve(
            JSON.stringify({
              meta: { title: 'Ingest Pipeline' },
              brief: {},
              learnings: ['The batch offset moves only after the writer acknowledges.'],
              views: {
                root: {
                  title: 'Ingest Pipeline',
                  summary: 'Redrawn after the code moved.',
                  nodes: [
                    { id: 'reader', kind: 'module', title: 'Ingest Reader', delta: 'stable' },
                    { id: 'batcher', kind: 'module', title: 'Batch Committer', delta: 'new' },
                  ],
                  edges: [{ from: 'reader', to: 'batcher', label: 'rows', delta: 'kept' }],
                },
              },
            }),
          ),
      },
    )
    expect(result.ok).toBe(true)

    // REPLACED.
    const after = JSON.parse(readFileSync(current, 'utf-8')) as {
      generatedAt: string
      views: { root: { nodes: Array<{ id: string }> } }
    }
    expect(after.generatedAt).toBe('2026-08-11')
    expect(after.views.root.nodes.map((n) => n.id)).toEqual(['reader', 'batcher'])

    // AND THE OLD ONE IS STILL THERE, exactly as the control promised.
    expect(existsSync(rotated)).toBe(true)
    const kept = JSON.parse(readFileSync(rotated, 'utf-8')) as {
      generatedAt: string
      views: { root: { nodes: Array<{ id: string }> } }
    }
    expect(kept.generatedAt).toBe(before.generatedAt)
    expect(kept.views.root.nodes.map((n) => n.id)).toEqual(['reader', 'writer'])
  }, 60_000)
})
