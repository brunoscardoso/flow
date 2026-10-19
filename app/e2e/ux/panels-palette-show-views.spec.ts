import { test, expect } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * UX regression probe — flow 12 (panel toggles & keyboard shortcuts), round 20,
 * second seam: the ⌘P palette's "Show Git" / "Show Review" commands.
 *
 * Every other navigational command in `PALETTE_COMMAND_SPECS` REVEALS its
 * surface before acting — that is the lesson #1057 (`flow:show-editor` reveals a
 * ⌘⌥D-hidden editor) and #1071 (`flow:show-chat` reveals a ⌘⌥C-hidden chat)
 * bought, and it is why "New terminal" maps to `flow:show-terminal` rather than
 * `flow:terminal-new` ("otherwise the shell starts but stays hidden", per the
 * registry's own comment).
 *
 * `flow:show-git` / `flow:show-review` never got that treatment (#1202). Their only
 * listeners (`shell.ts` ~178/~181, commented "kept for compatibility with agents
 * that dispatch these events") call `setViewMode()` on the Source Control pane
 * and nothing else — they do not open a closed sidebar and do not switch the
 * activity rail to `source-control`. The app's DEFAULT rail item is Threads, so
 * running either command from a stock window changes a toggle inside a pane the
 * user cannot see: the palette closes and the screen is identical.
 *
 * The live `test`s pin what `main` does today (the working path when Source
 * Control already happens to be open, and the measured dead click otherwise).
 * The `test.fixme` states the expected behavior and fails on `main` — flip it
 * live with the fix.
 */

const SCREENS = 'e2e/ux/__screens';

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled');
}

/** What the user can SEE: which rail item is active, whether the sidebar is on
 *  screen, and which Source Control view mode the visible pane is showing. */
async function viewState(
  win: Page
): Promise<{
  sidebar: boolean;
  rail: string | null;
  scVisible: boolean;
  mode: string | null;
}> {
  return win.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('.fl-activity-sidebar');
    const active = document.querySelector(
      '.fl-activity-bar [data-rail-item].active'
    );
    const sc = document.querySelector<HTMLElement>('.fl-sc-body');
    const activeBtn = Array.from(
      document.querySelectorAll<HTMLElement>('.fl-sc-body button')
    ).find((b) => b.classList.contains('active'));
    return {
      sidebar: !!wrapper && !!wrapper.offsetParent,
      rail: active?.getAttribute('data-rail-item') ?? null,
      scVisible: !!sc && sc.style.display !== 'none' && !!sc.offsetParent,
      mode: activeBtn?.textContent?.trim() ?? null,
    };
  });
}

/** Open ⌘P in command mode and run the command with this exact label. */
async function runPaletteCommand(win: Page, label: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+p');
  const palette = win.locator('.fl-palette-panel');
  await palette.waitFor({ state: 'visible', timeout: 5000 });
  await win.locator('.fl-palette-input').fill(`>${label}`);
  const first = win.locator('.fl-palette-row').first();
  await expect(first).toContainText(label, { timeout: 5000 });
  await win.keyboard.press('Enter');
  await palette
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => undefined);
  await win.waitForTimeout(400);
}

/** Make `item` the open sidebar pane. Idempotent: re-clicking the ACTIVE rail
 *  item collapses the sidebar (shell.ts `onRailSelect`), so only click when the
 *  item isn't already the shown one. */
async function selectRail(win: Page, item: string): Promise<void> {
  const state = await viewState(win);
  if (state.rail === item && state.sidebar) return;
  await win.locator(`.fl-activity-bar [data-rail-item="${item}"]`).click();
  await win.waitForTimeout(400);
}

test.afterAll(() => cleanupSeeds());

test.describe('flow 12 — palette "Show Git" / "Show Review"', () => {
  test('works when Source Control is already the open pane', async ({
    window: win,
  }) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    const root = await seedProject(win, 'flow-ux-palette-views-', (dir) => {
      writeFileSync(join(dir, 'seed.txt'), 'hello\n');
    });
    await activateProject(win, root);
    await selectRail(win, 'source-control');

    const open = await viewState(win);
    expect(open.scVisible).toBe(true);

    await runPaletteCommand(win, 'Show Review');
    expect((await viewState(win)).mode).toBe('Phases');

    await runPaletteCommand(win, 'Show Git');
    expect((await viewState(win)).mode).toBe('Changes');

    expect(appErrors(errors)).toEqual([]);
  });

  test('"Show Git" surfaces Source Control from the default (Threads) rail (#1202)', async ({
    window: win,
  }) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    const root = await seedProject(win, 'flow-ux-palette-views-', (dir) => {
      writeFileSync(join(dir, 'seed.txt'), 'hello\n');
    });
    await activateProject(win, root);
    await selectRail(win, 'threads');

    const before = await viewState(win);
    expect(before.sidebar).toBe(true);
    expect(before.rail).toBe('threads');
    expect(before.scVisible).toBe(false);
    await win.screenshot({
      path: `${SCREENS}/panels-palette-showgit-01-before.png`,
    });

    await runPaletteCommand(win, 'Show Git');

    // #1202 (fixed): the command reveals its surface, like every other
    // navigational command does. It used to leave the screen byte-for-byte
    // identical — a toggle flipped inside a pane the user could not see.
    const after = await viewState(win);
    expect(after.rail).toBe('source-control');
    expect(after.scVisible).toBe(true);
    await win.screenshot({
      path: `${SCREENS}/panels-palette-showgit-02-revealed.png`,
    });

    // Same for its sibling.
    await runPaletteCommand(win, 'Show Review');
    expect((await viewState(win)).rail).toBe('source-control');
    expect(appErrors(errors)).toEqual([]);
  });

  test('"Show Git" re-opens a ⌘B-hidden sidebar (#1202)', async ({
    window: win,
  }) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    const root = await seedProject(win, 'flow-ux-palette-views-');
    await activateProject(win, root);
    await selectRail(win, 'source-control');
    await win.keyboard.press('ControlOrMeta+b');
    await win.waitForTimeout(400);
    expect((await viewState(win)).sidebar).toBe(false);

    await runPaletteCommand(win, 'Show Git');

    // "Reveal Sidebar" / "New terminal" / "Open Blueprint" all surface
    // themselves from this exact state; these two now do too (#1202).
    expect((await viewState(win)).sidebar).toBe(true);
    expect(appErrors(errors)).toEqual([]);
  });

  test('EXPECTED: "Show Git" surfaces the Source Control view from any state', async ({
    window: win,
  }) => {
    const root = await seedProject(win, 'flow-ux-palette-views-');
    await activateProject(win, root);
    await selectRail(win, 'threads');

    await runPaletteCommand(win, 'Show Git');

    const after = await viewState(win);
    expect(after.sidebar).toBe(true);
    expect(after.rail).toBe('source-control');
    expect(after.scVisible).toBe(true);
  });
});
