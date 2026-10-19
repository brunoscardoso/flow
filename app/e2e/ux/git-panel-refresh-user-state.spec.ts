/**
 * UX sweep — flow `git` (rotation index 6, round 18): what a BACKGROUND REFRESH
 * does to the user's own state in the Source Control **Changes** panel.
 *
 * Why this was un-probed: 25 git specs drive stage / unstage / commit / diff /
 * merge / pull / history / gating, and `git-commit-gate-reason.spec.ts` already
 * guards that the commit DRAFT TEXT survives a re-render. Every one of them asks
 * whether the panel's CONTENT is right afterwards. None asks what the rebuild
 * does to the person using it — their focus, their caret, their scroll position.
 *
 * `git-panel.ts:254-259 #renderRoots` empties the container (`textContent = ''`)
 * and recreates every child on every `refreshRoot` → `render()`, which fires on
 * `git:changed` and on the debounced `project:fileChanged` — i.e. on ANY file
 * write in the project, including one that leaves `git status` byte-identical.
 * Two user-visible harms follow:
 *
 *   #1093 — the commit `<textarea>` is recreated, focus drops to <body>, and
 *           every keystroke typed after that is silently swallowed.
 *   #1094 — the virtualized Changes list is recreated at `scrollTop = 0`, so a
 *           scrolled list snaps back and the row under the (unmoved) pointer
 *           becomes a different file.
 *
 * The live guards below hold BEFORE and AFTER a fix. The two `test.fixme` tests
 * are fix-agnostic tripwires that flip green when each issue lands.
 *
 * The Review (**Phases**) message input — the sibling view one toggle away — is
 * driven here as a CONTROL: #282 gave it capture/restore, so it survives the
 * identical trigger. That is what makes the Changes-panel behaviour a defect
 * rather than a platform limitation.
 */
import { test, expect, type Page } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = join(__dirname, '__screens');

/** Debounce (500ms) + git round-trip + render, with headroom. */
const REFRESH_SETTLE_MS = 2500;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString();
}

/** One commit, then `files` tracked files all modified in the working tree. */
function populate(dir: string, files: number): void {
  git(dir, 'config', 'user.email', 'qa@flow.test');
  git(dir, 'config', 'user.name', 'QA Bot');
  for (let i = 0; i < files; i++) {
    writeFileSync(
      join(dir, `file-${String(i).padStart(2, '0')}.txt`),
      `v1 ${i}\n`
    );
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  for (let i = 0; i < files; i++) {
    writeFileSync(
      join(dir, `file-${String(i).padStart(2, '0')}.txt`),
      `v2 CHANGED ${i}\n`
    );
  }
}

/** Seed a repo and reveal Source Control → Changes (`.gp-root`). */
async function openChanges(window: Page, files: number): Promise<string> {
  // Populate inside `prepare` (pre-addRoot) so the app's own git activity
  // (status refreshes, provisioning) can't race the seed on index.lock.
  const dir = await seedProject(window, 'flow-ux-gitstate-', (d) =>
    populate(d, files)
  );
  await activateProject(window, dir);
  await window
    .locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]')
    .click();
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click();
  await expect(window.locator('.gp-root')).toBeVisible();
  await expect(async () => {
    expect(await window.locator('.gp-commit-msg').count()).toBeGreaterThan(0);
  }).toPass({ timeout: 10000 });
  return dir;
}

/** Stamp the live commit box + Changes list, so a later read can tell whether
 *  the SAME elements are still mounted (a missing stamp === recreated). */
async function stamp(window: Page, tag: string): Promise<void> {
  await window.evaluate((value) => {
    const box = document.querySelector(
      '.gp-commit-msg'
    ) as HTMLTextAreaElement | null;
    if (box) box.dataset['probe'] = value;
    const list = document.querySelector(
      'fl-list[data-section="changes"]'
    ) as HTMLElement | null;
    if (list) list.dataset['probe'] = value;
  }, tag);
}

interface PanelState {
  activeIsCommitBox: boolean;
  boxStamp: string;
  listStamp: string;
  value: string | null;
  scrollTop: number | null;
}

async function readPanel(window: Page): Promise<PanelState> {
  return window.evaluate(() => {
    const active = document.activeElement;
    const box = document.querySelector(
      '.gp-commit-msg'
    ) as HTMLTextAreaElement | null;
    const list = document.querySelector(
      'fl-list[data-section="changes"]'
    ) as HTMLElement | null;
    const scroller = list?.shadowRoot?.querySelector('.scroller') as
      | HTMLElement
      | undefined;
    return {
      activeIsCommitBox:
        active instanceof HTMLElement &&
        active.classList.contains('gp-commit-msg'),
      boxStamp: box?.dataset['probe'] ?? '(recreated)',
      listStamp: list?.dataset['probe'] ?? '(recreated)',
      value: box?.value ?? null,
      scrollTop: scroller?.scrollTop ?? null,
    };
  });
}

