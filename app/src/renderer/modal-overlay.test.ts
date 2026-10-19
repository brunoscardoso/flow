import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1430: the image viewer declared `aria-modal="true"` and never registered
// with this module, so it was modal for the MOUSE only — ⌃` opened a terminal
// behind its backdrop and handed it the keyboard, ⌘B collapsed the sidebar out
// of sight, Tab walked onto controls nobody could see. That is the fifth
// recurrence of the same class (#525 → #1002 → #1006 → #1198 → #1430), and
// each time the overlay opted out by SILENCE rather than by decision.
//
// The convention only holds if forgetting it is loud. `aria-modal="true"` is
// the author asserting modality to assistive tech; `markModalOverlay()` is the
// same claim made to the keyboard. A file that makes one and not the other is
// promising something it does not enforce, so this scan fails the build.

const RENDERER_ROOT = __dirname

function tsFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...tsFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path)
  }
  return found
}

describe('modal overlay registration (#1430)', () => {
  it('every renderer source asserting aria-modal also calls markModalOverlay', () => {
    const unregistered = tsFiles(RENDERER_ROOT)
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return source.includes('aria-modal') && !source.includes('markModalOverlay')
      })
      .map((path) => path.slice(RENDERER_ROOT.length + 1))

    expect(unregistered).toEqual([])
  })

  it('finds the declarations it is meant to police', () => {
    // A guard that silently matches nothing is worse than no guard: if the
    // attribute is ever set some other way (a template, a helper), this fails
    // and says so rather than reporting a clean scan of zero files.
    const declaring = tsFiles(RENDERER_ROOT).filter((path) =>
      readFileSync(path, 'utf8').includes('aria-modal'),
    )

    expect(declaring.length).toBeGreaterThan(0)
  })
})
