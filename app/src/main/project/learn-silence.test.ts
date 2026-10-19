import { LearnOrchestrator } from './learn-orchestrator'
import { makeLearningStateFake } from './learning-state-fake'
import { clearLearnLog, readLearnLog } from './learn-log'

/**
 * A pass that says nothing is not working slowly — it is gone.
 *
 * Reported live: "office-addin — reading decisions/…md" at 11:14:55, then
 * silence, with 360 modules queued behind it. Every sign of life now reports
 * (reads, tools, thinking, writing), so silence itself became a signal worth
 * acting on rather than a state to wait out.
 */
describe('the silence watchdog', () => {
  beforeEach(() => clearLearnLog())

  function orchestratorWith(runPass: unknown, onNotify: (body: string) => void): LearnOrchestrator {
    return new LearnOrchestrator({
      bundledCli: { execPath: '/bin/true', cliPath: 'cli.js' },
      isRootReady: () => true,
      structureDirFor: (rootPath: string) => `${rootPath}/.structure`,
      mutateLearning: makeLearningStateFake().mutate,
      readProjectState: async () => ({ investigations: [] }),
      enumerateModuleEntries: async () => ({ files: [{ path: 'a.ts', bytes: 10 }], claimFiles: [] }),
      notify: (notification: { body?: string; title?: string }) =>
        onNotify(notification.body ?? notification.title ?? ''),
      runPass,
      runCli: async () => ({ ok: true, stdout: '' }),
      passTimeoutMs: 5_000,
      passSilenceMs: 40,
    } as never)
  }

  it('stops a pass that goes quiet, long before the hard deadline', async () => {
    const toasts: string[] = []
    let aborted = false
    const orchestrator = orchestratorWith(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((resolve) => {
          abortSignal.addEventListener('abort', () => {
            aborted = true
            resolve({ ok: false, reason: 'aborted' })
          })
        }),
      (body) => toasts.push(body),
    )
    orchestrator.enqueueModule('/repo', 'office-addin', { reason: 'manual', deliberate: true })
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(aborted).toBe(true)
    expect(toasts.join(' ')).toMatch(/went quiet/i)
    expect(orchestrator.status().running).toBe(false)
  })

  it('lets a SLOW pass keep working, as long as it is doing something', async () => {
    const toasts: string[] = []
    const orchestrator = orchestratorWith(
      async ({ onActivity }: { onActivity?: (kind: string, detail?: string) => void }) => {
        // Slower than the watchdog, but audible the whole way.
        for (let i = 0; i < 6; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          onActivity?.('tool', 'Grep')
        }
        return { ok: true }
      },
      (body) => toasts.push(body),
    )
    orchestrator.enqueueModule('/repo', 'src', { reason: 'manual', deliberate: true })
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(toasts.join(' ')).not.toMatch(/went quiet/i)
    // …and the work it did is in the log, which is the point of reporting it.
    expect(readLearnLog().some((entry) => entry.detail?.includes('Grep') === true)).toBe(true)
  })

  describe('a run that only fails stops itself', () => {
      it('pauses after three failures in a row, once, with the queue kept', async () => {
      // Reported live, mid-lag: a wall of "Could not learn <module>: went quiet
      // and was stopped" toasts. Three minutes of silence each, three hundred
      // modules queued — a treadmill that costs the machine everything and
      // produces nothing.
      const toasts: string[] = []
      const orchestrator = orchestratorWith(
        ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise((resolve) => {
            abortSignal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))
          }),
        (body) => toasts.push(body),
      )
      for (const module of ['a', 'b', 'c', 'd']) {
        orchestrator.enqueueModule('/repo', module, { reason: 'manual', deliberate: true })
      }
      await new Promise((resolve) => setTimeout(resolve, 900))
  
      expect(orchestrator.isPaused()).toBe(true)
      const paused = toasts.filter((body) => body.includes('in a row could not be learned'))
      expect(paused).toHaveLength(1)
      // The fourth module is still queued, not thrown away.
      expect(orchestrator.status().queued).toBeGreaterThan(0)
    })
  })
})
