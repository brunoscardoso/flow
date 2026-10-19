import { test, expect } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';

/**
 * UX sweep — flow 9 (Tasks board), round 8. The New Task → Import path, when the
 * provider has no stored credentials, replaces the modal body with an inline
 * "Connect <provider>" form (kanban-board.ts #renderConnect). This guards that
 * recovery flow and pins the missing-feedback defect on its Connect button.
 *
 * Live guards (pass today):
 *  - importing a Jira key with no credentials surfaces the inline Connect form,
 *  - Escape dismisses it (so it isn't a hard trap — there IS a valid exit).
 *
 * Tripwire (test.fixme until fixed): the Connect button is a SILENT dead click
 * when its fields are empty — `if (!token) return` with no disabled state, no
 * inline error, no toast. The sibling New-task submit button (#412) and the main
 * Integrations Save ("Fill every field", #217) both give feedback; this form was
 * missed. Un-fixme once the connect form gives empty-field feedback.
 */

test.afterAll(() => cleanupSeeds());

const railTasks = '.fl-editor-actions .fl-rail-item[aria-label="Tasks"]';

/**
 * Make the import fail for the ONE reason this file is about.
 *
 * WHY IT IS STUBBED. The path under test is "no credential for this provider",
 * and whether that is true on the machine running the suite is not a property
 * of the app. A developer who has connected Jira in Flow — which is most of the
 * reason to have Jira connected at all — got "issue not found or no access"
 * instead, the guard went green on the wrong branch for two tests, and the
 * recovery form it exists to protect was never rendered. The same trap already
 * caught this repo once through `gh` being signed in.
 *
 * So main is told to fail the import the way a missing token fails it. The
 * renderer's own decision — read the message, show the connect form — is left
 * entirely alone, because that decision IS the subject.
 */
async function failImportAsMissingToken(
  app: import('@playwright/test').ElectronApplication
) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('tasks:importIssue');
    ipcMain.handle('tasks:importIssue', () => {
      throw new Error('No jira token configured — add one in Settings.');
    });
  });
}

async function openImportConnectForm(
  win: import('@playwright/test').Page
): Promise<void> {
  const root = await seedProject(win);
  await activateProject(win, root);
  await win.locator(railTasks).click();
  await expect(win.locator('.fl-board')).toBeVisible();

  await win.locator('.fl-board-lane-btn[aria-label="New task"]').click();
  await expect(win.locator('.fl-board-modal')).toBeVisible();
  await win.locator('.fl-board-modal-tab', { hasText: 'Jira' }).click();
  await win
    .locator('.fl-board-modal-body input[type="text"]')
    .first()
    .fill('PRJ-123');
  await win
    .locator('.fl-board-modal .fl-board-new', { hasText: 'Import' })
    .click();

  // Missing-token error → inline Connect form (the recovery path under test).
  await expect(
    win.locator('.fl-board-modal-title', { hasText: 'Connect Jira' })
  ).toBeVisible({
    timeout: 15_000,
  });
}

test('import with no credentials surfaces the inline Connect form, dismissable by Escape', async ({
  app,
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await failImportAsMissingToken(app);
  await openImportConnectForm(window);
  await expect(
    window.locator('.fl-board-modal .fl-board-new', { hasText: 'Connect' })
  ).toBeVisible();

  // Not a hard trap: Escape tears down the whole modal from the connect form.
  await window.keyboard.press('Escape');
  await expect(window.locator('.fl-board-modal')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('the inline Connect button gives feedback on empty fields (not a silent dead click)', async ({
  app,
  window,
}) => {
  await failImportAsMissingToken(app);
  await openImportConnectForm(window);

  const connect = window.locator('.fl-board-modal .fl-board-new', {
    hasText: 'Connect',
  });
  // With all fields empty, the button must NOT be a silent no-op. Either it is
  // disabled (like the #412 submit guard) or clicking it surfaces feedback
  // (an inline error / "Fill every field" hint like the Integrations Save #217).
  const feedbackAppears = async (): Promise<boolean> =>
    window.evaluate(() => {
      const modal = document.querySelector('.fl-board-modal');
      if (!modal) return false;
      const err = modal.querySelector('.fl-board-modal-error');
      const btn = [...modal.querySelectorAll('button')].find((b) =>
        /Connect|Fill/i.test(b.textContent ?? '')
      ) as HTMLButtonElement | undefined;
      const hint = /fill/i.test(btn?.textContent ?? '');
      return !!err || hint;
    });

  const disabledOnEmpty = await connect.isDisabled();
  if (!disabledOnEmpty) {
    await connect.click();
    await window.waitForTimeout(600);
  }
  expect(disabledOnEmpty || (await feedbackAppears())).toBe(true);
});
