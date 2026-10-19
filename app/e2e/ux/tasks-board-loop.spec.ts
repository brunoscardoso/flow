import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '../fixtures/electron';
import type { ElectronApplication } from '@playwright/test';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeDirective } from './fixtures/loops';

/**
 * THE PLAY BUTTON PUTS SOMEBODY TO WORK.
 *
 * "I have one item for a long time on the todo that was moved from the remote
 * list, and the button play of the loop was played but never the agent trigger
 * the item."
 *
 * It could not. The button cleared a pause on the CLI's loop, and that loop
 * drains `flow/loops/queue.jsonl` — while a card promoted from the Remote
 * column is a Flow task record on no queue at all. The press worked, the loop
 * had nothing to take, and nothing on screen said the two facts were unrelated.
 *
 * The board works its own list now. And only the cards somebody ticked, because
 * "sometime the user wanna create some item manually just to track, but no fix
 * or implement at that moment".
 *
 * WHAT THIS FILE CAN AND CANNOT GUARD. The runner hands work to the agent
 * manager in main, not over IPC, so there is no seam a spec can stand in — and
 * a spec that let the real one through would run a Claude session per test.
 * The account is therefore removed from the app's environment: the CARD IS
 * STILL CHOSEN, its chat is still opened and marked, and the turn then fails
 * where a session would have started. So this guards the selection rule, the
 * loop mark, the opt-in and the stop; the prompt's own words are unit-tested
 * (board-loop-model.test.ts), and the happy path was verified live against a
 * real agent — the card moved todo → doing under a running turn.
 */
test.afterAll(() => cleanupSeeds());
test.use({
  appEnv: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
});

const PLAY = '.fl-board-lane-controls .fl-board-lane-btn';

/** Every task on the board, as the store holds it. */
async function board(window: Page, root: string) {
  return window.evaluate(
    async (p) =>
      window.flow.tasks.list({ projectRoot: p, includeArchived: false }),
    root
  );
}

/** The thread a card owns, as the store holds it. */
async function threadOf(window: Page, root: string, title: string) {
  return window.evaluate(
    async ({ p, t }) => {
      const list = await window.flow.tasks.list({
        projectRoot: p,
        includeArchived: false,
      });
      const id = list.find((task) => task.title === t)?.threadId ?? null;
      return id === null
        ? null
        : await window.flow.threads.get({ threadId: id });
    },
    { p: root, t: title }
  );
}

/**
 * File one loop-origin item into the project's ledger queue.
 *
 * A `filed` event WITH a fingerprint is what makes the board draw a card with
 * the `loop` chip and NO local record — the exact shape the real bug stranded
 * (a fixture task record has origin `you`/`github`, not `loop`, so it would
 * never exercise this path — discovery R4). Path matches the seeded directive's
 * `path: flow/loops/queue.jsonl`, resolved against the repo root.
 */
function fileLoopItem(dir: string, id: string, title: string): void {
  const event = {
    ts: '2026-09-01T00:00:00.000Z',
    id,
    event: 'filed',
    loop: 'fix',
    title,
    body: 'Reproduce and fix.',
    fingerprint: `fp-${id}`,
    labels: [] as string[],
    needsApproval: false,
    provenance: 'cli:loop file',
  };
  mkdirSync(join(dir, 'flow', 'loops'), { recursive: true });
  writeFileSync(join(dir, 'flow', 'loops', 'queue.jsonl'), `${JSON.stringify(event)}\n`);
}

async function openBoard(window: Page, dir: string): Promise<void> {
  await activateProject(window, dir);
  await window.locator('.fl-rail-item[aria-label="Tasks"]').click();
  await expect(
    window.locator('.fl-board-lane-btn[aria-label="New task"]')
  ).toBeVisible({
    timeout: 20_000,
  });
}

/** Create a task through the store, and say whether the loop may work it. */
async function seedTask(
  window: Page,
  root: string,
  title: string,
  autoFix: boolean
): Promise<void> {
  await window.evaluate(
    async ({ p, t, a }) => {
      const api = (
        window as unknown as {
          flow: {
            tasks: {
              create(r: {
                projectRoot: string;
                title: string;
              }): Promise<{ id: string }>;
              update(r: {
                taskId: string;
                patch: { autoFix: boolean };
              }): Promise<unknown>;
            };
          };
        }
      ).flow.tasks;
      const task = await api.create({ projectRoot: p, title: t });
      if (a) await api.update({ taskId: task.id, patch: { autoFix: true } });
    },
    { p: root, t: title, a: autoFix }
  );
}

test('play is inert until a card is offered to the loop, and says why', async ({
  window,
}) => {
  const dir = await seedProject(window, 'flow-ux-bloop1-');
  await openBoard(window, dir);
  await seedTask(window, dir, 'Just a note to myself', false);

  const play = window.locator(PLAY).first();
  await expect(play).toBeDisabled();
  // A DISABLED CONTROL OWES ITS REASON. "Nothing to work" over a Todo column
  // with a card in it would read as a bug, so it names the remedy instead.
  await expect(play).toHaveAttribute('title', /tick “Let the loop work this”/);
  await expect(play).toHaveAttribute(
    'aria-label',
    'Nothing is set to be worked'
  );
});

