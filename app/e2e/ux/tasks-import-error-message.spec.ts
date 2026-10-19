import { test, expect } from '../fixtures/electron';
import { sel, statusButtonByText } from '../selectors';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';

/**
 * UX sweep — flow `tasks` (round 8). The New Task modal's import path surfaces
 * a nicely-crafted error when a reference can't be resolved (e.g. a malformed
 * Jira key). Driving it revealed that the inline banner shows the RAW Electron
 * IPC error string — `Error invoking remote method 'tasks:importIssue': Error:
 * <real message>` — leaking the internal channel name and a doubled `Error:`
 * prefix, burying the user-facing message (#731).
 *
 * The renderer already knows this wrapper exists (question-submit.ts documents
 * it), but #importIssue (kanban-board.ts ~L876) passes `error.message` straight
 * to the banner without unwrapping it.
 *
 * Two guards, environment-independent (the Jira path needs no CLI token, unlike
 * GitHub which the local `gh` login can satisfy):
 *   1. LIVE — a malformed import surfaces an inline error banner + a Configure
 *      Jira CTA (feedback exists, not a silent failure). Passes on `main`.
 *   2. test.fixme(#731) TRIPWIRE — the banner must present the CLEAN message with
 *      no IPC plumbing. Fails on current `main`; un-fixme when #731 is fixed.
 */

test.afterAll(() => cleanupSeeds());

/**
 * Report Jira as not connected, whatever this machine's keychain holds.
 *
 * The CTA under test is offered only to a provider with no stored credential,
 * and whether that is true here is a fact about the developer's laptop, not
 * about the app. A machine with Jira connected — which is most of the reason to
 * connect Jira — silently exercised the other branch and the guard passed on
 * nothing. Only the status answer is faked; the import still fails for its own
 * reason and the renderer still makes the decision this file is about.
 */
async function reportJiraDisconnected(
  app: import('@playwright/test').ElectronApplication
): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('integrations:status');
    ipcMain.handle('integrations:status', () => ({ connected: false }));
  });
}

async function reachImportError(window: import('@playwright/test').Page) {
  const root = await seedProject(window);
  await activateProject(window, root);
  await window.locator(statusButtonByText('Tasks')).click();
  await expect(window.locator(sel.board)).toBeVisible();

  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click();
  await expect(window.locator('.fl-board-modal')).toBeVisible();
  await window.locator('.fl-board-modal-tab', { hasText: 'Jira' }).click();
  await window
    .locator('.fl-board-modal-body input[type="text"]')
    .first()
    .fill('gibberish-not-a-key');
  await window
    .locator('.fl-board-modal .fl-board-new', { hasText: 'Import' })
    .click();

  const banner = window.locator('.fl-board-modal-error-text');
  await expect(banner).toBeVisible({ timeout: 5000 });
  return banner;
}

test('a malformed import surfaces an inline error banner + Configure CTA (feedback, not silent)', async ({
  app,
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  await reportJiraDisconnected(app);
  const banner = await reachImportError(window);
  // Feedback exists and names the offending input — the modal stays open.
  await expect(banner).toContainText('gibberish-not-a-key');
  await expect(window.locator('.fl-board-modal')).toBeVisible();
  // Jira is not connected (no CLI token) → the recovery CTA is offered.
  await expect(
    window.locator('.fl-board-modal-error-cta', { hasText: 'Configure Jira' })
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test('import error banner presents the clean message, not the raw IPC wrapper (#731)', async ({
  window,
}) => {
  const banner = await reachImportError(window);
  const msg = await banner.innerText();
  // The banner must NOT leak Electron's IPC plumbing to the user.
  expect(msg).not.toContain('invoking remote method');
  expect(msg).not.toContain('tasks:importIssue');
  // The real, user-facing message is still there.
  expect(msg).toContain('Not a recognized Jira key');
});
