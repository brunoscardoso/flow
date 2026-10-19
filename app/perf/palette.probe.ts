/**
 * What ⌘P costs per keystroke, in the renderer.
 *
 * The palette re-scores every path in the project on every character typed. On
 * a 4,182-file repo that is 5,675 paths; on this one it is fewer but longer.
 * Driven through the UI the whole loop measured ~107ms per character, and the
 * scoring is the part that runs on the thread the caret lives on.
 */
import { fileCandidates } from '../src/renderer/palette/palette-sources'
import { measure, report, writeBaseline, type Measurement } from './harness'

/** Paths, at the shape a real repo has: deep, repetitive, long. */
function syntheticPaths(count: number): string[] {
  const paths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const depth = 2 + (i % 4)
    const dirs = Array.from({ length: depth }, (_, d) => `segment-${String((i + d) % 40)}`)
    paths.push(`${dirs.join('/')}/component-${String(i)}.tsx`)
  }
  return paths
}

describe('the command palette, per keystroke', () => {
  const measurements: Measurement[] = []
  afterAll(() => {
    report('palette', measurements)
    writeBaseline('palette', measurements)
  })

  it('scores a project-sized list for each character typed', async () => {
    const relPaths = syntheticPaths(5_675)
    const deps = {
      listAllFiles: async () => ({ relPaths, truncated: false }),
      searchThreads: async () => [],
      listCommands: async () => [],
      emit: () => undefined,
    } as never

    for (const term of ['c', 'co', 'comp', 'component-4']) {
      measurements.push(
        await measure(
          `term "${term}"`,
          () => fileCandidates('/repo', term, deps),
          { runs: 5, items: relPaths.length, note: 'one keystroke' },
        ),
      )
    }
    expect(measurements.length).toBe(4)
  })
})
