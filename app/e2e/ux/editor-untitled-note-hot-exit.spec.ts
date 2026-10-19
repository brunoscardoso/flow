/**
 * UX regression probe — flow `editor` (open file, tabs, Monaco), round 24.
 *
 * Un-probed seam: the app's **hot exit** contract as it applies to the ⌘N
 * scratch note (#941), and the ⌘Q half of that contract for real files.
 *
 * #955 (project switch) and #1072 (in-place reload) both established that an
 * unsaved editor buffer must survive a teardown: `project-context.ts` snapshots
 * the active project's tabs + dirty buffers (on switch, on `beforeunload`) and
 * boot restore rehydrates them dirty via `restoreDirtyContent`. Existing specs
 * guard the FILE half on switch (`editor-dirty-project-switch`) and on reload
 * (`editor-window-reload-dirty`). Nothing drove either:
 *
 *  - the **quit → relaunch** path (a real second launch against the same
 *    userData dir — `before-quit` runs `disposeMainProcess()`, which closes the
 *    app database, so it is not obvious the renderer's `beforeunload` persist
 *    lands in time), or
 *  - the **untitled note** on ANY of the three paths.
 *
 * Measured on main @ 175ed37f:
 *  - a dirty FILE buffer is DESTROYED by a plain quit, and the tab comes back
 *    CLEAN → #1443 (tripwire). `before-quit` runs `disposeMainProcess()` to
 *    completion — `disposeIpc()` + `db.close()` — before the window unloads, so
 *    the renderer's `beforeunload` persist has no receiver left.
 *  - the same buffer DOES survive when something already persisted it mid-session
 *    (a ⌘R reload, or any tab mutation) → tests 1 + 2 (live guards, green): they
 *    prove the persist/restore machinery is healthy and pin #1443's blast radius
 *    to "everything typed since the last tab open/close".
 *  - user-initiated destruction still asks → test 3 (live guard, green)
 *  - the NOTE is destroyed, silently, by a project switch, a reload AND a quit
 *    → #1441 (tripwires), for a different reason: `snapshotTabs()` persists it as
 *    a real file ref `{ rootPath, relPath: 'Untitled-N' }` — a path that exists
 *    nowhere — while its content is keyed by the synthetic `untitled:N` id no
 *    restored tab can match (restore logs `failed to open project file … ENOENT`).
 *  - the untitled tab offers a dead "Reveal in Finder" → #1442 (tripwire)
 *
 * Every `test.fixme` below was un-fixmed once and confirmed genuinely RED on
 * current main before being re-fixmed — none can pass vacuously.
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js');
const SCREENS = 'e2e/ux/__screens';

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
    },
  });
}

/** No account is ever connected here, so the first-run wizard opens on EVERY boot. */
async function dismissOnboarding(win: Page): Promise<void> {
  const wizard = win.locator(
    '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
  );
  if ((await wizard.count()) === 0) return;
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' });
  if (await skip.count()) await skip.first().click();
  else await win.keyboard.press('Escape');
  await expect(wizard).toHaveCount(0);
}

/** The per-project flow-settings overlay auto-opens for a project with no
 *  .flowconfig and intercepts clicks. Escape closes it. */
async function dismissAnyOverlay(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])');
  for (let i = 0; i < 4; i++) {
    if ((await overlay.count()) === 0) return;
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
  }
}

/** Tear down temp dirs. The IDE's background auto-provisioner can still be
 *  writing into a seeded repo as the test ends, so a plain rmSync races it. */
function cleanup(dirs: string[]): void {
  for (const dir of dirs) {
    for (let attempt = 0; attempt < 6 && existsSync(dir); attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Racing writer — try again.
      }
    }
  }
}

function mkRepo(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // Keep the IDE's fire-and-forget scaffold out of `git status` (repo-local).
  writeFileSync(
    join(dir, '.git', 'info', 'exclude'),
    '.claude/\nflow\n.gitignore\n'
  );
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content);
  return dir;
}

async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } };
      }
    ).flow.project.add({ path: p });
  }, dir);
  await win.waitForTimeout(600);
  await dismissAnyOverlay(win);
}

