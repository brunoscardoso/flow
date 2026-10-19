/**
 * UX sweep — flow `tasks` (rotation index 9, round 23): the TASK LIFECYCLE — the
 * two menu items that take a task OUT of the board, which 35+ prior flow-9 specs
 * never clicked.
 *
 * Every existing tasks spec drives creation (the board modal's tabs/fields/drafts
 * #412/#442/#443/#561/#830/#996/#1103, the sidebar popover #1343/#1344, imports
 * #709/#731), movement (drag persist, the Done roundtrip, the lane menu and the
 * detail Status row #1153/#1299/#1300, the background re-sort #1192, the silent
 * failed move #1193) or the detail modal (scroll #204, file links #961, briefs
 * #1026). Removal is the one direction nobody drove: `task-archive-keeps-thread`
 * archives, but only to assert the THREAD survives — it never asks what happened
 * to the task, and nothing anywhere clicks "Delete task + thread".
 *
 * The board itself has no removal affordance at all (census: header = Integrations
 * / + New task; card menu = the three lanes; detail modal = lane buttons, brief,
 * Close, Open chat). The whole app's only route is the thread sidebar's task-row
 * ⋯ menu: Move to ×3 · Pin · Rename · Archive · Delete task + thread. Both of its
 * exits are unsafe, in opposite directions:
 *
 *  A. DELETE HAS NO CONFIRMATION (thread-sidebar.ts:2350-2356 → `#deleteTask`
 *     straight to `tasks:delete`). One click destroys the task AND its 1:1
 *     conversation — no prompt, no toast, no undo. The strictly SMALLER sibling
 *     one row down the same menu, a plain thread's "Delete", swaps in an in-menu
 *     confirmation that names what it is about to destroy and deliberately
 *     focuses Cancel so Enter can't be the destructive answer (#1173,
 *     `#confirmDelete`, thread-sidebar.ts:2179). "Archive" sits directly above
 *     "Delete task + thread" in a 7-item menu.
 *
 *  B. ARCHIVE IS A ONE-WAY TRAPDOOR. `archived: true` hides the task from every
 *     surface — the board and the sidebar both list with `includeArchived: false`,
 *     and those are the app's ONLY two callers — while the record survives with
 *     `archivedAt` set. Nothing in the UI lists archived tasks and nothing ever
 *     writes `archived: false`, so the lane, the brief and the card are gone for
 *     good. The sibling Archive on a plain THREAD, in the same menu, is fully
 *     reversible through the sidebar's expandable "Archived (N)" section (#482).
 *     Worse, the row does not visibly change: the task's bare thread stays in the
 *     list under the same title, so the sidebar reads "nothing happened" while the
 *     board's Todo lane drops to "Nothing here yet".
 *
 * Live guards + two tripwires, all account-independent (tasks/threads IPC only,
 * no agent, no network) and deterministic.
 */
import { test, expect, type Page } from '../fixtures/electron';
import { sel, statusButtonByText } from '../selectors';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeDirective } from './fixtures/loops';
import { join } from 'node:path';

const SHOTS = join(__dirname, '__screens');
const TASK = 'Rotate the API keys';

test.afterAll(() => {
  try {
    cleanupSeeds();
  } catch {
    /* temp dirs are OS-cleaned */
  }
});

interface TaskRow {
  id: string;
  title: string;
  archivedAt: string | null;
}

/** Seed a project + one manual task, and open the board on it. */
async function seedBoardWithTask(win: Page, prefix: string): Promise<string> {
  const root = await seedProject(win, prefix);
  // A LIST, WRITTEN BEFORE THE BOARD IS EVER READ. Todo's empty state has two
  // sentences — "Nothing here yet" when a list exists and is clear, and the
  // set-up panel when the project has no list at all — and which one a seeded
  // project gets was decided by whether the IDE's background provisioner had
  // finished writing `loops/` yet. That is a race, not a precondition, so this
  // states the precondition instead.
  writeDirective(root, { loop: 'fix', engine: 'consumer', mission: 'Drain' });
  await activateProject(win, root);
  await win.evaluate(
    async (a) => {
      await (
        window as unknown as {
          flow: {
            tasks: {
              create(x: {
                projectRoot: string;
                title: string;
              }): Promise<unknown>;
            };
          };
        }
      ).flow.tasks.create({ projectRoot: a.root, title: a.title });
    },
    { root, title: TASK }
  );
  await win.locator(statusButtonByText('Tasks')).click();
  await expect(win.locator(sel.board)).toBeVisible();
  await expect(win.locator('.fl-board-card', { hasText: TASK })).toBeVisible({
    timeout: 8000,
  });
  await expect
    .poll(
      () =>
        win
          .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
          .allTextContents(),
      { timeout: 8000 }
    )
    .toEqual(['1', '0', '0', '0', '0']);
  return root;
}

