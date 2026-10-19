/**
 * The learner's machinery, at the size a real project has.
 *
 * A learn run is 365 modules on this repository. The MODEL half is inherently
 * slow and runs out of process; what has never been measured is everything
 * around it — the queue, the per-module state transitions (a full rewrite of
 * learning-state.jsonl each, serialized), the roster reads, the events. That is
 * main-process work, and it happens while somebody is trying to use the app.
 *
 * The pass itself is stubbed to resolve immediately, so what this times is the
 * machinery and nothing else.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LearnOrchestrator } from '../src/main/workspace/learn-orchestrator'
import { report, writeBaseline, type Measurement } from './harness'

/** What a real onboarding sweep of this repository enqueues. */
const MODULES = 365

describe('a learn run, without the model', () => {
  const measurements: Measurement[] = []
  afterAll(() => {
    report('learn machinery', measurements)
    writeBaseline('learn machinery', measurements)
  })

  it('drains 365 modules and reports what the machinery cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-perf-learn-'))
    const structureDir = join(dir, 'flow', 'brain', '.structure')
    let passes = 0
    const orchestrator = new LearnOrchestrator({
      bundledCli: { execPath: '/bin/true', cliPath: 'cli.js' },
      isRootReady: () => true,
      structureDirFor: () => structureDir,
      readWorkspaceState: async () => ({ investigations: [] }),
      enumerateModuleEntries: async () => ({
        files: [{ path: 'a.ts', bytes: 4_000 }],
        claimFiles: [],
      }),
      notify: () => undefined,
      runPass: async () => {
        passes += 1
        return { ok: true }
      },
      runCli: async () => ({ ok: true, stdout: '' }),
      // A session's automatic budget is ten; an onboarding sweep is deliberate
      // work and exempt. Raised here so what gets measured is the machinery
      // draining a real project's worth of modules, not the budget cutting it
      // off after ten (which is what a first attempt at this probe measured).
      budget: MODULES,
    } as never)

    const cpuBefore = process.cpuUsage()
    const started = performance.now()
    for (let i = 0; i < MODULES; i += 1) {
      orchestrator.enqueueModule(dir, `src/module-${String(i)}`, {
        reason: 'manual',
        deliberate: false,
      })
    }
    // Drain: the orchestrator runs one pass at a time.
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const status = orchestrator.status() as { queued: number; running: boolean }
      if (status.queued === 0 && !status.running) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const elapsed = performance.now() - started
    const cpu = process.cpuUsage(cpuBefore)

    let stateBytes = 0
    let stateLines = 0
    try {
      const raw = readFileSync(join(structureDir, 'learning-state.jsonl'), 'utf8')
      stateBytes = raw.length
      stateLines = raw.split('\n').filter((line) => line.trim().length > 0).length
    } catch {
      // no state written — the numbers below say so
    }

    measurements.push(
      {
        name: `${String(MODULES)} modules, end to end`,
        ms: Math.round(elapsed),
        items: passes,
        note: 'queue + transitions + events, model stubbed',
      },
      {
        name: 'per module',
        ms: Math.round((elapsed / Math.max(1, passes)) * 100) / 100,
        note: 'what the machinery costs each time, on the main process',
      },
      {
        name: 'CPU spent',
        ms: Math.round((cpu.user + cpu.system) / 1000),
        note: `learning-state.jsonl: ${String(stateLines)} lines, ${String(stateBytes)} bytes`,
      },
    )
    rmSync(dir, { recursive: true, force: true })
    expect(passes).toBeGreaterThan(0)
  })
})
