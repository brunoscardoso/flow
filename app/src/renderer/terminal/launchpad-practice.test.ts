import { addPracticeSteps, hasPracticeSteps, isPracticeStep, PRACTICE_STEPS, PRACTICE_STRINGS, removePracticeSteps } from './launchpad-practice'
import { addStep, stepsOfKind, type RunSetupDraft } from './run-setup-model'

const empty = (): RunSetupDraft => ({ projectRoot: '/p', projectName: 'p', steps: [], removed: [], original: [] })

describe('practice steps', () => {
  it('adds two running steps and one one-time action, with the order and checks set', () => {
    const draft = addPracticeSteps(empty(), 'darwin')
    const services = stepsOfKind(draft, 'service')
    const once = stepsOfKind(draft, 'once')
    expect(services.map((s) => s.name)).toEqual(['practice-server', 'practice-worker'])
    expect(once.map((s) => s.name)).toEqual(['practice-hello'])
    expect(services[0]).toMatchObject({ start: 'now', readyKind: 'line', readyValue: 'ready' })
    expect(services[1]).toMatchObject({ start: 'after-previous', readyKind: 'none' })
    expect(once[0]).toMatchObject({ confirm: true })
    expect(services[0]?.command).toContain('echo')
  })

  it('takes the place of the blank starter card', () => {
    const blank = addStep(empty(), { name: '', command: '' })
    const draft = addPracticeSteps(blank, 'darwin')
    expect(draft.steps.map((s) => s.name)).toEqual(['practice-server', 'practice-worker', 'practice-hello'])
  })

  it('uses PowerShell on Windows', () => {
    const draft = addPracticeSteps(empty(), 'win32')
    expect(draft.steps.every((s) => s.command.includes('Write-Output'))).toBe(true)
    expect(hasPracticeSteps(draft)).toBe(true)
  })

  it('does not add them twice, and keeps the person\'s own steps in front', () => {
    const own = addStep(empty(), { name: 'web', command: 'npm run dev' })
    const once = addPracticeSteps(own, 'darwin')
    expect(addPracticeSteps(once, 'darwin')).toBe(once)
    expect(stepsOfKind(once, 'service').map((s) => s.name)).toEqual(['web', 'practice-server', 'practice-worker'])
  })

  it('removes only its own steps — a step merely named like one stays', () => {
    let draft = addStep(empty(), { name: 'practice-server', command: 'npm start' })
    draft = addPracticeSteps(draft, 'darwin')
    const after = removePracticeSteps(draft)
    expect(after.steps.map((s) => [s.name, s.command])).toEqual([['practice-server', 'npm start']])
    expect(hasPracticeSteps(after)).toBe(false)
  })

  it('every practice command only prints text and waits', () => {
    for (const step of PRACTICE_STEPS) {
      for (const command of [step.posix, step.powershell]) {
        expect(command).not.toMatch(/\brm\b|Remove-Item|curl|wget|Invoke-WebRequest|npm|git |sudo|>/)
      }
      expect(isPracticeStep({ name: step.name, command: step.posix })).toBe(true)
    }
  })

  it('says nothing a person would have to type', () => {
    for (const line of Object.values(PRACTICE_STRINGS)) expect(line).not.toMatch(/`|\//)
  })
})
