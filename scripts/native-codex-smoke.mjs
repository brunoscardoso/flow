#!/usr/bin/env node
// Deterministic CLI seam: no provider, initialization or shared workspace required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
assert.ok(existsSync(cli), 'Run npm run build first');
const target = mkdtempSync(join(tmpdir(), 'planflow-native-smoke-'));
const env = { ...process.env, PLAN_FLOW_HOME: join(target, 'home'), PLAN_FLOW_VAULT_DIR: join(target, 'home', 'brain') };
function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, '--target', target], {
    cwd: target, env, encoding: 'utf8', timeout: 30_000,
  });
  console.log(JSON.stringify({ command: ['planflow-ai', ...args], status: result.status, stdout: result.stdout, stderr: result.stderr }));
  assert.ifError(result.error);
  assert.equal(result.status, expected);
  return result.stdout + result.stderr;
}
try {
  const plans = join(target, 'flow', 'plans');
  mkdirSync(plans, { recursive: true });
  const plan = '# Plan: Native smoke\n\n### Phase 1: Fixture\n**Complexity**: 2/10\n**Dependencies**: none\n\n- [ ] Create fixture\n  <verify>node --version</verify>\n\n### Phase 2: Verify\n**Complexity**: 1/10\n**Dependencies**: Phase 1\n\n- [ ] Review fixture\n';
  writeFileSync(join(plans, 'plan_native_smoke_v1.md'), plan);
  run(['state']);
  run(['plan', 'compile', 'native_smoke']);
  const artifact = join(plans, 'native_smoke.run.json');
  const first = JSON.parse(readFileSync(artifact, 'utf8'));
  assert.equal(first.phases.length, 2);
  assert.deepEqual(first.phases[1].dependencies, [1]);
  assert.equal(first.phases[0].tasks[0].verify, 'node --version');
  run(['plan', 'compile', 'native_smoke']);
  assert.deepEqual(JSON.parse(readFileSync(artifact, 'utf8')), first);
  run(['plan', 'notes', 'native_smoke', '--check', '--json']);
  writeFileSync(join(plans, 'plan_cycle_v1.md'), plan.replace('**Dependencies**: none', '**Dependencies**: Phase 2'));
  assert.match(run(['plan', 'compile', 'cycle'], 1), /compile refused:/);
  assert.equal(existsSync(join(plans, 'cycle.run.json')), false);
  console.log('PASS: state, compile, repeatability, dependency/verify preservation, notes, cycle refusal');
} finally {
  rmSync(target, { recursive: true, force: true });
}