/** Tasks as the STORE has them — `includeArchived` decides whether hidden ones show. */
async function storeTasks(
  win: Page,
  root: string,
  includeArchived: boolean
): Promise<TaskRow[]> {
  return win.evaluate(
    async (a) =>
      (
        window as unknown as {
          flow: {
            tasks: {
              list(x: {
                projectRoot: string;
                includeArchived: boolean;
              }): Promise<TaskRow[]>;
            };
          };
        }
      ).flow.tasks.list({ projectRoot: a.root, includeArchived: a.inc }),
    { root, inc: includeArchived }
  );
}

/** Open the ⋯ menu for a sidebar row by right-clicking its title. */
async function openRowMenu(win: Page, title: string) {
  const row = win
    .locator('.fl-thread-sidebar')
    .getByText(title, { exact: true })
    .first();
  await expect(row).toBeVisible({ timeout: 8000 });
  await row.click({ button: 'right' });
  const menu = win.locator('.fl-thread-menu');
  await expect(menu).toBeVisible();
  return menu;
}

// ── Live guards ─────────────────────────────────────────────────────────────

test('the task row menu is the only removal route, and it really acts on the board', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(String(e)));

  const root = await seedBoardWithTask(window, 'flow-task-life-census-');

  // The BOARD's complete affordance set for a task: the lane heads, the card
  // context menu, the detail modal. None of it removes, renames or archives
  // anything.
  //
  // THERE IS NO HEADER ROW ANY MORE (2026-09-04). The board's two verbs live on
  // Todo's own column head — a play for the loop and a `+` for a new task — and
  // Integrations moved to the app's settings. The census is the same census;
  // it just reads the place the controls actually are.
  const laneControls = await window
    .locator('.fl-board-lane-btn')
    .evaluateAll((els) =>
      els
        .map((el) => el.getAttribute('aria-label') ?? '')
        // THE REMOTE TOGGLE IS NOT PART OF THIS CENSUS, twice over: it is not
        // about a task (it reveals what a tracker says is assigned to you), and
        // whether it exists depends on the MACHINE — a developer with `gh` logged
        // in has GitHub connected and one without does not, so counting it would
        // make this assertion pass or fail on somebody's shell history.
        .filter((label) => !label.includes('assigned to you'))
        // NOR THE PER-LANE MINIMIZE CONTROLS (#1902). Every lane head carries a
        // fold/unfold button ("Minimize/Expand <lane> column"); it is a view
        // preference, not a task affordance — the same reason the remote toggle
        // is excluded — so it does not belong in a census of what can act on a task.
        .filter((label) => !/^(Minimize|Expand) .+ column$/.test(label))
    );
  // The Todo head's play button names its own state: this project has no card
  // ticked for the board's loop, so there is nothing for it to start and it
  // says that rather than offering a press that cannot act.
  expect(laneControls).toEqual(['Nothing is set to be worked', 'New task']);

  const card = window.locator('.fl-board-card', { hasText: TASK });
  await card.click({ button: 'right' });
  const cardMenu = window.locator('.fl-board-menu');
  await expect(cardMenu).toBeVisible();
  // THE CENSUS INCLUDES THE TWO DESTRUCTIVE ITEMS, because the board grew them
  // (#1390) and the two tests below this one are about them. This assertion
  // listed only the four lane moves and had been UNREACHABLE — the header
  // census above it failed first, from the day the toolbar was removed — so it
  // went on describing a menu that had not existed for a while. A census that
  // cannot run is not a census.
  await expect(cardMenu.locator('.fl-board-menu-item')).toHaveText([
    '● Move to Todo',
    'Move to Doing',
    'Move to Blocked',
    'Move to Review',
    'Move to Done',
    'Archive',
    'Delete task + thread',
  ]);
  await window.screenshot({ path: join(SHOTS, 'tasks-board-card-menu.png') });
  await window.keyboard.press('Escape');
  await expect(cardMenu).toBeHidden();

  await card.click();
  const modal = window.locator('.fl-board-detail');
  await expect(modal).toBeVisible();
  // Same stale-census story as the card menu above: the detail modal grew the
  // two destructive actions with #1390 and this line was unreachable behind the
  // header assertion, so it went on describing a modal that had two fewer
  // buttons than the one on screen.
  await expect(modal.locator('.fl-board-modal-actions button')).toHaveText([
    'Delete task + thread',
    'Archive',
    'Close',
    'Open chat',
  ]);
  await window.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  // The sidebar row carries the whole lifecycle vocabulary the board lacks…
  const menu = await openRowMenu(window, TASK);
  // #1516: this census predates #1413, which added "Add folder to context…" to
  // the task row's menu — the row that grants an agent read/write over extra
  // repos finally offering the verb to review it. The list was simply out of
  // date, and because toHaveText retries, a background re-render closed the menu
  // before the timeout and the failure reported an EMPTY array, which reads like
  // "the menu never opened" rather than "one item was added".
  await expect(menu.locator('.fl-thread-menu-item')).toHaveText([
    '● Move to Todo',
    'Move to Doing',
    'Move to Blocked',
    'Move to Review',
    'Move to Done',
    'Pin',
    'Rename',
    'Add folder to context…',
    'Archive',
    'Delete task + thread',
  ]);
  await window.screenshot({ path: join(SHOTS, 'tasks-sidebar-row-menu.png') });

  // …and its Delete is real: one click and the card is gone from the board and
  // the task from the store. (This is the LIVE half of tripwire A — the tripwire
  // asks for a confirmation step, not for the action to stop working.)
  await menu
    .locator('.fl-thread-menu-item', { hasText: 'Delete task + thread' })
    .click();
  // #1516: that item no longer deletes — it swaps the menu for a named confirm
  // (#1173, #1390), the same gate #1501 found this suite predating elsewhere.
  // Click through it, which is what a user does.
  const confirm = window.locator('.fl-thread-menu-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(TASK);
  await menu
    .locator('.fl-thread-menu-item', { hasText: 'Delete both' })
    .click();
  await expect
    .poll(
      () =>
        window
          .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
          .allTextContents(),
      { timeout: 8000 }
    )
    .toEqual(['0', '0', '0', '0', '0']);
  await expect
    .poll(async () => (await storeTasks(window, root, true)).length, {
      timeout: 8000,
    })
    .toBe(0);

  expect(errors, errors.join(', ')).toHaveLength(0);
});

