import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * ONE BOX PER SIDEBAR ROW (2026-09-08).
 *
 * The thread sidebar painted its "which thread am I on" decoration onto the
 * element it renders INTO an <fl-list> row. That element is not the row — it
 * sits inside the row's 8px padding and is only as tall as its content — so
 * the open thread came out as a 300×20 accent rectangle floating inside the
 * row's own 316×28 grey fill: two boxes for one selection ("we have kind of
 * double-selecting … a blue thing or a gray thing"). At the same time a
 * project header stretched to fill the taller row that carries the
 * between-project gap, making a hovered project a 40px target over 28px thread
 * rows ("too much space").
 *
 * Neither is expressible in a unit test: both are about WHICH ELEMENT the
 * paint landed on, and both looked correct in the code that caused them. So
 * this measures the rendered boxes.
 *
 * Reads geometry and computed backgrounds out of <fl-list>'s shadow root —
 * observable rendering, not internals.
 */

/** Create a thread in `root` via the same IPC the "+" button calls. */
async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

interface RowBox {
  text: string
  rowHeight: number
  rowPainted: boolean
  innerHeight: number
  innerPainted: boolean
}

/** Every rendered sidebar row: its box, its content's box, and which of the two
 *  actually carries a background. `transparent` computes to rgba(0,0,0,0). */
async function rowBoxes(win: Page): Promise<RowBox[]> {
  return win.evaluate(() => {
    const list = document.querySelector('.fl-thread-list fl-list')
    const root = list?.shadowRoot
    if (!root) return []
    const painted = (el: Element): boolean =>
      getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'
    return Array.from(root.querySelectorAll('.row')).map((row) => {
      const inner = row.firstElementChild
      return {
        text: (row.textContent ?? '').trim(),
        rowHeight: Math.round(row.getBoundingClientRect().height),
        rowPainted: painted(row),
        innerHeight: inner === null ? 0 : Math.round(inner.getBoundingClientRect().height),
        innerPainted: inner === null ? false : painted(inner),
      }
    })
  })
}

// PROJECT HEADERS ARE GONE. In a Workspace the thread list is one flat list
// whose rows name their project on a second line; there is no per-project
// header row any more, so the header half of this spec (the 40px header vs.
// 28px rows) has nothing to measure. The row half — one box for the open
// thread — is unchanged and is what this still drives. Row heights are no
// longer pinned to 28: a row is two lines tall now.
test('the open thread is one box, painted on the row and never inside it', async ({
  window,
}) => {
  test.setTimeout(120_000)
  try {
    const first = await seedProject(window, 'flow-sidebar-first-')
    const second = await seedProject(window, 'flow-sidebar-second-')
    await activateProject(window, first)
    await createThread(window, first, 'Log strings for edit playbook error')
    await activateProject(window, second)
    await createThread(window, second, 'React Native version mismatch')
    await createThread(window, second, 'Production environment variables')

    // Open a thread the way a person does (on its title — the second line is
    // the project name), then park the pointer off the list so nothing is hovered.
    await openThreadByTitle(window, 'React Native version mismatch')
    await window.mouse.move(900, 500)

    await expect
      .poll(async () => (await rowBoxes(window)).find((r) => r.text.includes('React Native')))
      .toMatchObject({
        // The ROW carries the selection…
        rowPainted: true,
        // …and the content inside it carries none. A second fill here is the
        // inner box the report was about.
        innerPainted: false,
      })

    // The content sits inside the row it is drawn in — one box, not two.
    const boxes = await rowBoxes(window)
    const threadRow = boxes.find((r) => r.text.includes('React Native'))
    expect(threadRow?.innerHeight).toBeGreaterThan(0)
    expect(threadRow?.innerHeight).toBeLessThanOrEqual(threadRow?.rowHeight ?? 0)
    // A resting (not open, not hovered) row paints nothing at all.
    const resting = boxes.find((r) => r.text.includes('Production environment'))
    expect(resting).toMatchObject({ rowPainted: false, innerPainted: false })

    // AND THE PILL IS INSET AND ROUNDED, not a stripe cut edge to edge.
    const pill = await window.evaluate(() => {
      const row = document
        .querySelector('.fl-thread-list fl-list')
        ?.shadowRoot?.querySelector('.row')
      if (!row) return null
      const style = getComputedStyle(row)
      const list = row.closest('.scroller')
      return {
        radius: style.borderTopLeftRadius,
        inset: Math.round(
          row.getBoundingClientRect().left - (list?.getBoundingClientRect().left ?? 0),
        ),
      }
    })
    expect(pill?.radius).not.toBe('0px')
    expect(pill?.inset).toBeGreaterThan(0)

    // NOTHING IN THE RESTING LIST IS ACCENT-TINTED. The open thread is a
    // neutral step past hover; a blue fill on a resting panel reads as an alert.
    const accents = await window.evaluate(() => {
      const root = document.querySelector('.fl-thread-list fl-list')?.shadowRoot
      if (!root) return []
      return Array.from(root.querySelectorAll('.row, .row *'))
        .map((el) => getComputedStyle(el).backgroundColor)
        .filter((bg) => bg.startsWith('rgba(55, 148, 255'))
    })
    expect(accents).toEqual([])
  } finally {
    cleanupSeeds()
  }
})