/** Wait until the panel stops re-rendering on its own (a stamp survives a quiet
 *  window) — boot/seed refreshes must not be mistaken for the probe's trigger. */
async function settle(window: Page): Promise<void> {
  for (let round = 0; round < 12; round++) {
    await stamp(window, `settle-${round}`);
    await window.waitForTimeout(1500);
    if ((await readPanel(window)).boxStamp === `settle-${round}`) return;
  }
  throw new Error('Source Control panel never went quiet');
}

/** The trigger every guard here shares: an unrelated file appears in the repo,
 *  exactly as an agent turn / editor save / heartbeat write would produce. */
async function backgroundWrite(
  window: Page,
  dir: string,
  name: string
): Promise<void> {
  writeFileSync(join(dir, name), `background write ${name}\n`);
  await window.waitForTimeout(REFRESH_SETTLE_MS);
}

/** Bounding box of the Changes list, polled (it is detached during a rebuild). */
async function changesListBox(
  window: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  let box: { x: number; y: number; width: number; height: number } | null =
    null;
  await expect(async () => {
    box = await window.locator('fl-list[data-section="changes"]').boundingBox();
    expect(box).not.toBeNull();
  }).toPass({ timeout: 10000 });
  if (!box) throw new Error('Changes list never laid out');
  return box;
}

/** The file name of the row under a viewport point (rows live in an open shadow
 *  DOM, so `document.elementFromPoint` stops at the host — re-probe inside). */
async function rowUnderPoint(
  window: Page,
  x: number,
  y: number
): Promise<string | null> {
  return window.evaluate(
    ([px, py]) => {
      const list = document.querySelector(
        'fl-list[data-section="changes"]'
      ) as HTMLElement | null;
      const inner = list?.shadowRoot?.elementFromPoint(px, py) as
        | HTMLElement
        | undefined;
      return (
        inner?.closest('.gp-row')?.querySelector('.gp-name')?.textContent ??
        null
      );
    },
    [x, y]
  );
}

/** Scroll the Changes list with a real wheel gesture, retrying until it takes
 *  (a refresh landing right after the wheel would zero it — which is #1094). */
async function wheelChangesList(
  window: Page,
  box: { x: number; y: number; width: number; height: number }
): Promise<number> {
  let top = 0;
  await expect(async () => {
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 200);
    top = (await readPanel(window)).scrollTop ?? 0;
    expect(top).toBeGreaterThan(0);
  }).toPass({ timeout: 10000 });
  // Let any in-flight scroll momentum settle before capturing the offset: the
  // retry loop above can queue extra wheel deltas whose animation lands AFTER
  // the first successful read, so the captured value must be the list's true
  // resting position (two consecutive quiet reads agree) — otherwise a later
  // "scroll unchanged" assertion measures the spec's own physics, not the app.
  let prev = -1;
  await expect(async () => {
    await window.waitForTimeout(250);
    top = (await readPanel(window)).scrollTop ?? 0;
    const stable = top === prev && top > 0;
    prev = top;
    expect(stable).toBe(true);
  }).toPass({ timeout: 10000 });
  return top;
}

test.afterAll(() => {
  try {
    cleanupSeeds();
  } catch {
    // A seeded repo's background writers can race the temp-dir removal (ENOTEMPTY).
  }
});

test('a background file write rebuilds the panel, and the typed draft survives it (#335)', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(String(error)));
  const dir = await openChanges(window, 6);
  await settle(window);

  await stamp(window, 'live');
  await window.locator('.gp-commit-msg').click();
  await window.keyboard.type('fix: part one');
  const typed = await readPanel(window);
  expect(typed.activeIsCommitBox).toBe(true);
  expect(typed.boxStamp).toBe('live');
  expect(typed.value).toBe('fix: part one');

  await backgroundWrite(window, dir, 'agent-wrote-this.txt');

  const after = await readPanel(window);
  // The trigger really rebuilds the panel — if this ever stops being true the
  // tripwires below would pass vacuously.
  expect(after.boxStamp).toBe('(recreated)');
  // The draft TEXT is mirrored into #commitDrafts and must never be lost.
  expect(after.value).toBe('fix: part one');
  expect(errors).toEqual([]);
});

