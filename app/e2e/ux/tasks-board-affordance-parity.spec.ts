import { test, expect, type Page } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';

/**
 * UX sweep — tasks board (flow 9), AFFORDANCE PARITY between the board and its
 * siblings. The 29 prior board specs all ask whether an affordance's RESULT is
 * right (draft preserved, lane persisted, error surfaced). These ask whether the
 * affordance does what it LOOKS like it does, measured against the sibling
 * surface that does the same job.
 *
 * Two mismatches this pins down:
 *
 *  A. The "Done?" chip. A clean agent turn sets `suggestDone` (task-service
 *     `makeOnTurnComplete`), and the board card renders a blue "Done?" chip for
 *     it. The chip was once a `<span class="fl-board-badge-suggest">` with no
 *     handler of its own, so the click fell through to the card and opened the
 *     task-detail modal — which says NOTHING about the suggestion, leaving
 *     `suggestDone` true (#1102). It is a real button now.
 *
 *     THE SIBLING IS GONE, and with it this file's original method. The chip
 *     was measured against the SIDEBAR's accept button, which the user had
 *     removed on 2026-08-26 ("remove it from the threads, we don't need that")
 *     — a lane control on a row nobody came to for lanes. Two tests kept
 *     asserting that button existed and one existed only to exercise it; they
 *     were failing on a surface the product no longer has. The board's two
 *     routes to the same intent — the chip and the drag — are what remain, and
 *     they are still each other's parity check.
 *
 *  B. Enter in the New-task modal. `enterSubmit` is wired to the title input and
 *     the import-ref input, but not to "Start with (optional)" — the last field
 *     of the same form. Enter there is a dead key while Enter one field up
 *     creates the task (the contract #311 hardened) (#1103).
 *
 * Account-independent: `tasks:create` / `tasks:update` IPC, no agent. The live
 * guards hold before AND after a fix; the two `fixme` tripwires flip green when
 * the issues land.
 */

test.afterAll(() => {
  // Best-effort: the app provisions `.claude/` + the `flow` symlink into a fresh
  // root, so the rm can race those writes (ENOTEMPTY). A leftover temp dir must
  // not fail a run whose assertions all passed.
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
      }): Promise<
        Array<{
          id: string;
          title: string;
          lane: string;
          suggestDone?: boolean;
        }>
      >;
      create(r: {
        projectRoot: string;
        title: string;
      }): Promise<{ id: string }>;
      update(r: {
        taskId: string;
        patch: Record<string, unknown>;
      }): Promise<unknown>;
    };
  };
};

const laneCounts = (win: Page) =>
  win
    .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
    .allTextContents();
const boardChip = (win: Page) => win.locator('.fl-board-badge-suggest');

/** The task's row in the store — the source of truth for lane + suggestion. */
async function storedTask(
  win: Page,
  root: string,
  title: string
): Promise<{ id: string; lane: string; suggestDone?: boolean }> {
  return win.evaluate(
    async ({ p, t }) => {
      const api = (window as unknown as TasksBridge).flow.tasks;
      const list = await api.list({ projectRoot: p, includeArchived: false });
      const task = list.find((x) => x.title === t);
      if (!task) throw new Error(`task ${t} not found`);
      return { id: task.id, lane: task.lane, suggestDone: task.suggestDone };
    },
    { p: root, t: title }
  );
}

/** Seed a project + one task the agent has flagged as probably-done, board open. */
async function seedSuggestedTask(window: Page, title: string): Promise<string> {
  const root = await seedProject(window, 'flow-ux-suggest-');
  await activateProject(window, root);
  await window.evaluate(
    async ({ p, t }) => {
      const api = (window as unknown as TasksBridge).flow.tasks;
      const task = await api.create({ projectRoot: p, title: t });
      // What a clean agent turn does (task-service `makeOnTurnComplete`).
      await api.update({ taskId: task.id, patch: { suggestDone: true } });
    },
    { p: root, t: title }
  );

  await window
    .locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]')
    .click();
  await expect(window.locator('.fl-board-columns')).toBeVisible({
    timeout: 8000,
  });
  await expect
    .poll(() => laneCounts(window), { timeout: 8000 })
    .toEqual(['1', '0', '0', '0', '0']);
  await expect(boardChip(window)).toHaveText('Done?');
  return root;
}

