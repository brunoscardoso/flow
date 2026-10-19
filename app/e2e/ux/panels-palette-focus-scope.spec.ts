import { test, expect } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import type { Page } from '@playwright/test';

/**
 * UX regression probe — flow 12 (panel toggles & keyboard shortcuts), round 20:
 * the ⌘P COMMAND PALETTE as an input path into the focus-mode swallow rule.
 *
 * `shell.ts` documents that rule as living in ONE code path
 * (`swallowedByFocusMode()`, allowed-pattern #14): "focus mode (⌘⌥Z) is a pure
 * overlay — no panel or sidebar can render under it, so a panel-visibility
 * mutation from ANY input path (⌘B, ⌘1-3, ⌘⌥C/⌘⌥D, the titlebar sidebar button,
 * a rail item click) would only rewrite the layout the user gets back on exit,
 * invisibly and silently. Every such mutator asks this before acting, so the
 * rule can't drift per input device."
 *
 * Five prior flow-12 rounds proved that list one device at a time — #836 (⌘B
 * keyboard), #968 (the titlebar button, the mouse path of #836), #924 (⌘1-3 and
 * the rail icons), #967 (⌘⌥C/⌘⌥D). Every one of them drove a SHORTCUT or a
 * chrome button. Nobody drove the palette — the app's *discoverable* command
 * surface, which is reachable under focus mode (⌘P is above the modal guard,
 * and focus mode is not a modal) and dispatches the exact same panel-mutating
 * CustomEvents the guarded paths do.
 *
 * The rule did drift there (#1201). `flow:reveal-sidebar` (shell.ts ~538 — the palette's
 * "Reveal Sidebar" command, and what "New thread" fires) is the one panel
 * mutator that never asks `swallowedByFocusMode()`: it force-sets
 * `sidebarOpen = true`, force-switches `activeRailItem` to 'threads', and
 * `saveActive()`s that behind the overlay. Under focus mode the palette closes
 * on Enter, absolutely nothing appears on screen — and the sidebar the user
 * gets back on exit is not the one they left.
 *
 * The live `test`s below pin what `main` does today (the healthy normal-layout
 * baseline, the guarded siblings that correctly stay inert, and the measured
 * leak). The `test.fixme` states the expected behavior and fails on `main` —
 * flip it live with the fix.
 */

const SCREENS = 'e2e/ux/__screens';

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled');
}

/** What the user can actually SEE of the activity sidebar. Focus mode removes
 *  the wrapper from the root split entirely, so presence is the observable —
 *  far stronger than a CSS class. */
async function sidebarState(
  win: Page
): Promise<{
  wrapper: boolean;
  activeRail: string | null;
  pane: string | null;
}> {
  return win.evaluate(() => {
    const wrapper = document.querySelector('.fl-activity-sidebar');
    const active = document.querySelector(
      '.fl-activity-bar [data-rail-item].active'
    );
    const pane = Array.from(
      document.querySelectorAll<HTMLElement>('.fl-sidebar-pane')
    ).find((p) => p.style.display !== 'none' && p.offsetParent !== null);
    return {
      wrapper: !!wrapper && !!(wrapper as HTMLElement).offsetParent,
      activeRail: active?.getAttribute('data-rail-item') ?? null,
      pane: pane?.className ?? null,
    };
  });
}

/** True while the focus-mode overlay owns the window (the exit pill is shown). */
async function inFocusMode(win: Page): Promise<boolean> {
  return win.locator('.fl-focus-hint').isVisible();
}

/** Open ⌘P, run the command whose label matches exactly, and wait for the
 *  palette to close (the palette closes itself on activate). */
async function runPaletteCommand(win: Page, label: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+p');
  const palette = win.locator('.fl-palette-panel');
  await palette.waitFor({ state: 'visible', timeout: 5000 });
  const input = win.locator('.fl-palette-input');
  await input.fill(`>${label}`);
  // The ranker keeps registry order; the exact label sorts first for a full
  // typed query. Assert the selected row IS the one we asked for before Enter,
  // so a ranking change can never silently run a different command.
  const first = win.locator('.fl-palette-row').first();
  await expect(first).toContainText(label, { timeout: 5000 });
  await win.keyboard.press('Enter');
  await palette
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => undefined);
  await win.waitForTimeout(400);
}

/** Enter focus mode and wait for the overlay to settle. */
async function enterFocusMode(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+Alt+z');
  await expect(win.locator('.fl-focus-hint')).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(300);
}

/** Leave focus mode via the exit pill (the mouse path — Escape is #1161's). */
async function exitFocusMode(win: Page): Promise<void> {
  await win.locator('.fl-focus-hint').click();
  await expect(win.locator('.fl-focus-hint')).toBeHidden({ timeout: 5000 });
  await win.waitForTimeout(400);
}

