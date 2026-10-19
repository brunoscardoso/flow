/**
 * Tests for the one-time stranded-findings recovery (#loop-ledger-shared-root).
 *
 * `planSalvage` is pure, so every rule — dedup against the canonical ledger,
 * dedup within the run, renumber from live max + 1, idempotent re-run — is
 * asserted on plain JSONL strings with no fs, no git and no clock.
 */

const { planSalvage, renderSalvagedLine } = await import('./salvage.js');

/** A `filed` event line, as the ledger stores it. */
function filed(id: string, fingerprint: string, title: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', id, event: 'filed', loop: 'find', title, fingerprint, ...extra });
}

/** A `closed` event line — carries a fingerprint the ledger still "knows". */
function closed(id: string, fingerprint: string): string {
  return JSON.stringify({ ts: '2026-09-01T01:00:00.000Z', id, event: 'closed', loop: 'find', reason: 'done', fingerprint });
}

describe('planSalvage — recovering findings the fork stranded', () => {
  it('appends only the divergent findings, renumbered from live max + 1', () => {
    // Canonical baseline: 18 filed items (ids 1..18), fingerprints fp1..fp18.
    const canonical = Array.from({ length: 18 }, (_v, i) => filed(String(i + 1), `fp${i + 1}`, `item ${i + 1}`));
    // Two worktrees, each carrying the shared baseline PLUS its own divergent #19.
    const sourceA = [...canonical, filed('19', 'fpSEC', 'blueprint:reviewSummary path traversal')];
    const sourceB = [...canonical, filed('19', 'fpASSETS', 'assets copied into every worktree')];

    const plan = planSalvage(canonical, [
      { label: 'wt-a', lines: sourceA },
      { label: 'wt-b', lines: sourceB },
    ]);

    expect(plan.baselineMaxId).toBe(18);
    // The shared baseline copies are recognized as already present, not re-added.
    expect(plan.append.map((f) => ({ id: f.id, fp: f.fingerprint, from: f.source }))).toEqual([
      { id: '19', fp: 'fpSEC', from: 'wt-a' },
      { id: '20', fp: 'fpASSETS', from: 'wt-b' },
    ]);
    // 18 baseline dups per source × 2 sources = 36 already-present.
    expect(plan.alreadyPresent).toHaveLength(36);
  });

  it('is idempotent — a re-run after appending finds nothing new (NFR-4)', () => {
    const canonical = [filed('1', 'fp1', 'one'), filed('2', 'fp2', 'two')];
    const source = [...canonical, filed('19', 'fpNEW', 'stranded')];

    const first = planSalvage(canonical, [{ label: 'wt', lines: source }]);
    expect(first.append).toHaveLength(1);
    expect(first.append[0].id).toBe('3');

    // Apply the plan, then re-run against the grown ledger.
    const grown = [...canonical, renderSalvagedLine(first.append[0], '2026-09-09T00:00:00.000Z')];
    const second = planSalvage(grown, [{ label: 'wt', lines: source }]);
    expect(second.append).toEqual([]);
    expect(second.alreadyPresent).toHaveLength(3); // fp1, fp2, fpNEW all present now
  });

  it('dedups one fingerprint across sources — the shared copy is appended once', () => {
    const canonical = [filed('1', 'fp1', 'one')];
    const sameStranded = filed('19', 'fpDUP', 'same finding in two worktrees');

    const plan = planSalvage(canonical, [
      { label: 'wt-a', lines: [...canonical, sameStranded] },
      { label: 'wt-b', lines: [...canonical, sameStranded] },
    ]);

    expect(plan.append).toHaveLength(1);
    expect(plan.append[0].fingerprint).toBe('fpDUP');
    expect(plan.append[0].source).toBe('wt-a'); // first source wins
  });

  it('treats a fingerprint the canonical ledger CLOSED as already present', () => {
    // A finding that was worked and closed must not be resurrected by recovery.
    const canonical = [filed('5', 'fpDone', 'done thing'), closed('5', 'fpDone')];
    const source = [filed('19', 'fpDone', 'the same, stranded elsewhere')];

    const plan = planSalvage(canonical, [{ label: 'wt', lines: source }]);
    expect(plan.append).toEqual([]);
    expect(plan.alreadyPresent).toHaveLength(1);
  });

  it('assigns ids from the live max even when the baseline already grew past 19 (R-3)', () => {
    // A canonical write already reached #20; the stranded #19 must not collide.
    const canonical = Array.from({ length: 20 }, (_v, i) => filed(String(i + 1), `fp${i + 1}`, `item ${i + 1}`));
    const source = [...canonical.slice(0, 18), filed('19', 'fpLate', 'stranded, filed before #19/#20 landed')];

    const plan = planSalvage(canonical, [{ label: 'wt', lines: source }]);
    expect(plan.append.map((f) => f.id)).toEqual(['21']);
  });

  it('skips a hand-filed item with no fingerprint — recovery only owns loop filings', () => {
    const canonical = [filed('1', 'fp1', 'one')];
    const source = [JSON.stringify({ id: '19', event: 'filed', loop: 'find', title: 'no fingerprint', fingerprint: '' })];

    const plan = planSalvage(canonical, [{ label: 'wt', lines: source }]);
    expect(plan.append).toEqual([]);
    expect(plan.alreadyPresent).toEqual([]);
  });

  it('renders an appended line with a new id, ts and provenance, preserving the body', () => {
    const canonical = [filed('1', 'fp1', 'one')];
    const source = [filed('19', 'fpNEW', 'stranded', { body: 'the details', primaryFile: 'app/x.ts', labels: ['qa-heartbeat'] })];

    const plan = planSalvage(canonical, [{ label: 'wt-a', lines: source }]);
    const line = JSON.parse(renderSalvagedLine(plan.append[0], '2026-09-09T12:00:00.000Z'));

    expect(line.id).toBe('2');
    expect(line.event).toBe('filed');
    expect(line.ts).toBe('2026-09-09T12:00:00.000Z');
    expect(line.body).toBe('the details');
    expect(line.primaryFile).toBe('app/x.ts');
    expect(line.labels).toEqual(['qa-heartbeat']);
    expect(line.provenance).toContain('salvaged from wt-a #19');
  });
});