async function setActive(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: {
          project: {
            setActive(r: { rootPath: string }): Promise<unknown>;
          };
        };
      }
    ).flow.project.setActive({ rootPath: p });
  }, dir);
  await win.waitForTimeout(1200);
  await dismissAnyOverlay(win);
}

/** Open a project file through the app's real decoupled `flow:open-file` event. */
async function openFile(
  win: Page,
  rootPath: string,
  relPath: string
): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', { detail: { rootPath, relPath } })
      );
    },
    { rootPath, relPath }
  );
}

function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name });
}

/** Wait until Monaco shows a line containing `text` (content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines').first()).toContainText(
    text,
    {
      timeout: 15000,
    }
  );
}

/** Type an unsaved line into the active buffer. */
async function typeIntoEditor(win: Page, text: string): Promise<void> {
  await win.locator('.monaco-editor .view-lines').first().click();
  await win.keyboard.press('End');
  await win.keyboard.type(text);
  await win.waitForTimeout(400);
}

/** Monaco raises a bare `Canceled` when an in-flight request (tokenization, a
 *  worker round-trip) is abandoned by a tab switch — noise, not an app error.
 *  Same filter `editor-window-reload-dirty.spec.ts` uses. */
function appErrors(errors: string[]): string[] {
  return errors.filter((message) => message !== 'Canceled');
}

/** Launch + dismiss the wizard + let boot restore settle. Callers own closing `app`. */
async function boot(userDataDir: string): Promise<{
  app: ElectronApplication;
  win: Page;
  errors: string[];
}> {
  const app = await launch(userDataDir);
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForLoadState('domcontentloaded');
  await dismissOnboarding(win);
  await win.waitForTimeout(2000);
  await dismissAnyOverlay(win);
  return { app, win, errors };
}

/** Quit the way ⌘Q / the Quit menu item does — `app.quit()`, then wait it out.
 *  The disposal is bounded main-side (#1284); bound it here too so a hung quit
 *  costs this spec's teardown, never a false red on the assertion above it. */
async function quitApp(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  await app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });
  await Promise.race([
    app.waitForEvent('close').catch(() => undefined),
    new Promise((settle) => setTimeout(settle, 20_000)),
  ]);
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited — the normal path.
    }
  }
}

/** Reload the renderer in place — exactly what View ▸ Reload (⌘R) invokes. */
async function reloadWindow(
  app: ElectronApplication,
  win: Page
): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.reload();
  });
  await win.waitForTimeout(600);
  await win.waitForLoadState('domcontentloaded');
  await dismissOnboarding(win);
  await dismissAnyOverlay(win);
  await win.waitForTimeout(2500);
}

