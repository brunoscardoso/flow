import { test, expect } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * UX sweep — flow 11 (the settings overlays), round 20.
 *
 * RE-AIMED, 2026-09-05. Its subject used to be the app's Settings dialog, which
 * is not a dialog any more: it is a tabbed PAGE in the editor area, so it does
 * not own the keyboard and is not supposed to — ⌘B toggles the sidebar while it
 * is open, because that is what a tab is.
 *
 * The two questions below are still owed by a modal, and this project still has
 * two of them: the per-project FLOW SETTINGS overlay and Integrations. So the
 * guards were pointed at the flow-settings overlay rather than deleted; #1198
 * and #1199 are about modal chrome, and modal chrome is still here.
 *
 * Flow 11 already owns 17 committed specs (accounts add/remove/default/status,
 * per-project binding, every flow-settings toggle + number clamp + text dismiss,
 * external-write reconciliation, write-failure feedback, provisioning). All of
 * them drive a CONTROL INSIDE the panel. None asks the two questions a modal
 * dialog owes the user around its edges:
 *
 *   1. while it is open, does it actually own the keyboard, and
 *   2. when it closes, who gets the keyboard back?
 *
 * Both answers are wrong today, and this spec pins the healthy halves so they
 * cannot regress while #1198/#1199 are open.
 *
 * Live guards (what holds on main):
 *   - the RENDERER-owned shortcuts are correctly inert while the Settings
 *     overlay is up (⌃` opens no terminal, ⌘P opens no palette) — the #525/#1002
 *     "a modal owns the keyboard" invariant, asked of the shared registry;
 *   - the app menu's File ▸ Close Tab (#673) DOES close the active tab when no
 *     modal is open — the feature itself works and must keep working;
 *   - the command palette hands the keyboard back on Escape (#1100's fix): open
 *     from the composer, Escape, keep typing → the text lands in the composer.
 *     This is the sibling-parity control for the settings family below.
 *
 * `test.fixme` tripwires (the two filed defects — #1198 and #1199 — they assert the user-facing
 * outcome, not any particular implementation):
 *   - #1198: File ▸ Close Tab / ⌘W reaches the editor THROUGH an open modal. With a
 *     clean tab it silently closes it behind the backdrop (no toast, overlay
 *     unchanged, so ⌘W reads as a dead key); with a dirty tab it raises an
 *     unrequested "Discard unsaved changes in X?" confirm over the dialog, whose
 *     default button destroys unsaved work in a file the user cannot see.
 *   - #1199: closing the Settings overlay drops keyboard focus on <body> — the very
 *     defect #1100 fixed for the palette, never applied to the settings family.
 */

const SETTINGS_OVERLAY = '.fl-settings-overlay:not([hidden])';
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])';
const SCREENS = 'e2e/ux/__screens';

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled');
}

async function openFile(win: Page, path: string): Promise<void> {
  await win.evaluate(
    (p) =>
      document.dispatchEvent(
        new CustomEvent('flow:open-file-path', { detail: { path: p } })
      ),
    path
  );
}

// #1509: scoped to the EDITOR strip — the docked terminal (#674) mounts its own
// <fl-tabs> asynchronously, so a bare `fl-tabs .tab` count races 3 vs 4.
const EDITOR_TABS = '.fl-shell fl-tabs.fl-editor-tabs .tab';

function tabs(win: Page): Promise<string[]> {
  return win.locator(EDITOR_TABS).allTextContents();
}

/**
 * Open a MODAL from the settings family — the per-project flow settings.
 *
 * NOT THE APP'S SETTINGS, which is the change: that is a tab now, and a tab is
 * not the subject of a question about modal chrome. This is the same overlay
 * class, the same shared guards, and still a dialog.
 */
async function openSettings(win: Page): Promise<void> {
  await win.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:open-flow-settings')),
  );
  await expect(win.locator(SETTINGS_OVERLAY)).toBeVisible();
}

/**
 * Fire the REAL application-menu item behind ⌘W (`File ▸ Close Tab`, menu.ts) —
 * its own `click` handler, from the main process. Native menu key equivalents
 * are not deliverable through Playwright, and the handler resolves
 * `BrowserWindow.getFocusedWindow()`, which is null for a harness window that
 * never takes OS focus; in that case the handler's own body is run against the
 * app window so the renderer sees exactly the message a real ⌘W produces.
 */
async function fireCloseTabMenuItem(app: ElectronApplication): Promise<void> {
  const outcome = await app.evaluate(({ Menu, BrowserWindow }) => {
    const file = (Menu.getApplicationMenu()?.items ?? []).find(
      (m) => m.label === 'File'
    );
    const closeTab = (file?.submenu?.items ?? []).find(
      (s) => s.label === 'Close Tab'
    );
    if (!closeTab) return 'missing';
    const win = BrowserWindow.getAllWindows()[0];
    win?.focus();
    const osFocused = BrowserWindow.getFocusedWindow() !== null;
    closeTab.click(undefined as never, win as never, undefined as never);
    if (!osFocused) win?.webContents.send('editor:closeActiveTab', null);
    return closeTab.accelerator ?? 'no-accelerator';
  });
  // The item must exist and still be the ⌘W binding, or this probe proves nothing.
  expect(outcome).toBe('CmdOrCtrl+W');
}

/** Seed a project with three files and open them all as editor tabs. */
async function seedWithTabs(win: Page): Promise<string> {
  const root = await seedProject(win);
  for (const name of ['notes.md', 'other.md', 'third.md']) {
    writeFileSync(join(root, name), `# ${name}\n`);
  }
  await activateProject(win, root);
  for (const name of ['notes.md', 'other.md', 'third.md']) {
    await openFile(win, join(root, name));
  }
  await expect(win.locator(EDITOR_TABS)).toHaveCount(3);
  return root;
}

