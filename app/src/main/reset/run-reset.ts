/**
 * RUN THE STEPS OF A RESET — one per item, each on its own.
 *
 * A step that fails is recorded with its sentence and the others still run: a
 * person who asked for eleven kinds of data deleted should not keep ten of
 * them because the third hit a locked file.
 *
 * THE CONFIRMATION IS A REQUIRED LITERAL. `confirmed: true` is written by the
 * one caller that acts on a person's typed confirmation; a call that forgets it
 * does not compile, and a call that passes anything else deletes nothing
 * (forbidden-pattern #15). The steps themselves are handed in — this file
 * knows no path.
 */
import type { ResetItem, ResetOutcome } from '../../shared/reset-items'

export type ResetStep = () => void | Promise<void>
export type ResetSteps = Record<ResetItem, ResetStep>

export async function runReset(input: {
  items: readonly ResetItem[]
  steps: ResetSteps
  confirmed: true
  now: () => Date
  log?: (line: string) => void
}): Promise<ResetOutcome> {
  if ((input.confirmed as unknown) !== true) {
    throw new Error('A reset needs an explicit confirmation.')
  }
  const done: ResetItem[] = []
  const failed: ResetOutcome['failed'] = []
  for (const item of input.items) {
    try {
      await input.steps[item]()
      done.push(item)
      input.log?.(`[reset] deleted ${item}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failed.push({ item, detail })
      input.log?.(`[reset] could not delete ${item}: ${detail}`)
    }
  }
  return { at: input.now().toISOString(), done, failed }
}