test('CONTROL: the Review (Phases) message input keeps focus and caret across the same refresh (#282)', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(String(error)));
  const dir = await seedProject(window, 'flow-ux-revstate-', (d) =>
    populate(d, 4)
  );
  await activateProject(window, dir);
  await window
    .locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]')
    .click();
  await window.locator('.fl-sc-viewbtn', { hasText: 'Phases' }).click();
  await expect(window.locator('.fl-review')).toBeAttached();
  await expect(async () => {
    expect(await window.locator('.fl-review-message').count()).toBeGreaterThan(
      0
    );
  }).toPass({ timeout: 10000 });
  await window.waitForTimeout(REFRESH_SETTLE_MS);

  const readReview = async (): Promise<{
    focused: boolean;
    stamp: string;
    value: string | null;
  }> =>
    window.evaluate(() => {
      const active = document.activeElement;
      const input = document.querySelector(
        '.fl-review-message'
      ) as HTMLInputElement | null;
      return {
        focused:
          active instanceof HTMLElement &&
          active.classList.contains('fl-review-message'),
        stamp: input?.dataset['probe'] ?? '(recreated)',
        value: input?.value ?? null,
      };
    });

  await window.evaluate(() => {
    const input = document.querySelector(
      '.fl-review-message'
    ) as HTMLInputElement | null;
    if (input) input.dataset['probe'] = 'live';
  });
  const input = window.locator('.fl-review-message').first();
  await input.click();
  await input.fill('');
  await window.keyboard.type('fix: part one');
  expect((await readReview()).focused).toBe(true);

  writeFileSync(join(dir, 'agent-wrote-this.txt'), 'background write\n');
  await window.waitForTimeout(REFRESH_SETTLE_MS);

  const after = await readReview();
  expect(after.stamp).toBe('(recreated)'); // the rebuild happened here too…
  expect(after.focused).toBe(true); // …but #282 puts the user back
  await window.keyboard.type(' AND PART TWO');
  await expect
    .poll(async () => (await readReview()).value, { timeout: 4000 })
    .toBe('fix: part one AND PART TWO');
  expect(errors).toEqual([]);
});

test('the Changes list scrolls under a real wheel gesture and lists every changed file', async ({
  window,
}) => {
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(String(error)));
  await openChanges(window, 16);
  await settle(window);

  // (The header is uppercased by CSS; the DOM text is title-case.)
  await expect(window.locator('.gp-root')).toContainText('Changes (16)');
  const box = await changesListBox(window);
  const top = await wheelChangesList(window, box);
  expect(top).toBeGreaterThan(0);
  // Scrolling really reveals later rows (the list is virtualized, 8 rows tall).
  const revealed = await rowUnderPoint(
    window,
    box.x + box.width / 2,
    box.y + box.height - 14
  );
  expect(revealed).not.toBe('file-00.txt');
  expect(errors).toEqual([]);
});

// ── Former tripwires — live guards since the #1093/#1094 fixes ──────────────

test('#1093: the commit box keeps focus across a background refresh, so typing is not lost', async ({
  window,
}) => {
  const dir = await openChanges(window, 6);
  await settle(window);

  await stamp(window, 'live');
  await window.locator('.gp-commit-msg').click();
  await window.keyboard.type('fix: part one');
  expect((await readPanel(window)).activeIsCommitBox).toBe(true);

  await backgroundWrite(window, dir, 'agent-wrote-this.txt');

  const after = await readPanel(window);
  expect(
    after.activeIsCommitBox,
    'a background file write ejected the user from the commit message box'
  ).toBe(true);

  // …and the rest of the sentence must actually land.
  await window.keyboard.type(' AND PART TWO');
  await window.screenshot({
    path: join(SHOTS, 'git-refresh-commitbox-focus.png'),
  });
  await expect
    .poll(async () => (await readPanel(window)).value, { timeout: 4000 })
    .toBe('fix: part one AND PART TWO');
});

test('#1094: a no-op background refresh keeps the Changes list scrolled where the user put it', async ({
  window,
}) => {
  const dir = await openChanges(window, 16);
  await settle(window);

  const box = await changesListBox(window);
  const probeX = box.x + box.width / 2;
  const probeY = box.y + box.height - 14;
  const scrolledTo = await wheelChangesList(window, box);
  const rowBefore = await rowUnderPoint(window, probeX, probeY);

  // A NO-OP refresh: re-touch a file that is already listed as modified, so
  // the change set is byte-identical before and after.
  const porcelainBefore = git(dir, 'status', '--porcelain');
  writeFileSync(join(dir, 'file-03.txt'), 'v3 CHANGED AGAIN 3\n');
  await window.waitForTimeout(REFRESH_SETTLE_MS);
  expect(git(dir, 'status', '--porcelain')).toBe(porcelainBefore);

  const after = await readPanel(window);
  await window.screenshot({
    path: join(SHOTS, 'git-refresh-changes-scroll.png'),
  });
  expect(
    after.scrollTop,
    'a no-op refresh yanked the Changes list back to the top'
  ).toBe(scrolledTo);
  expect(
    await rowUnderPoint(window, probeX, probeY),
    'the row under the (unmoved) pointer changed file'
  ).toBe(rowBefore);
});
