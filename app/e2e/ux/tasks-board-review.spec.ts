import { test, expect, type Page } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';

/**
 * UX sweep — tasks board, the REVIEW lane. When the board loop finishes a card's
 * turn cleanly it opens a pull request and moves the card to Review; a Review
 * card carries the PR (a link and a one-click squash-merge). This drives the
 * rendered result: the fifth column exists, a review card shows its PR link and
 * Merge button, and pressing Merge runs the real IPC path without throwing.
 *
 * Account-independent: the review state is set through `tasks:update` (the same
 * IPC the app uses), not by driving a real agent turn + real GitHub PR. The
 * merge click exercises the whole renderer → main → ThreadLandingService path;
 * with a seeded (non-real) PR it comes back "couldn't merge", which is a normal
 * outcome and must not crash the app.
 */

test.afterAll(() => {
  try {
    cleanupSeeds();
  } catch {
    /* temp dirs are OS-cleaned */
  }
});

type TasksBridge = {
  flow: {
    tasks: {
      list(r: {
        projectRoot: string;
        includeArchived: boolean;
      }): Promise<Array<{ id: string; title: string; lane: string; prUrl?: string | null }>>;
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>;
      update(r: { taskId: string; patch: Record<string, unknown> }): Promise<unknown>;
    };
  };
};

const laneCounts = (win: Page) =>
  win
    .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
    .allTextContents();

const laneLabels = (win: Page) =>
  win
    .locator('.fl-board-column:not(.fl-board-remote) .fl-board-column-naming > span:first-child')
    .allTextContents();

/** Uncaught-error capture; the board's own diagnostics are console.error by design. */
function watchErrors(window: Page): string[] {
  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  window.on('console', (m) => {
    if (m.type() === 'error' && !/Canceled|failed to (load|move|generate|merge)/i.test(m.text())) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  return errors;
}

const PR_URL = 'https://github.com/acme/widgets/pull/42';

/** Seed a project + one task the board loop has moved to Review, board open. */
async function seedReviewTask(window: Page, title: string): Promise<string> {
  const root = await seedProject(window, 'flow-ux-review-');
  await activateProject(window, root);
  await window.evaluate(
    async ({ p, t, pr }) => {
      const api = (window as unknown as TasksBridge).flow.tasks;
      const task = await api.create({ projectRoot: p, title: t });
      // What a clean board-loop turn does: open a PR and move the card to Review.
      await api.update({ taskId: task.id, patch: { lane: 'review', prUrl: pr } });
    },
    { p: root, t: title, pr: PR_URL }
  );

  await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]').click();
  await expect(window.locator('.fl-board-columns')).toBeVisible({ timeout: 8000 });
  return root;
}

test.describe('tasks board — the Review lane', () => {
  test('has a Review column, between Blocked and Done', async ({ window }) => {
    const errors = watchErrors(window);
    await seedReviewTask(window, 'Review lane task');

    await expect.poll(() => laneLabels(window), { timeout: 8000 }).toEqual([
      'Todo',
      'Doing',
      'Blocked',
      'Review',
      'Done',
    ]);
    // The seeded card lands in the fourth lane (Review), and only there.
    await expect
      .poll(() => laneCounts(window), { timeout: 8000 })
      .toEqual(['0', '0', '0', '1', '0']);

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('a Review card shows its PR link and a Merge button', async ({ window }) => {
    const errors = watchErrors(window);
    await seedReviewTask(window, 'Review card PR');

    const card = window.locator('.fl-board-card', { hasText: 'Review card PR' });
    await expect(card).toBeVisible({ timeout: 8000 });

    // The PR link points at the pull request the card carries.
    const link = card.locator('a.fl-board-detail-key', { hasText: 'PR' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', PR_URL);

    // The Merge button is present.
    await expect(card.locator('button.fl-board-badge-merge')).toHaveText('Merge');

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('pressing Merge runs the full IPC path without crashing the app', async ({ window }) => {
    const errors = watchErrors(window);
    await seedReviewTask(window, 'Merge click task');

    const card = window.locator('.fl-board-card', { hasText: 'Merge click task' });
    const merge = card.locator('button.fl-board-badge-merge');
    await expect(merge).toBeVisible({ timeout: 8000 });
    await merge.click();
    // The seeded PR is not a real one, so the merge legitimately fails and the
    // card stays in Review — what matters is the round trip did not throw.
    await window.waitForTimeout(1500);

    expect(errors, errors.join(', ')).toEqual([]);
    // The app is still alive and drawing the board.
    await expect(window.locator('.fl-board-columns')).toBeVisible();
  });
});
