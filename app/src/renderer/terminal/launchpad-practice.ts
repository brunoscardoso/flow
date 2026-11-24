/**
 * PRACTICE STEPS FOR LAUNCHPAD (user, 2026-11-23: "create a mock suggestion
 * that will run some commands to user understand the flow, then we can
 * delete").
 *
 * Three steps that only print text, added to the DRAFT so nothing is kept
 * until the person presses Save:
 *   - practice-server: keeps running, and counts as ready when it prints
 *     "ready" — so the person sees a ready check pass.
 *   - practice-worker: keeps running, and starts only after the server is
 *     ready — so the person sees the order and the wait.
 *   - practice-hello: a one-time action that asks first — so the person sees
 *     the Launchpad menu run something once and stop.
 *
 * One click takes them out again. A practice step is recognised by its name
 * AND its exact command, so a step the person wrote and happened to name
 * "practice-server" is never removed by it.
 *
 * Each command exists for both shells Flow's terminals use: a POSIX shell on
 * macOS and Linux, PowerShell on Windows.
 */
import { addStep, changeStep, removeStep, type DraftStep, type RunSetupDraft } from './run-setup-model'

interface PracticeStep {
  name: string
  kind: 'service' | 'once'
  posix: string
  powershell: string
  start: 'now' | 'after-previous'
  readyText: string | null
  confirm: boolean
}

export const PRACTICE_STEPS: readonly PracticeStep[] = [
  {
    name: 'practice-server',
    kind: 'service',
    posix:
      'echo "Practice server starting..."; sleep 2; echo "Practice server ready"; ' +
      'while true; do sleep 5; echo "Practice server is still running"; done',
    powershell:
      "Write-Output 'Practice server starting...'; Start-Sleep 2; Write-Output 'Practice server ready'; " +
      "while ($true) { Start-Sleep 5; Write-Output 'Practice server is still running' }",
    start: 'now',
    readyText: 'ready',
    confirm: false,
  },
  {
    name: 'practice-worker',
    kind: 'service',
    posix:
      'echo "Practice worker started after the server was ready"; ' +
      'while true; do sleep 7; echo "Practice worker checked for work"; done',
    powershell:
      "Write-Output 'Practice worker started after the server was ready'; " +
      "while ($true) { Start-Sleep 7; Write-Output 'Practice worker checked for work' }",
    start: 'after-previous',
    readyText: null,
    confirm: false,
  },
  {
    name: 'practice-hello',
    kind: 'once',
    posix: 'echo "Hello from a one-time action. It ran once and stopped."',
    powershell: "Write-Output 'Hello from a one-time action. It ran once and stopped.'",
    start: 'now',
    readyText: null,
    confirm: true,
  },
]

function commandFor(step: PracticeStep, platform: string): string {
  return platform === 'win32' ? step.powershell : step.posix
}

/** True for a step this module added (its name and its command both match). */
export function isPracticeStep(step: Pick<DraftStep, 'name' | 'command'>): boolean {
  return PRACTICE_STEPS.some(
    (p) => p.name === step.name && (p.posix === step.command || p.powershell === step.command),
  )
}

export function hasPracticeSteps(draft: Pick<RunSetupDraft, 'steps'>): boolean {
  return draft.steps.some(isPracticeStep)
}

/**
 * Add the practice steps to the draft: the running ones after the person's own
 * running steps, the one-time action after their one-time actions. Adding
 * again does nothing.
 */
export function addPracticeSteps(draft: RunSetupDraft, platform: string): RunSetupDraft {
  if (hasPracticeSteps(draft)) return draft
  // The page starts with one blank card; practice steps take its place rather
  // than sitting under an empty row the person would have to delete.
  let next = draft
  for (const step of draft.steps) {
    if (step.isNew && step.name.trim() === '' && step.command.trim() === '') next = removeStep(next, step.id)
  }
  for (const practice of PRACTICE_STEPS) {
    next = addStep(next, { name: practice.name, command: commandFor(practice, platform), kind: practice.kind })
    const added = next.steps[next.steps.length - 1]
    if (added === undefined) continue
    next = changeStep(next, added.id, {
      start: practice.start,
      readyKind: practice.readyText === null ? 'none' : 'line',
      readyValue: practice.readyText ?? '',
      ...(practice.kind === 'once' ? { confirm: practice.confirm } : {}),
    })
  }
  return next
}

/** Take every practice step out of the draft (saved ones are removed on Save). */
export function removePracticeSteps(draft: RunSetupDraft): RunSetupDraft {
  let next = draft
  for (const step of draft.steps) {
    if (isPracticeStep(step)) next = removeStep(next, step.id)
  }
  return next
}

export const PRACTICE_STRINGS = {
  offer: 'New to Launchpad? Add practice steps to watch it work. They only print text.',
  add: 'Add practice steps',
  added: 'Practice steps added. Save and run to watch them start, then remove them here.',
  remove: 'Remove practice steps',
} as const
