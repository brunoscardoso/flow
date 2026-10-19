/**
 * THE CONTEXT MARK SITS IN A COLUMN.
 *
 * The mark at the end of a thread row says two things — this conversation has a
 * checkout of its own, and it reaches N other projects — and it is the only
 * glyph on that side of the list. Four adjacent rows drew it at THREE different
 * x positions (user, 2026-09-18: "we need to centralize that icon, i mean, all
 * should be aligned on the same position"):
 *
 *   Delta   reach only, 2   folder    left 254.7  width 11
 *   Gamma   copy + 3        checkouts left 253.7  width 12
 *   Beta    copy + 1        checkouts left 262.5  width 12
 *   Alpha   copy            checkouts left 262.5  width 12
 *
 * Two causes, both structural: the count was appended AFTER the glyph, so a row
 * with one pushed its glyph ~9px left; and the two glyphs were drawn at
 * different sizes, and `fl-icon`'s box IS its size.
 *
 * A UNIT TEST CANNOT SEE THIS. The rule is not a value anywhere — it is where
 * the boxes land once the row has been laid out — so this measures the rendered
 * geometry, which is the only thing that can disagree with the intention.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  seedCommittedRepo,
  settleWorktree,
} from './fixtures/worktree'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

test('every context mark draws its glyph on the same pixel', async ({ window }) => {
  test.setTimeout(300_000)

  const root = await seedCommittedRepo(window, 'orbit-app-')
  const other1 = await seedProject(window, 'orbit-core-')
  const other2 = await seedProject(window, 'storefront-mobile-')
  const other3 = await seedProject(window, 'argo-apps-')
  await activateProject(window, root)
  await settleWorktree(window, root)

  // THE FOUR SHAPES THE MARK TAKES — a copy alone, a copy with a count, a copy
  // with a bigger count, and reach with no copy (the other glyph).
  await window.evaluate(
    async ({ p, o1, o2, o3 }: { p: string; o1: string; o2: string; o3: string }) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const shapes: Array<{ title: string; roots: string[]; copy: boolean }> = [
        { title: 'Alpha copy only', roots: [], copy: true },
        { title: 'Beta copy and one', roots: [o1], copy: true },
        { title: 'Gamma copy and three', roots: [o1, o2, o3], copy: true },
        { title: 'Delta reach only', roots: [o1, o2], copy: false },
      ]
      for (const shape of shapes) {
        const thread = await flow.threads.create({
          projectRoot: p,
          title: shape.title,
          additionalRoots: shape.roots,
        })
        if (shape.copy) {
          await flow.threads.prepareWorktree({
            threadId: thread.id,
            requested: true,
            carry: 'clean',
          })
        }
      }
    },
    { p: root, o1: other1, o2: other2, o3: other3 },
  )

  const marks = async (): Promise<Array<{ row: string; left: number; width: number }>> =>
    window.evaluate(() => {
      // Rows live in <fl-list>'s shadow root, so `document.querySelector` finds
      // nothing here — the list has to be opened explicitly.
      const rows = Array.from(document.querySelectorAll('fl-list')).flatMap((list) =>
        Array.from(list.shadowRoot?.querySelectorAll('.row') ?? []),
      )
      return rows
        .map((row) => {
          const icon = row.querySelector('fl-icon[name="checkouts"], fl-icon[name="folder"]')
          if (icon === null) return null
          const box = icon.getBoundingClientRect()
          if (box.width === 0) return null // the file tree's own folders
          return {
            row: (row.textContent ?? '').replace(/\s+/g, ' ').slice(0, 30),
            left: Math.round(box.left * 10) / 10,
            width: Math.round(box.width * 10) / 10,
          }
        })
        .filter((entry): entry is { row: string; left: number; width: number } => entry !== null)
    })

  // THE POSITIVE FIRST: all four marks are actually drawn (allowed-pattern #28).
  // One x position across an empty list would otherwise pass perfectly.
  await expect.poll(async () => (await marks()).length, { timeout: 120_000 }).toBe(4)

  const drawn = await marks()
  expect(new Set(drawn.map((mark) => mark.left)), `three columns: ${JSON.stringify(drawn)}`).toEqual(
    new Set([drawn[0]!.left]),
  )
  // …and one footprint: `fl-icon`'s box IS its size, so two sizes in a column
  // cannot line up however they are laid out.
  expect(new Set(drawn.map((mark) => mark.width))).toEqual(new Set([12]))
})
