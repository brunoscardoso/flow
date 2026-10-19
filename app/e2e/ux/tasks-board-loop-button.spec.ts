import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeDirective } from './fixtures/loops'

/**
 * PRESSING THE BUTTON HAS TO DO SOMETHING VISIBLE.
 *
 * This file replaces `tasks-loop-switch.spec.ts`, and the reason is the whole
 * point of the change it guards. That spec walked a round trip the user had
 * reported broken — "i press play or pause on the todo nothing happes" — where
 * the board's play button wrote a state pause for the CLI's loop and the read
 * that repainted the button never opened `flow/loops/state.json`.
 *
 * The fix was real and the button did change its mind. But it was answering the
 * wrong question: it started a CLI loop that drains `flow/loops/queue.jsonl`,
 * while every card on this board is a Flow task record on no queue at all. So
 * the same user hit the deeper version of the same complaint — "the button play
 * of the loop was played but never the agent trigger the item" — and this time
 * the press really had worked. There was simply nothing on the other end.
 *
 * The button runs the BOARD's list now, so what a press does is checked here
 * against the board rather than against a directive. The CLI loop's pause
 * round-trip is unchanged and still covered where it lives (loops-handler).
 */
test.afterAll(() => cleanupSeeds())

const PLAY = '.fl-board-lane-controls .fl-board-lane-btn'

test('the board\'s play button is about the board, not about a directive', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  const dir = await seedProject(window, 'flow-ux-bloopbtn-')
  // Two healthy, UNPAUSED CLI loops — the state the old button read. They are
  // deliberately irrelevant now: what decides this control is the board.
  writeDirective(dir, { loop: 'find', engine: 'producer', paused: false, mission: 'Hunt' })
  writeDirective(dir, { loop: 'fix', engine: 'consumer', paused: false, mission: 'Drain' })
  await activateProject(window, dir)
  await window.locator('.fl-rail-item[aria-label="Tasks"]').click()
  await expect(window.locator('.fl-board-lane-btn[aria-label="New task"]')).toBeVisible({
    timeout: 20_000,
  })

  // A running consumer loop used to make this read "Stop the loop". With an
  // empty board there is nothing to work, and the button says that instead —
  // which is the honest answer, and the one the user needed six hours earlier.
  const play = window.locator(PLAY).first()
  await expect(play).toHaveAttribute('aria-label', 'Nothing is set to be worked')
  await expect(play).toBeDisabled()

  expect(errors, errors.join(', ')).toEqual([])
})