test('a plain thread — the smaller sibling in the same menu — confirms before deleting', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(String(e)));

  const root = await seedProject(window, 'flow-task-life-thread-');
  writeDirective(root, { loop: 'fix', engine: 'consumer', mission: 'Drain' });
  await activateProject(window, root);
  await window.evaluate(
    async (a) => {
      await (
        window as unknown as {
          flow: {
            threads: {
              create(x: {
                projectRoot: string;
                title: string;
              }): Promise<unknown>;
            };
          };
        }
      ).flow.threads.create({ projectRoot: a.root, title: a.title });
    },
    { root, title: 'Plain chat' }
  );

  const menu = await openRowMenu(window, 'Plain chat');
  await menu.locator('.fl-thread-menu-item', { hasText: /^Delete$/ }).click();

  // The menu body swaps to a worded confirmation — the mechanism this exact menu
  // already owns, and the one the bigger "Delete task + thread" never reaches.
  const confirm = menu.locator('.fl-thread-menu-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Delete this thread?');
  // Enter must not be the destructive answer (#1173) — Cancel holds focus.
  expect(
    await window.evaluate(() => document.activeElement?.textContent?.trim())
  ).toBe('Cancel');
  await menu.locator('.fl-thread-menu-item', { hasText: 'Cancel' }).click();

  // Cancelling leaves the thread alive.
  await expect(
    window
      .locator('.fl-thread-sidebar')
      .getByText('Plain chat', { exact: true })
  ).toBeVisible();

  expect(errors, errors.join(', ')).toHaveLength(0);
});

