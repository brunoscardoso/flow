/**
 * Feature bootstrap — what a freshly provisioned project's board contains.
 *
 * The property under test is not "it writes files" but WHICH files: capability
 * names get written, change records only get staged, and nothing a human owns
 * is ever touched by a re-run.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapFeatures, describeBootstrap } from './feature-bootstrap.js';
import { readCandidates } from './feature-discover.js';
import { featuresDir, readFeatures } from './feature-store.js';

interface Repo {
  root: string;
  flow: string;
  structure: string;
}

/** A repo whose routes and tests name two capabilities: chats and playbooks. */
function repo(extraDirs: readonly string[] = []): Repo {
  const root = mkdtempSync(join(tmpdir(), 'feat-boot-'));
  const dirs = [
    'src/app/app/chats', 'src/app/api/chat', 'e2e/tests/chats',
    'src/app/app/playbooks', 'src/app/api/playbooks',
    'src/app/api/telemetry', // plumbing — one plane only
    'flow/plans', 'flow/discovery', 'flow/archive', 'flow/brain/features', 'flow/brain/.structure',
    ...extraDirs,
  ];
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  return { root, flow: join(root, 'flow'), structure: join(root, 'flow/brain/.structure') };
}

function run(target: Repo): ReturnType<typeof bootstrapFeatures> {
  return bootstrapFeatures(target.root, target.flow, target.structure, null);
}

describe('bootstrapFeatures', () => {
  it('writes the repo capabilities as core features', () => {
    const target = repo();
    const result = run(target);
    expect(result.cores).toBe(2);
    expect(readFeatures(target.flow).map((feature) => feature.name).sort()).toEqual([
      'Chats',
      'Playbooks',
    ]);
  });

  it('never writes plumbing as a feature', () => {
    const target = repo();
    run(target);
    expect(readFeatures(target.flow).map((feature) => feature.slug)).not.toContain('telemetry');
  });

  it('STAGES a plan rather than writing it — execution confirms, not provisioning', () => {
    const target = repo();
    writeFileSync(
      join(target.flow, 'plans', 'plan_chat-session-cache-rework_v1.md'),
      '## Story\n\n- anchors: module:src/app/api/chat\n',
    );
    const result = run(target);
    expect(readFeatures(target.flow).map((f) => f.slug)).not.toContain('chat-session-cache-rework');
    expect(result.staged).toBe(1);
    const staged = readCandidates(target.structure);
    expect(staged[0].kind).toBe('child');
    expect(staged[0].parentSlug).toBe('chats');
  });

  it('is idempotent — a second run writes no new feature', () => {
    const target = repo();
    run(target);
    const before = readFeatures(target.flow).map((feature) => feature.slug);
    const second = run(target);
    expect(second.cores).toBe(0);
    expect(readFeatures(target.flow).map((feature) => feature.slug)).toEqual(before);
  });

  it('re-provisioning NEVER overwrites a curated feature', () => {
    const target = repo();
    run(target);
    // The user renames it, re-levels it and writes real prose.
    const path = join(featuresDir(target.flow), 'chats.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf-8')
        .replace('name: Chats', 'name: Conversations')
        .replace('kind: core', 'kind: child')
        .replace(/Confirmed from.*/, 'MY OWN DESCRIPTION.'),
    );

    run(target);

    const after = readFeatures(target.flow).find((feature) => feature.slug === 'chats');
    expect(after?.name).toBe('Conversations');
    expect(after?.kind).toBe('child');
    expect(after?.body).toContain('MY OWN DESCRIPTION.');
  });

  it('adopts pre-existing feature files in place, keeping their prose', () => {
    const target = repo();
    const legacy = '# Feature: Hand Written\n\nProse that predates all of this.\n';
    writeFileSync(join(featuresDir(target.flow), 'hand-written.md'), legacy);
    const result = run(target);
    expect(result.adopted).toBe(1);
    const adopted = readFeatures(target.flow).find((feature) => feature.slug === 'hand-written');
    expect(adopted?.body).toBe(legacy);
  });

  it('yields an empty board, not guesses, when the repo names no capability', () => {
    const bare = mkdtempSync(join(tmpdir(), 'bare-'));
    for (const dir of ['src/cli', 'flow/brain/features', 'flow/brain/.structure']) {
      mkdirSync(join(bare, dir), { recursive: true });
    }
    const result = bootstrapFeatures(bare, join(bare, 'flow'), join(bare, 'flow/brain/.structure'), null);
    expect(result.cores).toBe(0);
    expect(describeBootstrap(result)).toContain('no capability surfaces found');
  });
});
