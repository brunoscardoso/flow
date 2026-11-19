/**
 * `plan screens` and the shared draft-screens module — the plan records the
 * versions of the draft screens its discovery's artifact showed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const { recordDraftScreens, readPlanNotes } = await import('./plan.js');
const { compileRunScript } = await import('../state/run-compiler.js');
const draft = await import('../state/draft-screens.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

const PLAN = `# Plan: Shop

## Intent

**Goal** - Orders.

**Constraints**
- None.

---

### Phase 1: Build

**Complexity**: 3 (Low)
**Dependencies**: none
**Wave**: 1

**Tasks**:

1. Do it.
`;

const CART = '<div data-flow-id="a1"><h1>Cart</h1></div>';
const PAGE = `<html><body>
<div data-flow-draft="shop/cart"></div>
<div class="x" data-flow-draft='shop/cart'></div>
<div data-flow-draft="shop/missing"></div>
<div data-flow-draft="../etc/passwd"></div>
</body></html>`;

describe('draft-screens module', () => {
  it('finds slots, validates their target and dedupes screens', () => {
    const slots = draft.findDraftSlots(PAGE);
    expect(slots.map((slot) => slot.valid)).toEqual([true, true, true, false]);
    expect(draft.draftScreensOf(PAGE)).toEqual([
      { canvas: 'shop', screen: 'cart' },
      { canvas: 'shop', screen: 'missing' },
    ]);
  });

  it('hashes a screen without its stamped ids, so stamping is not a change', () => {
    expect(draft.hashDraftScreen(CART)).toBe(draft.hashDraftScreen('<div><h1>Cart</h1></div>'));
    expect(draft.hashDraftScreen(CART)).not.toBe(draft.hashDraftScreen('<div><h1>Basket</h1></div>'));
    expect(draft.hashDraftScreen(CART)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('matches a plan to a page by feature and version, newest first', () => {
    const names = ['plan_shop_v1.md', 'plan_shop_v3.md', 'plan_shop_v2.md', 'plan_other_v9.md'];
    expect(draft.newestPlanFor('discovery_shop_v1.walkthrough.html', names)).toBe('plan_shop_v3.md');
    expect(draft.newestPlanFor('discovery_shop_v4.walkthrough.html', names)).toBeNull();
    expect(draft.newestPlanFor('discovery_nothing_v1.walkthrough.html', names)).toBeNull();
  });

  it('writes the block after the Intent, replaces it on a re-run and removes it for none', () => {
    const record = { canvas: 'shop', screen: 'cart', hash: draft.hashDraftScreen(CART) };
    const once = draft.upsertDraftScreensBlock(PLAN, [record]);
    expect(once.indexOf('## Intent')).toBeLessThan(once.indexOf('## Draft screens'));
    expect(once.indexOf('## Draft screens')).toBeLessThan(once.indexOf('### Phase 1'));
    expect(draft.parseDraftScreensBlock(once)).toEqual([record]);
    const next = { ...record, hash: draft.hashDraftScreen('<p>x</p>') };
    const twice = draft.upsertDraftScreensBlock(once, [next]);
    expect(twice.match(/## Draft screens/g)).toHaveLength(1);
    expect(draft.parseDraftScreensBlock(twice)).toEqual([next]);
    expect(draft.upsertDraftScreensBlock(twice, [])).toBe(PLAN);
  });

  it('says a screen changed only when it was recorded and now differs', () => {
    const records = [{ canvas: 'shop', screen: 'cart', hash: draft.hashDraftScreen(CART) }];
    expect(draft.screenChangedSincePlan(records, 'shop', 'cart', CART)).toBe(false);
    expect(draft.screenChangedSincePlan(records, 'shop', 'cart', '<h1>Basket</h1>')).toBe(true);
    expect(draft.screenChangedSincePlan(records, 'shop', 'other', '<h1>Basket</h1>')).toBe(false);
  });
});

describe('plan screens', () => {
  let target: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'pf-plan-screens-'));
    for (const dir of ['plans', 'discovery', 'drafts/shop']) mkdirSync(join(target, 'flow', dir), { recursive: true });
    writeFileSync(join(target, 'flow/plans/plan_shop_v1.md'), PLAN);
    writeFileSync(join(target, 'flow/discovery/discovery_shop_v1.md'), '# Discovery\n');
    writeFileSync(join(target, 'flow/discovery/discovery_shop_v1.walkthrough.html'), PAGE);
    writeFileSync(join(target, 'flow/drafts/shop/cart.html'), CART);
  });
  afterEach(() => rmSync(target, { recursive: true, force: true }));
  const planText = (): string => readFileSync(join(target, 'flow/plans/plan_shop_v1.md'), 'utf-8');

  it('records each drawn screen once, skips an undrawn one, and is idempotent', () => {
    const result = recordDraftScreens('shop', { target });
    expect(result.screens).toEqual([{ canvas: 'shop', screen: 'cart', hash: draft.hashDraftScreen(CART) }]);
    expect(result.changed).toBe(true);
    expect(planText()).toContain(`- shop/cart · ${draft.hashDraftScreen(CART)}`);
    expect(recordDraftScreens('shop', { target }).changed).toBe(false);
    // Stamping a screen does not change its record.
    writeFileSync(join(target, 'flow/drafts/shop/cart.html'), '<div data-flow-id="zz"><h1>Cart</h1></div>');
    expect(recordDraftScreens('shop', { target }).changed).toBe(false);
  });

  it('keeps the plan readable: compile and notes still parse, and a screen change moves nothing', async () => {
    const before = compileRunScript(PLAN, 'shop', {});
    recordDraftScreens('shop', { target });
    const after = compileRunScript(planText(), 'shop', {});
    expect(after.phases.map((phase) => phase.id)).toEqual(before.phases.map((phase) => phase.id));
    expect((await readPlanNotes('shop', { target })).notes).toEqual([]);
    writeFileSync(join(target, 'flow/drafts/shop/cart.html'), '<h1>Changed</h1>');
    // The plan text is untouched by a screen change, so its hash cannot move.
    const stable = planText();
    expect(compileRunScript(stable, 'shop', {}).planHash).toBe(after.planHash);
  });

  it('is silent and writes nothing without an artifact or without slots', () => {
    rmSync(join(target, 'flow/discovery/discovery_shop_v1.walkthrough.html'));
    expect(recordDraftScreens('shop', { target }).screens).toEqual([]);
    writeFileSync(join(target, 'flow/discovery/discovery_shop_v1.walkthrough.html'), '<html></html>');
    expect(recordDraftScreens('shop', { target }).changed).toBe(false);
    expect(planText()).toBe(PLAN);
  });

  it('refuses an unknown plan or discovery in the family contract and writes nothing', () => {
    const run = (...args: string[]) =>
      spawnSync(TSX_BIN, [CLI_ENTRY, 'plan', 'screens', ...args, '--target', target], { encoding: 'utf-8' });
    const unknown = run('nope');
    expect(`${unknown.stdout}\n${unknown.stderr}`).toContain('plan refused: unknown-plan');
    expect(unknown.status).toBe(1);
    const noDoc = run('shop', '--discovery', 'flow/discovery/discovery_none_v1.md');
    expect(`${noDoc.stdout}\n${noDoc.stderr}`).toContain('plan refused: unknown-discovery');
    expect(noDoc.status).toBe(1);
    expect(planText()).toBe(PLAN);
    const ok = run('shop');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('1 draft screen recorded');
  }, 120_000);
});