test('play takes the ticked card and leaves the note alone', async ({
  window,
}) => {
  const dir = await seedProject(window, 'flow-ux-bloop2-');
  await openBoard(window, dir);
  // The note is created FIRST, so "oldest card" and "oldest ticked card" differ.
  await seedTask(window, dir, 'Just a note to myself', false);
  await seedTask(window, dir, 'Fix the dropdown', true);

  const play = window.locator(PLAY).first();
  await expect(play).toBeEnabled();
  await play.click();

  // THE TICKED CARD WAS TAKEN — its chat is now a run of the board's loop.
  // `originLoop` is what the sidebar reads to draw ↻ instead of an ordinary
  // conversation, and a task's thread is made with the task, long before
  // anybody presses play, so it can only have been marked by the runner.
  await expect
    .poll(
      async () =>
        (await threadOf(window, dir, 'Fix the dropdown'))?.originLoop ?? null,
      {
        timeout: 15_000,
      }
    )
    .toBe('board');

  // …AND THE NOTE WAS NOT. A board is also a notebook.
  expect(
    (await threadOf(window, dir, 'Just a note to myself'))?.originLoop ?? null
  ).toBeNull();
});

test('a loop-filed card is worked by ▶ without a hand-tick', async ({ window }) => {
  // Seed in `prepare` — BEFORE the root is added — so the directive and the
  // ledger item exist before the auto-provisioner races them (it relinks `flow`
  // fire-and-forget on addRoot; a later write is shadowed — seed.ts).
  const dir = await seedProject(window, 'flow-ux-bloop-loopcard-', (d) => {
    // A consumer loop pointed at the project's own ledger, and one item filed
    // into it — the card that arrives with the `loop` chip and no local record.
    writeDirective(d, { loop: 'fix', engine: 'consumer', paused: false, mission: 'Drain' });
    fileLoopItem(d, '1', 'Loop-filed bug');
  });
  await openBoard(window, dir);

  // THE REGRESSION: this card is a bare queue item (autoFix:false, no record),
  // so ▶ used to sit disabled over work the loop itself had filed. The chip is
  // the offer now, so the button is live — and since nothing here is a ticked
  // record, its being live at all proves the loop card was seen (self-diagnosing:
  // a ledger item that never surfaced would leave it "Nothing is set to be worked").
  const play = window.locator(PLAY).first();
  await expect(play).toBeEnabled();
  await expect(play).toHaveAttribute('aria-label', 'Start working through the list');
  await play.click();

  // Pressing ▶ first MATERIALIZED it as a ticked record — a bare queue item is
  // not a record the loop can take. The record carries the ledger's own key, and
  // its title is the item's, id-prefixed by createFromQueueItem (`#1: …`).
  const RECORD = '#1: Loop-filed bug';
  await expect
    .poll(
      async () =>
        (await board(window, dir))
          .filter((t) => t.title === RECORD)
          .map((t) => `autoFix=${String(t.autoFix)}`),
      { timeout: 15_000 },
    )
    .toContain('autoFix=true');

  // …and the loop TOOK it: the card's chat is marked as the board's run. (The
  // turn then fails — the account is removed above — but the card was chosen,
  // which is the whole of what broke.)
  await expect
    .poll(async () => (await threadOf(window, dir, RECORD))?.originLoop ?? null, {
      timeout: 15_000,
    })
    .toBe('board');
});

test('a card the loop took is moved out of Todo, so the column is the queue', async ({
  window,
}) => {
  const dir = await seedProject(window, 'flow-ux-bloop3-');
  await openBoard(window, dir);
  await seedTask(window, dir, 'Fix the dropdown', true);
  await window.locator(PLAY).first().click();

  await expect
    .poll(
      async () =>
        (await board(window, dir)).find((t) => t.title === 'Fix the dropdown')
          ?.lane,
      { timeout: 15_000 }
    )
    .toBe('doing');
});

test('stopping takes no more cards', async ({ window }) => {
  const dir = await seedProject(window, 'flow-ux-bloop4-');
  await openBoard(window, dir);
  await seedTask(window, dir, 'First card', true);
  await seedTask(window, dir, 'Second card', true);

  const play = window.locator(PLAY).first();
  await play.click();
  await expect
    .poll(
      async () =>
        (await threadOf(window, dir, 'First card'))?.originLoop ?? null,
      {
        timeout: 15_000,
      }
    )
    .toBe('board');
  await play.click();
  await expect(play).toHaveAttribute(
    'aria-label',
    'Start working through the list'
  );

  // The second card is never taken: stopping means "take no more cards".
  await window.waitForTimeout(2000);
  expect(
    (await threadOf(window, dir, 'Second card'))?.originLoop ?? null
  ).toBeNull();
});
