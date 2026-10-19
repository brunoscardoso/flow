import { test, expect } from '../fixtures/electron';
import { sel, statusButtonByText } from '../selectors';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeDirective } from './fixtures/loops';

/**
 * UX sweep — completing a task (drag to the DONE lane) and reopening it (drag
 * back). flow 9, round 9.
 *
 * tasks.spec and tasks-drag-persist both drag a card Todo→Doing only — the
 * forward move into the middle lane. The board's core promise, though, is that a
 * user COMPLETES work by dragging a card into "Done", and REOPENS it by dragging
 * it back out. The Done lane as a drop target, and the reverse (right→left)
 * direction, had ZERO live e2e coverage across the flow-9 specs.
 *
 * Both moves go through the same #moveTask (optimistic paint + tasks:update
 * persist), but a drop onto the third lane / a right-to-left move is a distinct
 * user gesture that no probe drives. This asserts:
 *   1. Todo→Done moves the card, the lane COUNTS follow to [0,0,1], and the
 *      STORE lane persists as 'done' (the write, not just the optimistic paint),
 *   2. the emptied Todo lane restores its "Nothing here yet" empty state,
 *   3. Done→Todo reopens the task — counts return to [1,0,0] and the store lane
 *      persists back to 'todo',
 * all with zero uncaught renderer errors.
 */

test.afterAll(() => cleanupSeeds());

test('drag a card Todo→Done to complete it, then Done→Todo to reopen it', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  const root = await seedProject(window);
  // A LIST, WRITTEN BEFORE THE BOARD IS EVER READ. Todo's empty state has two
  // sentences — "Nothing here yet" when a list exists and is clear, and the
  // set-up panel when the project has no list at all — and which one a seeded
  // project gets was decided by whether the IDE's background provisioner had
  // finished writing `loops/` yet. That is a race, not a precondition, so this
  // states the precondition instead.
  writeDirective(root, { loop: 'fix', engine: 'consumer', mission: 'Drain' });
  await activateProject(window, root);

  await window.locator(statusButtonByText('Tasks')).click();
  await expect(window.locator(sel.board)).toBeVisible();

  // Create a manual task (lands in Todo).
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click();
  await expect(window.locator('.fl-board-modal')).toBeVisible();
  await window
    .locator('.fl-board-modal-body input[type="text"]')
    .first()
    .fill('Ship it');
  await window
    .locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' })
    .click();
  await expect(window.locator('.fl-board-modal')).toBeHidden();

  const card = window.locator('.fl-board-card', { hasText: 'Ship it' });
  await expect(card).toBeVisible();
  await expect
    .poll(async () =>
      window
        .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
        .allTextContents()
    )
    .toEqual(['1', '0', '0', '0', '0']);

  // ── Complete: drag Todo → Done (the LAST .fl-board-cards lane). ────────────
  const laneKey = (laneIndex: number): boolean => {
    // Emulated in the page: fire the native HTML5 DnD sequence over a shared
    // DataTransfer, the channel the board's dragstart→drop handlers use.
    const el = document.querySelector('.fl-board-card') as HTMLElement | null;
    const target = document.querySelectorAll(
      '.fl-board-column:not(.fl-board-remote) .fl-board-cards'
    )[laneIndex] as HTMLElement | undefined;
    if (!el || !target) return false;
    const dt = new DataTransfer();
    el.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })
    );
    target.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, dataTransfer: dt })
    );
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, dataTransfer: dt })
    );
    el.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: dt })
    );
    return true;
  };

  expect(await window.evaluate(laneKey, 4)).toBe(true); // [todo, doing, blocked, review, done]
  await expect
    .poll(async () =>
      window
        .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
        .allTextContents()
    )
    .toEqual(['0', '0', '0', '0', '1']);

  // The card now lives in the Done lane, and the emptied Todo lane restores its
  // "Nothing here yet" empty state (a real render, not a stale count).
  const doneLane = window.locator('.fl-board-column').last();
  await expect(
    doneLane.locator('.fl-board-card', { hasText: 'Ship it' })
  ).toBeVisible();
  await expect(
    window
      .locator('.fl-board-column:not(.fl-board-remote)')
      .first()
      .locator('.fl-board-empty')
  ).toHaveText('Nothing here yet');

  // PERSISTENCE: the STORE lane is 'done', not just the optimistic paint.
  const laneInStore = async (): Promise<string | null> =>
    window.evaluate(async (projectRoot) => {
      const api = (
        window as unknown as {
          flow: {
            tasks: {
              list(r: {
                projectRoot: string;
              }): Promise<Array<{ title: string; lane: string }>>;
            };
          };
        }
      ).flow;
      const tasks = await api.tasks.list({ projectRoot });
      return tasks.find((t) => t.title === 'Ship it')?.lane ?? null;
    }, root);

  await expect.poll(laneInStore, { timeout: 5_000 }).toBe('done');

  // ── Reopen: drag Done → Todo (right-to-left, the reverse gesture). ──────────
  expect(await window.evaluate(laneKey, 0)).toBe(true);
  await expect
    .poll(async () =>
      window
        .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
        .allTextContents()
    )
    .toEqual(['1', '0', '0', '0', '0']);
  await expect.poll(laneInStore, { timeout: 5_000 }).toBe('todo');

  expect(errors).toEqual([]);
});
