import { LearnOrchestrator } from './learn-orchestrator'
import { makeLearningStateFake } from './learning-state-fake'

/**
 * A pass that never ends is a queue that never moves.
 *
 * Reported live: ten minutes on one 20 KB HTML file, 350 modules waiting behind
 * it, and the panel honestly reporting "Learning flow/resources" throughout. A
 * learn pass is an agent session — it can stall on a model, a tool, a network
 * hiccup — and nothing bounded it.
 */
describe('a learn pass has a deadline', () => {
  it('stops a stalled pass, marks the module stale, and moves on', async () => {
    const store = makeLearningStateFake()
    const transitions = store.transitions
    const toasts: string[] = []
    let sawAbort = false

    const orchestrator = new LearnOrchestrator({
      bundledCli: { execPath: '/bin/true', cliPath: 'cli.js' },
      isRootReady: () => true,
      structureDirFor: (rootPath: string) => `${rootPath}/.structure`,
      mutateLearning: store.mutate,
      readProjectState: async () => ({ investigations: [] }),
      enumerateModuleEntries: async () => ({ files: [{ path: 'a.ts', bytes: 10 }], claimFiles: [] }),
      notify: (notification: { body?: string; title?: string }) =>
        toasts.push(notification.body ?? notification.title ?? ''),
      // A pass that never resolves on its own — it only ends when aborted.
      runPass: ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((resolve) => {
          abortSignal.addEventListener('abort', () => {
            sawAbort = true
            resolve({ ok: false, reason: 'aborted' })
          })
        }),
      runCli: async () => ({ ok: true, stdout: '' }),
      passTimeoutMs: 30,
    } as never)

    orchestrator.enqueueModule('/repo', 'src', { reason: 'manual', deliberate: true })
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(sawAbort).toBe(true)
    // Stale, not silently abandoned: the next attempt can pick it up.
    expect(transitions.map((t) => t.status)).toContain('stale')
    expect(toasts.join(' ')).toMatch(/took too long/i)
    // …and the queue is free again.
    expect(orchestrator.status().running).toBe(false)
  })
})
