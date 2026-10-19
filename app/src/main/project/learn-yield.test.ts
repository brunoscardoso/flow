import { LearnOrchestrator } from './learn-orchestrator'
import { makeLearningStateFake } from './learning-state-fake'

/**
 * Learning stands aside for the person.
 *
 * A learn run is hundreds of agent sessions. One of them competing with the
 * turn somebody is watching is the difference between "the IDE is thinking"
 * and "the IDE is slow" — which is how this was reported, repeatedly.
 */
describe('yielding to the user’s own turn', () => {
  function makeOrchestrator(started: string[]): LearnOrchestrator {
    return new LearnOrchestrator({
      bundledCli: { execPath: '/bin/true', cliPath: 'cli.js' },
      isRootReady: () => true,
      structureDirFor: (rootPath: string) => `${rootPath}/.structure`,
      mutateLearning: makeLearningStateFake().mutate,
      readProjectState: async () => ({ investigations: [] }),
      enumerateModuleEntries: async (_root: string, modulePath: string) => {
        started.push(modulePath)
        return { files: [{ path: 'a.ts', bytes: 10 }], claimFiles: [] }
      },
      notify: () => undefined,
      runPass: async () => ({ ok: true }),
      runCli: async () => ({ ok: true, stdout: '' }),
    } as never)
  }

  it('starts nothing new while a turn is live, and picks up when it ends', async () => {
    const started: string[] = []
    const orchestrator = makeOrchestrator(started)

    orchestrator.setYielding(true)
    orchestrator.enqueueModule('/repo', 'src', { reason: 'manual', deliberate: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(started).toEqual([])
    expect(orchestrator.isYielding()).toBe(true)

    orchestrator.setYielding(false)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(started).toEqual(['src'])
  })

  it('is not the user’s Pause, and does not clear it', async () => {
    // Pause is a person's decision and outlives the app being polite.
    const started: string[] = []
    const orchestrator = makeOrchestrator(started)
    orchestrator.setPaused(true)
    orchestrator.setYielding(true)
    orchestrator.enqueueModule('/repo', 'src', { reason: 'manual', deliberate: true })

    orchestrator.setYielding(false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(started).toEqual([]) // still paused
    expect(orchestrator.isPaused()).toBe(true)

    orchestrator.setPaused(false)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(started).toEqual(['src'])
  })
})
