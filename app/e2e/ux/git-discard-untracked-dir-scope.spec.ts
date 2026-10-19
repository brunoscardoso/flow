/**
 * UX sweep — flow `git` (rotation index 6): the **scope** of a Source Control
 * discard, i.e. exactly which files a ↺ / "Revert all" is allowed to destroy.
 *
 * Discarding a working-tree change is the panel's only irreversible action, and
 * for a brand-new untracked folder it is implemented as a fallback delete rather
 * than a `git checkout` (there is nothing at HEAD to check out). The invariant
 * this spec guards is that the delete stays inside the set the user was shown:
 *
 *   - the rollup's expansion lists only non-ignored files (#253), so those are
 *     the only files the user consented to lose;
 *   - a commit of that same rollup contains exactly that set (#176 / #247);
 *   - therefore a discard of it must remove exactly that set too — never the
 *     `.gitignore`d files (`.env`, `*.local`, `node_modules/`) living alongside
 *     them, which have no copy in git and no recovery path.
 *
 * `git clean -fd -- <dir>` (no `-x`) is the behavioural oracle: git itself
 * refuses to touch ignored files unless explicitly asked, and the panel offers
 * no such affordance.
 *
 * All cases run live. The last two were `test.fixme` tripwires for #1054
 * (discard used to `rm -rf` the whole directory, taking the ignored files with
 * it); the fix delegates the untracked fallback to `git clean -fd` (no `-x`),
 * so they now assert the shipped behaviour.
 */
import { test, expect, type Page } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** git with retry — the app's own status refreshes contend for `.git/index.lock`. */
function git(dir: string, ...args: string[]): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return execFileSync('git', args, {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch (error) {
      lastError = error;
      execFileSync('sleep', ['0.4']);
    }
  }
  throw lastError;
}

async function openGitPanel(window: Page): Promise<void> {
  await window
    .locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]')
    .click();
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click();
  await expect(window.locator('.gp-root')).toBeVisible();
}

async function expectPanelText(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator('.gp-root').innerText()).toContain(needle);
  }).toPass({ timeout: 10000 });
}

/** Wait for a specific change ROW to be listed. Preferred over asserting an
 *  exact `CHANGES (N)`: the IDE provisions its own `.claude/` + `flow` into a
 *  freshly-added root, so the count races that background write. */
async function expectRow(window: Page, name: string): Promise<void> {
  await expect(
    window.locator('.gp-name', { hasText: name }).first()
  ).toBeVisible({
    timeout: 15000,
  });
}

/** Accept every `window.confirm` (the discard gate) and record its text. */
function captureConfirms(window: Page): string[] {
  const messages: string[] = [];
  window.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  return messages;
}

/**
 * Click something on the git panel until it visibly lands. `GitPanel.#render`
 * wipes and re-appends its whole subtree on every status refresh (and the app
 * provisions `.claude/` + the `flow` symlink right after a root is added), so a
 * click can dispatch on a node that is already detached and simply do nothing.
 * Retrying against an observable effect keeps harness timing from masquerading
 * as product failure.
 */
async function clickUntil(
  window: Page,
  click: () => Promise<void>,
  landed: () => Promise<boolean>,
  attempts = 6
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await click();
    } catch {
      /* row re-rendered out from under the click — retry below */
    }
    for (let poll = 0; poll < 10; poll++) {
      if (await landed()) return;
      await window.waitForTimeout(300);
    }
  }
  expect(await landed(), 'action never landed on the git panel').toBe(true);
}

/**
 * A repo whose `.gitignore` hides `.env`, `*.local` and `node_modules/`, plus a
 * brand-new untracked `newapp/` holding ONE committable file and three ignored
 * ones. `git clean -fd` on this tree removes only `newapp/index.ts`.
 */
function seedIgnoreRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test');
  git(dir, 'config', 'user.name', 'QA Bot');
  writeFileSync(join(dir, '.gitignore'), '.env\nnode_modules/\n*.local\n');
  writeFileSync(join(dir, 'readme.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'chore: initial');

  mkdirSync(join(dir, 'newapp', 'node_modules', 'left-pad'), {
    recursive: true,
  });
  writeFileSync(join(dir, 'newapp', 'index.ts'), 'export const app = 1\n');
  writeFileSync(join(dir, 'newapp', '.env'), 'STRIPE_KEY=sk_live_realsecret\n');
  writeFileSync(join(dir, 'newapp', 'notes.local'), 'my scratch notes\n');
  writeFileSync(
    join(dir, 'newapp', 'node_modules', 'left-pad', 'index.js'),
    'module.exports = 1\n'
  );
}

/** The ignored files inside `newapp/` that no discard is entitled to remove. */
function ignoredSurvivors(dir: string): Record<string, boolean> {
  return {
    '.env': existsSync(join(dir, 'newapp', '.env')),
    'notes.local': existsSync(join(dir, 'newapp', 'notes.local')),
    node_modules: existsSync(
      join(dir, 'newapp', 'node_modules', 'left-pad', 'index.js')
    ),
  };
}

test.afterAll(() => cleanupSeeds());

test.describe('Source Control — discard scope on untracked paths', () => {
  test('a new folder rolls up to one row that lists only the non-ignored file (#253)', async ({
    window,
  }) => {
    const dir = await seedProject(window, 'flow-git-scope-list-');
    seedIgnoreRepo(dir);
    await activateProject(window, dir);
    await openGitPanel(window);
    await expectRow(window, 'newapp');

    // The rollup is a single row; expanding it discloses what the user is
    // dealing with — and deliberately excludes the ignored files (#253).
    await clickUntil(
      window,
      () => window.locator('.gp-chevron').first().click({ timeout: 3000 }),
      async () =>
        (await window.locator('.gp-name', { hasText: 'index.ts' }).count()) > 0
    );

    const rows = await window.locator('.gp-row').allInnerTexts();
    const listed = rows.filter((r) => r.includes('newapp'));
    expect(listed.some((r) => r.includes('index.ts'))).toBe(true);
    expect(listed.some((r) => r.includes('.env'))).toBe(false);
    expect(listed.some((r) => r.includes('notes.local'))).toBe(false);
    expect(listed.some((r) => r.includes('node_modules'))).toBe(false);

    // The oracle: inside `newapp/`, git itself would remove only the file the
    // panel just listed — never the ignored ones (that needs `-x`, which the
    // panel never offers. Scoped to `newapp` because the IDE provisions its own
    // `.claude/` + `flow` into every project root, which git also reports.
    const wouldRemove = git(dir, 'clean', '-fd', '--dry-run')
      .split('\n')
      .filter((line) => line.includes('newapp'));
    expect(wouldRemove).toEqual(['Would remove newapp/index.ts']);
  });

  test('discarding a plain untracked FILE removes exactly that file', async ({
    window,
  }) => {
    const confirms = captureConfirms(window);
    const dir = await seedProject(window, 'flow-git-scope-file-');
    seedIgnoreRepo(dir);
    writeFileSync(join(dir, 'loose.txt'), 'brand new, never committed\n');

    await activateProject(window, dir);
    await openGitPanel(window);
    await expectRow(window, 'loose.txt');

    await clickUntil(
      window,
      () =>
        window
          .locator('.gp-row', { hasText: 'loose.txt' })
          .locator('button[title="Discard changes"]')
          .first()
          .click({ timeout: 3000 }),
      async () => !existsSync(join(dir, 'loose.txt'))
    );

    expect(confirms.join(' ')).toContain('loose.txt');
    // Its neighbours — the other rollup and every ignored file — are untouched.
    expect(existsSync(join(dir, 'newapp', 'index.ts'))).toBe(true);
    expect(ignoredSurvivors(dir)).toEqual({
      '.env': true,
      'notes.local': true,
      node_modules: true,
    });
  });

  test('discarding a TRACKED edit reverts it to HEAD and touches nothing else', async ({
    window,
  }) => {
    const dir = await seedProject(window, 'flow-git-scope-tracked-');
    seedIgnoreRepo(dir);
    writeFileSync(join(dir, 'readme.md'), '# repo EDITED\n');

    await activateProject(window, dir);
    await openGitPanel(window);
    await expectRow(window, 'readme.md');

    captureConfirms(window);
    await clickUntil(
      window,
      () =>
        window
          .locator('.gp-row', { hasText: 'readme.md' })
          .locator('button[title="Discard changes"]')
          .first()
          .click({ timeout: 3000 }),
      async () => readFileSync(join(dir, 'readme.md'), 'utf8') === '# repo\n'
    );

    expect(existsSync(join(dir, 'newapp', 'index.ts'))).toBe(true);
    expect(ignoredSurvivors(dir)).toEqual({
      '.env': true,
      'notes.local': true,
      node_modules: true,
    });
  });

  test('discarding the rolled-up new folder must not delete the .gitignored files inside it (#1054)', async ({
    window,
  }) => {
    const confirms = captureConfirms(window);
    const dir = await seedProject(window, 'flow-git-scope-dir-');
    seedIgnoreRepo(dir);
    await activateProject(window, dir);
    await openGitPanel(window);
    await expectRow(window, 'newapp');

    // The file the panel listed (and a commit would have contained) does go.
    await clickUntil(
      window,
      () =>
        window
          .locator('.gp-row', { hasText: 'newapp' })
          .locator('button[title="Discard changes"]')
          .first()
          .click({ timeout: 3000 }),
      async () => !existsSync(join(dir, 'newapp', 'index.ts'))
    );

    // …but nothing the user was never shown, and git itself would not remove.
    expect(confirms.join(' ')).toContain('newapp/');
    expect(ignoredSurvivors(dir)).toEqual({
      '.env': true,
      'notes.local': true,
      node_modules: true,
    });
  });

  test('"Revert all" must not delete the .gitignored files inside a rolled-up new folder (#1054)', async ({
    window,
  }) => {
    captureConfirms(window);
    const dir = await seedProject(window, 'flow-git-scope-all-');
    seedIgnoreRepo(dir);
    await activateProject(window, dir);
    await openGitPanel(window);
    await expectRow(window, 'newapp');

    await clickUntil(
      window,
      () =>
        window
          .locator('button', { hasText: 'Revert all' })
          .first()
          .click({ timeout: 3000 }),
      async () => !existsSync(join(dir, 'newapp', 'index.ts'))
    );
    await expectPanelText(window, 'Working tree clean');

    expect(ignoredSurvivors(dir)).toEqual({
      '.env': true,
      'notes.local': true,
      node_modules: true,
    });
  });
});
