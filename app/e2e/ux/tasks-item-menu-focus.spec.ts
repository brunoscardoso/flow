import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../fixtures/electron';
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed';
import { writeDirective } from './fixtures/loops';

/**
 * THE SHARED-LIST CARD'S MENU KEEPS ITS WAY HOME.
 *
 * The lane menu learned (beat 43) to find its card again by identity, because
 * every `tasks:updated` re-renders every card and a menu holding the old NODE
 * returned Escape's focus to a detached element — <body>. The menu on an item
 * from the shared list kept the node, and its card has no task id for the
 * board's own rescue to key on, so the same write dropped the same keyboard
 * user in the column next door.
 */
test.afterAll(() => cleanupSeeds());

const TITLE = 'Loop-filed bug';

/** One loop-origin item in the project's ledger queue — a card with no record. */
function fileLoopItem(dir: string): void {
  const event = {
    ts: '2026-09-01T00:00:00.000Z',
    id: '1',
    event: 'filed',
    loop: 'fix',
    title: TITLE,
    body: 'Reproduce and fix.',
    fingerprint: 'fp-1',
    labels: [] as string[],
    needsApproval: false,
    provenance: 'cli:loop file',
  };
  mkdirSync(join(dir, 'flow', 'loops'), { recursive: true });
  writeFileSync(join(dir, 'flow', 'loops', 'queue.jsonl'), `${JSON.stringify(event)}\n`);
}

test('Escape returns focus to a shared-list card even when the board re-rendered under its menu', async ({
  window,
}) => {
  // Seeded before the root is added, so the provisioner cannot shadow it (seed.ts).
  const dir = await seedProject(window, 'flow-ux-item-menu-focus-', (d) => {
    writeDirective(d, { loop: 'fix', engine: 'consumer', paused: true, mission: 'Drain' });
    fileLoopItem(d);
  });
  await activateProject(window, dir);
  await window.locator('.fl-rail-item[aria-label="Tasks"]').click();
  const card = window.locator('.fl-board-card', { hasText: TITLE });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The positive first (#28): this is the queue item's card, not a task's.
  expect(await card.getAttribute('data-task-id')).toBeNull();

  const menu = window.locator('.fl-board-menu');
  await card.focus();
  await window.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  const before = await card.elementHandle();

  // A task written while the menu is open re-renders every card.
  await window.evaluate(async (r) => {
    await (
      window as unknown as {
        flow: { tasks: { create(a: { projectRoot: string; title: string }): Promise<unknown> } }
      }
    ).flow.tasks.create({ projectRoot: r, title: 'Renew the certificates' });
  }, dir);
  await expect(window.locator('.fl-board-card', { hasText: 'Renew the certificates' })).toBeVisible();
  // The card the menu was opened from IS gone, and the menu is still open.
  expect(await before?.evaluate((node) => node.isConnected)).toBe(false);
  await expect(menu).toBeVisible();

  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(
    await window.evaluate(
      () => document.activeElement?.closest('.fl-board-card')?.textContent ?? 'NONE'
    )
  ).toContain(TITLE);
});