test.afterEach(() => cleanupSeeds());

test.describe('flow 11 — a settings modal and the keyboard', () => {
  test('renderer shortcuts are inert while a settings MODAL is open, and Close Tab works without it', async ({
    app,
    window,
  }) => {
    const errors: string[] = [];
    window.on('pageerror', (e) => errors.push(e.message));

    await seedWithTabs(window);
    await openSettings(window);

    // #525/#1002: the panel shortcuts the RENDERER owns must not mutate the
    // layout behind an open modal.
    // #1509: this asserted `.fl-term-root` count 0, which the docked terminal
    // has made impossible since #674 — it is mounted by default, so the count is
    // 1 before a single key is pressed (measured). The assertion could never
    // pass whether or not the shortcut leaked, which is why this test was red on
    // main for reasons that had nothing to do with the behaviour it guards.
    //
    // What "inert" actually means here: the shortcuts must not CHANGE anything.
    const termsBefore = await window.locator('.fl-term-root').count();
    await window.keyboard.press('Control+`');
    await window.keyboard.press('ControlOrMeta+p');
    await window.waitForTimeout(400);
    expect(
      await window.locator('.fl-term-root').count(),
      'Control+` spawned or removed a terminal behind the modal',
    ).toBe(termsBefore);
    // Still exactly one overlay: no palette stacked on top of it.
    await expect(window.locator(ANY_OVERLAY)).toHaveCount(1);
    await expect(window.locator(SETTINGS_OVERLAY)).toBeVisible();
    await window.screenshot({
      path: `${SCREENS}/settings-modal-keyboard-open.png`,
    });

    // Control for the tripwire below: with NO modal open, the app menu's Close
    // Tab closes the active tab — the #673 feature is healthy.
    await window.keyboard.press('Escape');
    await expect(window.locator(SETTINGS_OVERLAY)).toHaveCount(0);
    const before = await tabs(window);
    await fireCloseTabMenuItem(app);
    await expect(window.locator(EDITOR_TABS)).toHaveCount(
      before.length - 1
    );

    expect(appErrors(errors)).toEqual([]);
  });

  test('the command palette hands the keyboard back on Escape (#1100 control)', async ({
    window,
  }) => {
    const root = await seedProject(window);
    await activateProject(window, root);
    await window.evaluate(
      async ({ root, title }) => {
        await (
          window as unknown as {
            flow: {
              threads: {
                create(i: {
                  projectRoot: string;
                  title: string;
                }): Promise<unknown>;
              };
            };
          }
        ).flow.threads.create({ projectRoot: root, title });
      },
      { root, title: 'Palette focus control' }
    );
    await window.getByText('Palette focus control', { exact: true }).click();
    const box = window.locator('.fl-composer textarea').first();
    await expect(box).toBeVisible();

    await box.click();
    await window.keyboard.type('draft one');
    await expect(box).toHaveValue('draft one');

    await window.evaluate(() =>
      document.dispatchEvent(
        new CustomEvent('flow:open-palette', { detail: { mode: 'content' } })
      )
    );
    await expect(window.locator(ANY_OVERLAY)).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(window.locator(ANY_OVERLAY)).toHaveCount(0);

    // The keyboard came back to the composer — typing resumes where it left off.
    await window.keyboard.type(' and two');
    await expect(box).toHaveValue('draft one and two');
  });

  // ── Tripwires for the two filed defects — #1198 and #1199 ────────────────────────────────

  test('#1198: the app menu Close Tab must not reach the editor through an open modal', async ({
    app,
    window,
  }) => {
    await seedWithTabs(window);
    await openSettings(window);
    const before = await tabs(window);

    await fireCloseTabMenuItem(app);
    await window.waitForTimeout(800);

    // Measured on main: the tab is gone, the overlay is untouched, nothing is
    // said. ⌘W looks dead to the user and costs them a tab behind the backdrop.
    expect(await tabs(window)).toEqual(before);
  });

  test('#1198 (dirty): Close Tab through a modal must not raise a discard confirm for a hidden file', async ({
    app,
    window,
  }) => {
    const dialogs: string[] = [];
    window.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await seedWithTabs(window);
    await window.locator('.monaco-editor .view-lines').click();
    await window.keyboard.type('unsaved paragraph ');
    await openSettings(window);

    await fireCloseTabMenuItem(app);
    await window.waitForTimeout(1200);

    // Measured on main: "Discard unsaved changes in third.md?" — a confirm the
    // user never asked for, over the dialog they were looking at, whose default
    // button (Return) destroys the edit unrecoverably.
    expect(dialogs).toEqual([]);
  });

  test('#1199: closing a settings overlay hands the keyboard back to whoever had it', async ({
    window,
  }) => {
    const root = await seedProject(window);
    await activateProject(window, root);
    await window.evaluate(
      async ({ root, title }) => {
        await (
          window as unknown as {
            flow: {
              threads: {
                create(i: {
                  projectRoot: string;
                  title: string;
                }): Promise<unknown>;
              };
            };
          }
        ).flow.threads.create({ projectRoot: root, title });
      },
      { root, title: 'Settings focus' }
    );
    await window.getByText('Settings focus', { exact: true }).click();
    const box = window.locator('.fl-composer textarea').first();
    await box.click();
    await window.keyboard.type('draft one');

    await openSettings(window);
    await window
      .locator('.fl-settings-close[aria-label="Close flow settings"]')
      .click();
    await expect(window.locator(SETTINGS_OVERLAY)).toHaveCount(0);

    // Measured on main: document.activeElement is <body>; these keystrokes and
    // the Enter after them are silently discarded (exactly #1100, unfixed here).
    await window.keyboard.type(' and two');
    await expect(box).toHaveValue('draft one and two');
  });
});