/** Make `item` the open sidebar pane. Idempotent: re-clicking the ACTIVE rail
 *  item collapses the sidebar (shell.ts `onRailSelect`), so only click when the
 *  item isn't already the shown one. */
async function selectRail(win: Page, item: string): Promise<void> {
  const state = await sidebarState(win);
  if (state.activeRail === item && state.wrapper) return;
  await win.locator(`.fl-activity-bar [data-rail-item="${item}"]`).click();
  await win.waitForTimeout(400);
}

test.afterAll(() => cleanupSeeds());

test.describe('flow 12 — palette commands vs focus mode', () => {
  test('baseline: "Reveal Sidebar" from the palette works in the normal layout', async ({
    window: win,
  }) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    const root = await seedProject(win, 'flow-ux-palette-focus-');
    await activateProject(win, root);

    // Hide the sidebar the ordinary way, then bring it back from the palette.
    await win.keyboard.press('ControlOrMeta+b');
    await win.waitForTimeout(400);
    expect((await sidebarState(win)).wrapper).toBe(false);

    await runPaletteCommand(win, 'Reveal Sidebar');

    const after = await sidebarState(win);
    expect(after.wrapper).toBe(true);
    expect(after.activeRail).toBe('threads');
    expect(appErrors(errors)).toEqual([]);
  });

  test('guarded siblings stay inert under focus mode (#836/#924/#967/#968)', async ({
    window: win,
  }) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    const root = await seedProject(win, 'flow-ux-palette-focus-');
    await activateProject(win, root);
    await selectRail(win, 'files');
    const before = await sidebarState(win);
    expect(before.wrapper).toBe(true);
    expect(before.activeRail).toBe('files');

    await enterFocusMode(win);
    expect((await sidebarState(win)).wrapper).toBe(false);

    // Every guarded input path: the ⌘B shortcut, ⌘1-3 rail digits, the titlebar
    // button. All must be no-ops that leave the restored layout untouched.
    await win.keyboard.press('ControlOrMeta+b');
    await win.keyboard.press('ControlOrMeta+1');
    await win.keyboard.press('ControlOrMeta+3');
    await win
      .locator('.fl-titlebar-icon[title^="Toggle sidebar"]')
      .first()
      .click();
    await win.waitForTimeout(400);
    expect(await inFocusMode(win)).toBe(true);

    await exitFocusMode(win);
    const after = await sidebarState(win);
    expect(after.wrapper).toBe(true);
    expect(after.activeRail).toBe('files'); // exactly as the user left it
    expect(appErrors(errors)).toEqual([]);
  });

  test('palette "Reveal Sidebar" exits focus mode and shows the sidebar you had (#1201)', async ({
    window: win,
  }) => {
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    const root = await seedProject(win, 'flow-ux-palette-focus-');
    await activateProject(win, root);
    await selectRail(win, 'files');
    expect((await sidebarState(win)).activeRail).toBe('files');

    await enterFocusMode(win);
    const hidden = await sidebarState(win);
    expect(hidden.wrapper).toBe(false);
    await win.screenshot({
      path: `${SCREENS}/panels-palette-focus-01-focus.png`,
    });

    // The user reaches for the discoverable surface instead of the shortcut.
    await runPaletteCommand(win, 'Reveal Sidebar');

    // #1201 (fixed): the command does what it says. It used to do nothing
    // visible while rewriting the layout behind the overlay — so focus mode is
    // left FIRST (the honest toggle ⌃` already uses for the hidden editor)…
    expect(await inFocusMode(win)).toBe(false);
    const after = await sidebarState(win);
    expect(after.wrapper).toBe(true);
    // …and the user's own rail selection survives: it used to be silently
    // replaced by Threads, and persisted, so it outlived a restart.
    expect(after.activeRail).toBe('files');
    await win.screenshot({
      path: `${SCREENS}/panels-palette-focus-02-revealed.png`,
    });
    expect(appErrors(errors)).toEqual([]);
  });

  test('EXPECTED: palette "Reveal Sidebar" must not rewrite the sidebar behind focus mode', async ({
    window: win,
  }) => {
    const root = await seedProject(win, 'flow-ux-palette-focus-');
    await activateProject(win, root);
    await selectRail(win, 'files');

    await enterFocusMode(win);
    await runPaletteCommand(win, 'Reveal Sidebar');
    // Since #1201 the command leaves focus mode itself (the test above), so the
    // exit pill is only there to press if it swallowed the command instead.
    if (await inFocusMode(win)) await exitFocusMode(win);

    // Either the command is swallowed like every other panel mutator, or it
    // exits focus mode so the reveal is actually visible. What it must never
    // do is silently discard the user's rail selection.
    const after = await sidebarState(win);
    expect(after.activeRail).toBe('files');
  });
});
