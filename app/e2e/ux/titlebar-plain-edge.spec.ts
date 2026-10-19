/**
 * THE HEADER'S EDGE IS A BORDER, NOT A COLOUR.
 *
 * The titlebar's bottom edge carried the active project's accent for a while —
 * "one project, one colour, whichever of its threads is open". Reported and
 * removed: on a 34px header the line reads as a coloured band across the top of
 * the app, and switching projects flashes it a different colour. Which project
 * is open is already said in words, two controls to the left.
 *
 * The neutral rule that replaced it went too (shell.ts): it was lighter than the
 * chrome on both sides, so it separated nothing. This asserts what a person
 * sees: the header paints NO bottom edge, and still none after the active
 * project changes. A CSS-only check would not catch a re-introduction through
 * the inline custom property the old code set, so the computed style is read
 * off the live element instead.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

/** The header's painted bottom edge — its style and width, as computed. */
async function edge(win: import('@playwright/test').Page): Promise<string> {
  return win.evaluate(() => {
    const bar = document.querySelector('.fl-titlebar') as HTMLElement | null
    if (bar === null) return 'MISSING'
    const style = getComputedStyle(bar)
    return `${style.borderBottomStyle} ${style.borderBottomWidth}`
  })
}

test('the header paints no edge, before or after a project switch', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const first = await seedProject(window, 'flow-ux-edge-a-')
  await activateProject(window, first)
  expect(await edge(window), 'no edge on the first project').toBe('none 0px')

  // A second project hashes to a different accent — the switch is exactly when
  // the band was reported, so it is exactly what this watches.
  const second = await seedProject(window, 'flow-ux-edge-b-')
  await activateProject(window, second)
  expect(await edge(window), 'and none after switching to another').toBe('none 0px')

  // Nothing re-introduces it through the old inline custom property.
  const inline = await window.evaluate(
    () => (document.querySelector('.fl-titlebar') as HTMLElement | null)?.style.cssText ?? '',
  )
  expect(inline).not.toContain('--fl-chrome-accent')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
