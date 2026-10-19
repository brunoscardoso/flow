import { test, expect, type Page } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';

/**
 * UX sweep — tasks board, minimize / maximize columns (#1902). A reader can fold
 * any lane to a thin strip to give the lanes they care about more room, the fold
 * is remembered per project, and a folded lane REVEALS itself the moment work
 * lands in it (the ticket's "when the ticket was moved into review, show the
 * column again"). This drives the rendered board:
 *
 *   · pressing a lane's minimize control collapses it (`.is-collapsed`) and
 *     writes the per-project preference,
 *   · the fold survives a project switch away and back (read back from storage),
 *   · seeding a card into a folded lane (via `tasks:update`, the same IPC the app
 *     uses) auto-expands it.
 *
 * Account-independent: no real agent turn or GitHub PR is involved.
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
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>;
      update(r: { taskId: string; patch: Record<string, unknown> }): Promise<unknown>;
    };
  };
};

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

/** The Blocked column — a lane with no head controls of its own, chosen so the
 *  collapse control is the only button in its head. */
const blockedColumn = (win: Page) =>
  win
    .locator('.fl-board-column:not(.fl-board-remote)')
    .filter({ has: win.locator('.fl-board-column-naming > span:first-child', { hasText: 'Blocked' }) });

async function openBoard(win: Page, root: string): Promise<void> {
  await activateProject(win, root);
  await win.locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]').click();
  await expect(win.locator('.fl-board-columns')).toBeVisible({ timeout: 8000 });
}