test.describe('editor hot exit: files, notes, and the gestures that end a session', () => {
  test('an unsaved buffer ALREADY persisted mid-session (by a ⌘R reload) survives quit + relaunch', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-quit-reload-'));
    const repo = mkRepo('flow-quitR-', {
      'alpha.ts': 'export const ALPHA = "on-disk-v1"\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);
      await openFile(s1.win, repo, 'alpha.ts');
      await expect(tab(s1.win, 'alpha.ts')).toBeVisible({ timeout: 10000 });
      await expectEditorShows(s1.win, 'on-disk-v1');
      await typeIntoEditor(
        s1.win,
        '\nexport const PRECIOUS = "unsaved-across-quit"'
      );
      await expect(tab(s1.win, 'alpha.ts').locator('.dirty-dot')).toBeVisible();

      // The #1072 reload persists it (that seam works) …
      await reloadWindow(s1.app, s1.win);
      await expectEditorShows(s1.win, 'unsaved-across-quit');
      await s1.win.screenshot({ path: `${SCREENS}/editor-quit-01-dirty.png` });

      // … and from there it really does survive a quit and a fresh launch, so
      // restore-side is healthy: #1443 is the quit-time WRITE, nothing else.
      await quitApp(s1.app);
      const s2 = await boot(userDataDir);
      app = s2.app;
      await expect(tab(s2.win, 'alpha.ts')).toBeVisible({ timeout: 15000 });
      await s2.win.screenshot({
        path: `${SCREENS}/editor-quit-02-relaunched.png`,
      });
      await expectEditorShows(s2.win, 'unsaved-across-quit');
      await expect(tab(s2.win, 'alpha.ts').locator('.dirty-dot')).toBeVisible();

      // Blast radius: hot exit persists to the app database, never to the file.
      expect(readFileSync(join(repo, 'alpha.ts'), 'utf8')).toBe(
        'export const ALPHA = "on-disk-v1"\n'
      );
      expect(appErrors(s2.errors), s2.errors.join(', ')).toEqual([]);
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });

  test('#1443 blast radius: text typed BEFORE a later tab mutation survives the quit (the accidental persist)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-quit-tabmut-'));
    const repo = mkRepo('flow-quitM-', {
      'alpha.ts': 'export const ALPHA = "on-disk-v1"\n',
      'beta.ts': 'export const BETA = "b"\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);
      await openFile(s1.win, repo, 'alpha.ts');
      await expect(tab(s1.win, 'alpha.ts')).toBeVisible({ timeout: 10000 });
      await typeIntoEditor(
        s1.win,
        '\nexport const PRECIOUS = "typed-BEFORE-second-tab"'
      );

      // Opening a second file is a tab mutation → onTabsChanged → persist(),
      // which carries the already-typed buffer with it.
      await openFile(s1.win, repo, 'beta.ts');
      await expect(tab(s1.win, 'beta.ts')).toBeVisible({ timeout: 10000 });
      await s1.win.waitForTimeout(2000);
      await quitApp(s1.app);

      const s2 = await boot(userDataDir);
      app = s2.app;
      await expect(tab(s2.win, 'alpha.ts')).toBeVisible({ timeout: 15000 });
      await tab(s2.win, 'alpha.ts').click();
      await s2.win.waitForTimeout(1200);
      await expectEditorShows(s2.win, 'typed-BEFORE-second-tab');
      await expect(tab(s2.win, 'alpha.ts').locator('.dirty-dot')).toBeVisible();
      expect(appErrors(s2.errors), s2.errors.join(', ')).toEqual([]);
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });

  test('user-initiated destruction still ASKS: Close All on two dirty tabs confirms each, and Cancel keeps every edit', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-closeall-'));
    const repo = mkRepo('flow-closeall-', {
      'one.ts': 'const ONE = 1\n',
      'two.ts': 'const TWO = 2\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      app = s1.app;
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);
      for (const file of ['one.ts', 'two.ts']) {
        await openFile(s1.win, repo, file);
        await expect(tab(s1.win, file)).toBeVisible({ timeout: 10000 });
        await typeIntoEditor(
          s1.win,
          `\nconst DIRTY_${file.replace('.', '_')} = true`
        );
        await expect(tab(s1.win, file).locator('.dirty-dot')).toBeVisible();
      }

      // Dismiss every confirm — "keep my unsaved work".
      const confirms: string[] = [];
      s1.win.on('dialog', (dialog) => {
        confirms.push(dialog.message());
        void dialog.dismiss();
      });

      await tab(s1.win, 'two.ts').click({ button: 'right' });
      await s1.win
        .locator('fl-tabs .ctx-menu')
        .first()
        .waitFor({ timeout: 5000 });
      await s1.win
        .locator('fl-tabs .ctx-menu .ctx-item', { hasText: 'Close All' })
        .first()
        .click();
      await s1.win.waitForTimeout(2500);

      // Each dirty tab was asked about BY NAME, and cancelling kept both.
      expect(confirms).toEqual([
        'Discard unsaved changes in one.ts?',
        'Discard unsaved changes in two.ts?',
      ]);
      await expect(tab(s1.win, 'one.ts')).toBeVisible();
      await expect(tab(s1.win, 'two.ts')).toBeVisible();
      await expectEditorShows(s1.win, 'DIRTY_two_ts');
      expect(readFileSync(join(repo, 'one.ts'), 'utf8')).toBe(
        'const ONE = 1\n'
      );
      expect(appErrors(s1.errors), s1.errors.join(', ')).toEqual([]);
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });

  // ── #1443 tripwire ───────────────────────────────────────────────────────
  // The plain quit — nothing persisted it mid-session. Un-fixme when #1443 lands.

  test('#1443: a dirty FILE buffer survives a plain quit + relaunch, and never comes back looking CLEAN', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-quitexit-'));
    const repo = mkRepo('flow-quitexit-', {
      'alpha.ts': 'export const ALPHA = "on-disk-v1"\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);
      await openFile(s1.win, repo, 'alpha.ts');
      await expect(tab(s1.win, 'alpha.ts')).toBeVisible({ timeout: 10000 });
      await expectEditorShows(s1.win, 'on-disk-v1');
      await typeIntoEditor(
        s1.win,
        '\nexport const PRECIOUS = "unsaved-across-quit"'
      );
      await expect(tab(s1.win, 'alpha.ts').locator('.dirty-dot')).toBeVisible();
      // Generous settle — this is a teardown-ordering defect, not a race.
      await s1.win.waitForTimeout(3000);
      await s1.win.screenshot({
        path: `${SCREENS}/quitloss-01-before-quit.png`,
      });

      await quitApp(s1.app);

      const s2 = await boot(userDataDir);
      app = s2.app;
      await expect(tab(s2.win, 'alpha.ts')).toBeVisible({ timeout: 15000 });
      await s2.win.screenshot({
        path: `${SCREENS}/quitloss-02-after-relaunch.png`,
      });
      await expectEditorShows(s2.win, 'unsaved-across-quit');
      await expect(tab(s2.win, 'alpha.ts').locator('.dirty-dot')).toBeVisible();
      expect(readFileSync(join(repo, 'alpha.ts'), 'utf8')).toBe(
        'export const ALPHA = "on-disk-v1"\n'
      );
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });

  // ── #1441 tripwires ──────────────────────────────────────────────────────
  // An unsaved ⌘N note is destroyed silently by all three teardown paths — and
  // unlike #1443, the project-switch case has no timing excuse at all: the
  // switch persists synchronously and a dirty FILE opened in the same window
  // comes back with its text (asserted inline as the control). Un-fixme when
  // #1441 lands.

  test('#1441: an unsaved ⌘N note survives a project switch, like a dirty file buffer does', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-note-switch-'));
    const a = mkRepo('flow-noteA-', {
      'alpha.ts': 'export const ALPHA = "A"\n',
    });
    const b = mkRepo('flow-noteB-', { 'beta.ts': 'export const BETA = "B"\n' });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      app = s1.app;
      await addRoot(s1.win, a);
      await addRoot(s1.win, b);
      await setActive(s1.win, a);

      await s1.win.keyboard.press('Meta+n');
      await expect(tab(s1.win, 'Untitled-1')).toBeVisible({ timeout: 10000 });
      await s1.win.keyboard.type('NOTE_PRECIOUS_TEXT');
      await expectEditorShows(s1.win, 'NOTE_PRECIOUS_TEXT');

      // CONTROL, same window: a dirty FILE buffer provably survives the very
      // same switch (#955) — so this is the note's problem, not the switch's.
      await openFile(s1.win, a, 'alpha.ts');
      await expect(tab(s1.win, 'alpha.ts')).toBeVisible({ timeout: 10000 });
      await typeIntoEditor(s1.win, '\nconst FILE_PRECIOUS = 1');

      await setActive(s1.win, b);
      await setActive(s1.win, a);
      await s1.win.waitForTimeout(1500);
      await s1.win.screenshot({
        path: `${SCREENS}/editor-note-switch-restored.png`,
      });

      await expect(tab(s1.win, 'alpha.ts')).toBeVisible({ timeout: 10000 }); // control holds
      await expectEditorShows(s1.win, 'FILE_PRECIOUS');
      await expect(tab(s1.win, 'Untitled-1')).toBeVisible({ timeout: 10000 });
      // The control above opened alpha.ts LAST, so alpha.ts is the tab that was
      // active at switch-away and the one restore re-activates (#955) — the note
      // is restored behind it. Click through to read its buffer; asserting the
      // editor's text without this would be asserting which tab is active, not
      // whether the note survived.
      await tab(s1.win, 'Untitled-1').click();
      await expectEditorShows(s1.win, 'NOTE_PRECIOUS_TEXT');
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([a, b, userDataDir]);
    }
  });

  test('#1441: an unsaved ⌘N note survives an in-place reload (#1072’s seam)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-note-reload-'));
    const repo = mkRepo('flow-noteR-', {
      'alpha.ts': 'export const ALPHA = "A"\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      app = s1.app;
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);

      await s1.win.keyboard.press('Meta+n');
      await expect(tab(s1.win, 'Untitled-1')).toBeVisible({ timeout: 10000 });
      await s1.win.keyboard.type('NOTE_PRECIOUS_TEXT');
      await expectEditorShows(s1.win, 'NOTE_PRECIOUS_TEXT');
      await s1.win.screenshot({
        path: `${SCREENS}/editor-note-hotexit-01-typed.png`,
      });

      await reloadWindow(s1.app, s1.win);
      await s1.win.screenshot({
        path: `${SCREENS}/editor-note-hotexit-02-after-reload.png`,
      });

      await expect(tab(s1.win, 'Untitled-1')).toBeVisible({ timeout: 10000 });
      await expectEditorShows(s1.win, 'NOTE_PRECIOUS_TEXT');
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });

  test('#1441: an unsaved ⌘N note survives quit + relaunch', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-note-quit-'));
    const repo = mkRepo('flow-noteQ-', {
      'alpha.ts': 'export const ALPHA = "A"\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);
      await s1.win.keyboard.press('Meta+n');
      await expect(tab(s1.win, 'Untitled-1')).toBeVisible({ timeout: 10000 });
      await s1.win.keyboard.type('NOTE_PRECIOUS_TEXT');
      await expectEditorShows(s1.win, 'NOTE_PRECIOUS_TEXT');
      await quitApp(s1.app);

      const s2 = await boot(userDataDir);
      app = s2.app;
      await s2.win.screenshot({
        path: `${SCREENS}/editor-note-hotexit-03-after-quit.png`,
      });
      await expect(tab(s2.win, 'Untitled-1')).toBeVisible({ timeout: 15000 });
      await expectEditorShows(s2.win, 'NOTE_PRECIOUS_TEXT');
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });

  // ── #1442 tripwire ───────────────────────────────────────────────────────

  test('#1442: the Untitled tab’s context menu never offers an ENABLED "Reveal in Finder"', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-note-reveal-'));
    const repo = mkRepo('flow-noteV-', {
      'alpha.ts': 'export const ALPHA = "A"\n',
    });
    let app: ElectronApplication | null = null;
    try {
      const s1 = await boot(userDataDir);
      app = s1.app;
      await addRoot(s1.win, repo);
      await setActive(s1.win, repo);

      // CONTROL: a real file tab DOES get the row (so absence below is a
      // deliberate gate, not a missing menu).
      await openFile(s1.win, repo, 'alpha.ts');
      await expect(tab(s1.win, 'alpha.ts')).toBeVisible({ timeout: 10000 });
      await tab(s1.win, 'alpha.ts').click({ button: 'right' });
      const fileMenu = s1.win.locator('fl-tabs .ctx-menu').first();
      await fileMenu.waitFor({ timeout: 5000 });
      await expect(
        fileMenu.locator('.ctx-item', { hasText: 'Reveal in' })
      ).toBeEnabled();
      await s1.win.keyboard.press('Escape');

      await s1.win.keyboard.press('Meta+n');
      await expect(tab(s1.win, 'Untitled-1')).toBeVisible({ timeout: 10000 });
      await tab(s1.win, 'Untitled-1').click({ button: 'right' });
      const noteMenu = s1.win.locator('fl-tabs .ctx-menu').first();
      await noteMenu.waitFor({ timeout: 5000 });
      await s1.win.screenshot({
        path: `${SCREENS}/editor-note-reveal-menu.png`,
      });

      // A note has no file on disk: the row is either absent or greyed out —
      // never an enabled control that reveals nothing (#412/#709).
      const reveal = noteMenu.locator('.ctx-item', { hasText: 'Reveal in' });
      if (await reveal.count()) await expect(reveal.first()).toBeDisabled();
    } finally {
      if (app) await app.close().catch(() => undefined);
      cleanup([repo, userDataDir]);
    }
  });
});
