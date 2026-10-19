import { test, expect } from '../fixtures/electron';
import { sel, statusButtonByText } from '../selectors';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeDirective } from './fixtures/loops';

/**
 * Tasks board (Kanban) UX regression guard — flow 9 of the progressive sweep.
 *
 * Drives the board the way a user does against a seeded throwaway project:
 *   1. open the board and read its empty state,
 *   2. create a manual task and confirm it lands in Todo,
 *   3. open the task-detail modal and confirm its sections render,
 *   4. drag the card Todo → Doing and confirm the lane counts move.
 *
 * These are all no-account paths (manual create + local lane moves), so they run
 * headless in CI. A `pageerror`/`console.error` listener fails the flow on any
 * uncaught renderer error during these interactions.
 */
test.afterAll(() => cleanupSeeds());

test.describe('tasks board UX', () => {
  test('create a manual task, open its detail, and drag it between lanes', async ({
    window,
  }) => {
    const errors: string[] = [];
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    // Seed + activate a throwaway project so the board isn't "No project open".
    const root = await seedProject(window);
    // A LIST, WRITTEN BEFORE THE BOARD IS EVER READ. Todo's empty state has two
    // sentences — "Nothing here yet" when a list exists and is clear, and the
    // set-up panel when the project has no list at all — and which one a seeded
    // project gets was decided by whether the IDE's background provisioner had
    // finished writing `loops/` yet. That is a race, not a precondition, so this
    // states the precondition instead.
    writeDirective(root, { loop: 'fix', engine: 'consumer', mission: 'Drain' });
    await activateProject(window, root);

    // Open the board via the status-bar Tasks button.
    await expect(window.locator(sel.board)).toBeHidden();
    await window.locator(statusButtonByText('Tasks')).click();
    await expect(window.locator(sel.board)).toBeVisible();
    await expect(window.locator(sel.boardTitle).first()).toBeVisible();

    // Empty state: Todo lane invites a first task; every lane count is 0.
    await expect(
      window
        .locator('.fl-board-column:not(.fl-board-remote)')
        .first()
        .locator('.fl-board-empty')
    ).toHaveText('Nothing here yet');
    expect(
      await window
        .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
        .allTextContents()
    ).toEqual(['0', '0', '0', '0', '0']);

    // Create a manual task (title + description).
    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click();
    await expect(window.locator('.fl-board-modal')).toBeVisible();
    await window
      .locator('.fl-board-modal-body input[type="text"]')
      .first()
      .fill('Regression task');
    await window
      .locator('.fl-board-modal-body textarea')
      .fill('A seeded description.');
    await window
      .locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' })
      .click();
    // The modal closes only on a successful create (never eagerly — #299).
    await expect(window.locator('.fl-board-modal')).toBeHidden();

    // Reopen the board and confirm the task landed in Todo (count 1, 0, 0).
    await window.locator(statusButtonByText('Tasks')).click();
    await expect(window.locator(sel.board)).toBeVisible();
    const card = window.locator('.fl-board-card', {
      hasText: 'Regression task',
    });
    await expect(card).toBeVisible();
    await expect
      .poll(async () =>
        window
          .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
          .allTextContents()
      )
      .toEqual(['1', '0', '0', '0', '0']);

    // Open the task-detail modal and confirm its core sections render.
    await card.click();
    const detail = window.locator('.fl-board-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.fl-board-modal-title')).toHaveText(
      'Regression task'
    );
    await expect(
      detail.locator('.fl-board-detail-label', { hasText: 'Technical brief' })
    ).toBeVisible();
    await expect(
      detail.locator('.fl-board-detail-label', { hasText: 'Description' })
    ).toBeVisible();
    await expect(
      detail.locator('.fl-board-new', { hasText: 'Open chat' })
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // Drag the card Todo → Doing via native HTML5 DnD (shared DataTransfer, the
    // channel the board's dragstart/drop handlers read the task id from).
    const drag = await window.evaluate(() => {
      const card = document.querySelector(
        '.fl-board-card'
      ) as HTMLElement | null;
      const lanes = document.querySelectorAll(
        '.fl-board-column:not(.fl-board-remote) .fl-board-cards'
      );
      const doing = lanes[1] as HTMLElement | undefined; // [todo, doing, blocked, done]
      if (!card || !doing) return false;
      const dt = new DataTransfer();
      card.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })
      );
      doing.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, dataTransfer: dt })
      );
      doing.dispatchEvent(
        new DragEvent('drop', { bubbles: true, dataTransfer: dt })
      );
      card.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, dataTransfer: dt })
      );
      return true;
    });
    expect(drag).toBe(true);
    // The move persists via tasks:update and the counts follow (0, 1, 0).
    await expect
      .poll(async () =>
        window
          .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
          .allTextContents()
      )
      .toEqual(['0', '1', '0', '0', '0']);

    expect(errors).toEqual([]);
  });
});
