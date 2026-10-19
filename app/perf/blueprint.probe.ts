/**
 * The board's one read, taken apart.
 *
 * `blueprint:read` was measured at 725–1,110 ms in a live launch — the largest
 * single number in the whole channel map, and it runs on the process every
 * window waits behind. It is not one read: it is ten files, a graph parse, a
 * hash sweep and several store folds, and until now nobody knew which of those
 * was the second.
 *
 * Measured against THIS repo's real structure dir (1.1 MB graph, 126 KB of
 * annotations, 200 KB of tiers) — the fixture is the project itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { enrichCrossLinks } from '../src/main/blueprint/blueprint-observer'
import { measure, report, writeBaseline, type Measurement } from './harness'

const ROOT = resolve(__dirname, '../..')
const STRUCTURE = join(ROOT, 'flow', 'brain', '.structure')

describe('blueprint read, part by part', () => {
  const measurements: Measurement[] = []

  afterAll(() => {
    report('blueprint read', measurements)
    writeBaseline('blueprint read', measurements)
  })

  it('times each file the board read touches', async () => {
    if (!existsSync(STRUCTURE)) {
      console.log('no derived structure dir — run a derive first')
      return
    }
    const graphRaw = readFileSync(join(STRUCTURE, 'graph.json'), 'utf8')
    measurements.push(
      await measure('read graph.json (fs)', () => readFileSync(join(STRUCTURE, 'graph.json'), 'utf8'), {
        note: `${String(Math.round(graphRaw.length / 1024))} KB on disk`,
      }),
      await measure('JSON.parse the graph', () => JSON.parse(graphRaw), { runs: 5 }),
    )
    for (const file of [
      'annotations.jsonl',
      'investigations.jsonl',
      'file-tiers.json',
      'learning-state.jsonl',
      'proposals.jsonl',
      'status-events.jsonl',
    ]) {
      const path = join(STRUCTURE, file)
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      measurements.push(
        await measure(`read ${file}`, () => readFileSync(path, 'utf8'), {
          note: `${String(Math.round(raw.length / 1024))} KB`,
        }),
      )
    }
    expect(measurements.length).toBeGreaterThan(0)
  })

  it('times the federation join, which a CPU profile put on the board read', async () => {
    // `pathBacks` showed up at 139ms of MAIN-process time in a profile, with
    // enrichCrossLinks' own frame at 50ms beside it — every time the board
    // opened. It is links × calls, and both sides were being split per
    // comparison.
    const links = Array.from({ length: 200 }, (_, i) => ({
      provider: 'orbit-core',
      endpoint: `GET /api/v1/resource-${String(i)}/{id}/detail`,
      status: 'proposed' as const,
      confidence: 'high' as const,
      files: [`src/api/client-${String(i)}.ts`],
      surfaceDerivedAt: '2026-08-01T00:00:00.000Z',
    }))
    const outbound = JSON.stringify({
      calls: Array.from({ length: 2_000 }, (_, i) => ({
        base: 'API_BASE',
        baseIsEnv: true,
        path: `/api/v1/resource-${String(i % 200)}/42/detail`,
        file: `src/api/client-${String(i)}.ts`,
      })),
    })
    measurements.push(
      await measure(
        'enrichCrossLinks 200×2000',
        () => enrichCrossLinks([...links.map((link) => ({ ...link }))], outbound, new Map()),
        { runs: 3, note: 'the federation evidence join' },
      ),
    )
    expect(measurements.length).toBeGreaterThan(0)
  })
})