test('archiving a task hides it from the board while the record survives', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(String(e)));

  const root = await seedBoardWithTask(window, 'flow-task-life-arch-');

  const menu = await openRowMenu(window, TASK);
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click();

  // Gone from the board — every lane empty.
  await expect
    .poll(
      () =>
        window
          .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
          .allTextContents(),
      { timeout: 8000 }
    )
    .toEqual(['0', '0', '0', '0', '0']);
  await expect(
    window
      .locator('.fl-board-column:not(.fl-board-remote) .fl-board-cards')
      .first()
  ).toContainText('Nothing here yet');

  // But NOT deleted: the record is still there behind `includeArchived`, with
  // its lane and title intact. Nothing about this is data loss — it is purely
  // unreachable (which is what tripwire B is about).
  expect(await storeTasks(window, root, false)).toEqual([]);
  const archived = await storeTasks(window, root, true);
  expect(archived).toHaveLength(1);
  expect(archived[0]?.title).toBe(TASK);
  expect(archived[0]?.archivedAt).toBeTruthy();

  // #1516: the record is still reachable, but not where this test used to look.
  // #1391 gave archived tasks a home — the collapsed "Archived" drawer — so the
  // row is no longer among the live rows; asserting it there was asserting the
  // pre-#1391 sidebar. Expand the drawer and it is exactly where it should be,
  // once (the one-row contract #1467 restored).
  //
  // The drawer's control moved into the list's "Sort and filter" menu (its
  // "Archived (N)" row); pressing it shows the archived rows in the list.
  await window.locator('[aria-label="Sort and filter threads"]').click();
  const archivedDrawer = window.locator('.fl-thread-menu-item', { hasText: /Archived \(1\)/ });
  await expect(archivedDrawer).toBeVisible({ timeout: 8000 });
  await archivedDrawer.first().click();
  await expect(
    window.locator('.fl-thread-sidebar').getByText(TASK, { exact: true })
  ).toHaveCount(1);
  await window.screenshot({ path: join(SHOTS, 'tasks-archived-vanished.png') });

  expect(errors, errors.join(', ')).toHaveLength(0);
});

// ── Tripwires ───────────────────────────────────────────────────────────────

test('#1390 — "Delete task + thread" asks before destroying a task and its conversation', async ({
  window,
}) => {
  const root = await seedBoardWithTask(window, 'flow-task-life-trip-a-');
  const menu = await openRowMenu(window, TASK);

  await menu
    .locator('.fl-thread-menu-item', { hasText: 'Delete task + thread' })
    .click();

  // A destructive click on the biggest blast radius in this menu must reach a
  // confirmation step, exactly like the smaller sibling "Delete" does — and
  // nothing may be destroyed before it is answered.
  await expect(menu.locator('.fl-thread-menu-confirm')).toBeVisible({
    timeout: 2000,
  });
  expect(await storeTasks(window, root, true)).toHaveLength(1);
});

test.fixme('#1391 — an archived task can be found and restored from the UI', async ({
  window,
}) => {
  const root = await seedBoardWithTask(window, 'flow-task-life-trip-b-');
  const menu = await openRowMenu(window, TASK);
  await menu.locator('.fl-thread-menu-item', { hasText: /^Archive$/ }).click();
  await expect
    .poll(
      () =>
        window
          .locator('.fl-board-column:not(.fl-board-remote) .fl-board-count')
          .allTextContents(),
      { timeout: 8000 }
    )
    .toEqual(['0', '0', '0', '0', '0']);

  // Non-vacuous: the task is still in the store, so this asks for a route to
  // something that demonstrably exists.
  expect(await storeTasks(window, root, true)).toHaveLength(1);

  // Somewhere the user can reach — the board or the sidebar — must offer archived
  // tasks (the "Archived (N)" section threads have had since #482, a board filter,
  // an Unarchive item, anything).
  const said = (
    (await window.locator(sel.board).innerText()) +
    '\n' +
    (await window.locator('.fl-thread-sidebar').innerText())
  ).toLowerCase();
  expect(
    /archiv/.test(said),
    `no surface offers a way back to an archived task:\n${said}`
  ).toBe(true);
});