test.describe('tasks board — minimize / maximize columns (#1902)', () => {
  test('a lane minimizes, and its minimize control toggles it back', async ({ window }) => {
    const errors = watchErrors(window);
    const root = await seedProject(window, 'flow-ux-collapse-');
    await openBoard(window, root);

    const blocked = blockedColumn(window);
    await expect(blocked).toBeVisible({ timeout: 8000 });
    await expect(blocked).not.toHaveClass(/is-collapsed/);

    // Minimize it.
    await blocked.locator('.fl-board-lane-collapse').click();
    await expect(blocked).toHaveClass(/is-collapsed/);
    // The preference is written, per project.
    const stored = await window.evaluate(
      (r) => window.localStorage.getItem(`flow.board.collapsed:${r}`),
      root
    );
    expect(stored).toBe('blocked');

    // The control now restores it — clicking again maximizes.
    await blocked.locator('.fl-board-lane-collapse').click();
    await expect(blocked).not.toHaveClass(/is-collapsed/);

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('the fold is remembered across a project switch', async ({ window }) => {
    const errors = watchErrors(window);
    const projectA = await seedProject(window, 'flow-ux-collapse-a-');
    await openBoard(window, projectA);

    await blockedColumn(window).locator('.fl-board-lane-collapse').click();
    await expect(blockedColumn(window)).toHaveClass(/is-collapsed/);

    // Switch to another project (board rebinds, no fold there), then back.
    const projectB = await seedProject(window, 'flow-ux-collapse-b-');
    await activateProject(window, projectB);
    await expect(blockedColumn(window)).not.toHaveClass(/is-collapsed/);

    await activateProject(window, projectA);
    // Restored from storage on the way back in.
    await expect(blockedColumn(window)).toHaveClass(/is-collapsed/, { timeout: 8000 });

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('new work in a folded lane reveals it (auto-expand)', async ({ window }) => {
    const errors = watchErrors(window);
    const root = await seedProject(window, 'flow-ux-collapse-reveal-');
    await openBoard(window, root);

    await blockedColumn(window).locator('.fl-board-lane-collapse').click();
    await expect(blockedColumn(window)).toHaveClass(/is-collapsed/);

    // A card lands in Blocked — the same write the board loop performs.
    await window.evaluate(async ({ p }) => {
      const api = (window as unknown as TasksBridge).flow.tasks;
      const task = await api.create({ projectRoot: p, title: 'Blocked lane work' });
      await api.update({ taskId: task.id, patch: { lane: 'blocked' } });
    }, { p: root });

    // Its count rose from 0 → the folded lane reveals itself.
    await expect(blockedColumn(window)).not.toHaveClass(/is-collapsed/, { timeout: 8000 });

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('a fold with a card ALREADY in the lane survives reopen — it does not auto-reveal on load', async ({
    window,
  }) => {
    // Regression: auto-reveal must fire only when a card ARRIVES while folded,
    // never when a project (re)opens with cards already sitting in a folded
    // lane. The board-loop render lands before the data-load render, so a naïve
    // baseline reads a fold's real count as "0 → N growth" and both reveals it
    // AND erases the saved preference. This guards that it does neither.
    const errors = watchErrors(window);
    const projectA = await seedProject(window, 'flow-ux-collapse-load-a-');
    await activateProject(window, projectA);
    // A card is in Blocked BEFORE the board is ever shown.
    await window.evaluate(async ({ p }) => {
      const api = (window as unknown as TasksBridge).flow.tasks;
      const task = await api.create({ projectRoot: p, title: 'Pre-existing blocked' });
      await api.update({ taskId: task.id, patch: { lane: 'blocked' } });
    }, { p: projectA });

    await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]').click();
    await expect(window.locator('.fl-board-columns')).toBeVisible({ timeout: 8000 });

    // Fold Blocked (it holds 1 card) and confirm the count rode into the strip.
    await blockedColumn(window).locator('.fl-board-lane-collapse').click();
    await expect(blockedColumn(window)).toHaveClass(/is-collapsed/);
    await expect(blockedColumn(window).locator('.fl-board-count')).toHaveText('1');

    // Reopen the project: switch away and back, forcing a fresh load.
    const projectB = await seedProject(window, 'flow-ux-collapse-load-b-');
    await activateProject(window, projectB);
    await activateProject(window, projectA);

    // Still folded, still holding its card — no reveal, no erased preference.
    await expect(blockedColumn(window)).toHaveClass(/is-collapsed/, { timeout: 8000 });
    await expect(blockedColumn(window).locator('.fl-board-count')).toHaveText('1');
    const stored = await window.evaluate(
      (r) => window.localStorage.getItem(`flow.board.collapsed:${r}`),
      projectA
    );
    expect(stored).toBe('blocked');

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('a card can be dropped onto a folded lane', async ({ window }) => {
    const errors = watchErrors(window);
    const root = await seedProject(window, 'flow-ux-collapse-drop-');
    await openBoard(window, root);

    // One card in Todo.
    await window.evaluate(async ({ p }) => {
      const api = (window as unknown as TasksBridge).flow.tasks;
      await api.create({ projectRoot: p, title: 'Draggable card' });
    }, { p: root });
    const card = window.locator('.fl-board-card', { hasText: 'Draggable card' });
    await expect(card).toBeVisible({ timeout: 8000 });

    // Fold Blocked, then drag the Todo card onto the folded strip.
    await blockedColumn(window).locator('.fl-board-lane-collapse').click();
    await expect(blockedColumn(window)).toHaveClass(/is-collapsed/);

    const moved = await window.evaluate(() => {
      const el = document.querySelector('.fl-board-card') as HTMLElement | null;
      const cols = document.querySelectorAll('.fl-board-column:not(.fl-board-remote)');
      // Blocked is the third non-remote lane (Todo · Doing · Blocked · …).
      const blocked = cols[2] as HTMLElement | undefined;
      if (!el || !blocked) return false;
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      blocked.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
      blocked.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return true;
    });
    expect(moved).toBe(true);

    // The store reflects the move — the drop was not silently swallowed.
    await expect
      .poll(
        async () =>
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
            return tasks.find((t) => t.title === 'Draggable card')?.lane ?? null;
          }, root),
        { timeout: 5000 }
      )
      .toBe('blocked');

    expect(errors, errors.join(', ')).toEqual([]);
  });
});