/** Uncaught-error capture; the board's own diagnostics are console.error by design. */
function watchErrors(window: Page): string[] {
  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  window.on('console', (m) => {
    if (
      m.type() === 'error' &&
      !/Canceled|failed to (load|move|generate)/i.test(m.text())
    ) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  return errors;
}

test.describe('tasks board — affordance parity', () => {
  test('the board CAN accept the suggestion — by dragging the card to Done', async ({
    window,
  }) => {
    const errors = watchErrors(window);
    const root = await seedSuggestedTask(window, 'Drag accept task');

    // The board's working path for the same intent (native HTML5 DnD).
    await window.evaluate(() => {
      const card = document.querySelector('.fl-board-card') as HTMLElement;
      // [todo, doing, blocked, done] — Done is the LAST lane, not the third.
      const lanes = document.querySelectorAll(
        '.fl-board-column:not(.fl-board-remote) .fl-board-cards'
      );
      const done = lanes[lanes.length - 1] as HTMLElement;
      const dt = new DataTransfer();
      card.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })
      );
      done.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, dataTransfer: dt })
      );
      done.dispatchEvent(
        new DragEvent('drop', { bubbles: true, dataTransfer: dt })
      );
      card.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, dataTransfer: dt })
      );
    });

    await expect
      .poll(() => laneCounts(window), { timeout: 8000 })
      .toEqual(['0', '0', '0', '0', '1']);
    await expect
      .poll(
        async () => (await storedTask(window, root, 'Drag accept task')).lane,
        { timeout: 8000 }
      )
      .toBe('done');
    expect(
      (await storedTask(window, root, 'Drag accept task')).suggestDone
    ).toBeFalsy();
    await expect(boardChip(window)).toHaveCount(0);

    expect(errors, errors.join(', ')).toEqual([]);
  });

  test('Enter in the New-task TITLE field creates the task (#311 contract)', async ({
    window,
  }) => {
    const errors = watchErrors(window);
    const root = await seedProject(window, 'flow-ux-enter-');
    await activateProject(window, root);
    await window
      .locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]')
      .click();
    await expect(window.locator('.fl-board-columns')).toBeVisible({
      timeout: 8000,
    });

    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click();
    await expect(window.locator('.fl-board-modal')).toBeVisible();
    const title = window
      .locator('.fl-board-modal-body input[type="text"]')
      .first();
    await title.fill('Enter from title');
    await title.press('Enter');

    await expect(window.locator('.fl-board-modal')).toBeHidden({
      timeout: 10_000,
    });
    await expect
      .poll(
        async () => (await storedTask(window, root, 'Enter from title')).lane,
        { timeout: 8000 }
      )
      .toBe('todo');

    expect(errors, errors.join(', ')).toEqual([]);
  });

  // ── Former tripwires — now the fixed contract (#1102 / #1103) ──────────────

  test('clicking the board "Done?" chip accepts the suggestion, like the sidebar (#1102)', async ({
    window,
  }) => {
    const root = await seedSuggestedTask(window, 'Board chip task');

    await boardChip(window).click();
    await window.waitForTimeout(1000);

    const task = await storedTask(window, root, 'Board chip task');
    expect(
      task.lane,
      'the board\'s "Done?" chip looks exactly like the sidebar\'s accept button but ' +
        'falls through to the card — the detail modal opens and the suggestion is untouched'
    ).toBe('done');
    expect(task.suggestDone).toBeFalsy();
    // …and the chip's own gesture wins: it must not ALSO open the detail modal.
    await expect(window.locator('.fl-board-detail')).toHaveCount(0);
  });

  test('Enter in "Start with" submits the New-task form, like Enter in the title (#1103)', async ({
    window,
  }) => {
    const root = await seedProject(window, 'flow-ux-enter2-');
    await activateProject(window, root);
    await window
      .locator('.fl-editor-actions .fl-rail-item[aria-label="Tasks"]')
      .click();
    await expect(window.locator('.fl-board-columns')).toBeVisible({
      timeout: 8000,
    });

    await window.locator('.fl-board-lane-btn[aria-label="New task"]').click();
    await expect(window.locator('.fl-board-modal')).toBeVisible();
    await window
      .locator('.fl-board-modal-body input[type="text"]')
      .first()
      .fill('Enter from start');
    const start = window.locator(
      '.fl-board-modal input[list="fl-flow-commands"]'
    );
    await start.fill('/review-pr');
    await start.press('Enter');
    await window.waitForTimeout(1500);

    await expect(
      window.locator('.fl-board-modal'),
      'Enter is a dead key in "Start with" — the same keystroke one field up creates the task'
    ).toBeHidden({ timeout: 5000 });
    // The task really exists. Its lane is NOT pinned to 'todo' the way the
    // title-field control's is: "Start with" auto-sends its command as the
    // task's first message, and a started turn legitimately nudges todo→doing
    // (task-service `makeOnTurnStart`). What matters here is that the keystroke
    // created the task at all.
    expect(['todo', 'doing']).toContain(
      (await storedTask(window, root, 'Enter from start')).lane
    );
  });
});
