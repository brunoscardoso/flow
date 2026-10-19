import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const resource = read('.claude/resources/core/phase-isolation.md');

/**
 * Split on a section by NAME, tolerating an anchor code in front of it.
 *
 * Headings in `.claude/resources/core/` may carry a reference anchor —
 * `## COR-PI-2: Context Template` — which other shipped files cite
 * (`wave-execution.md` sends readers to COR-PI-2 by that code). Keying this
 * split on the bare heading string made declaring the anchor crash the test
 * with `Cannot read properties of undefined`, naming neither the file nor the
 * heading it wanted. The contract is about the section's CONTENT; its label is
 * allowed to carry an anchor.
 */
const sectionAfter = (text, heading) => {
  const pattern = new RegExp(`^#{2,3} (?:COR-[A-Z]+-\\d+: )?${heading}\\s*$`, 'm');
  const match = pattern.exec(text);
  assert.ok(match, `phase-isolation.md has no "${heading}" section`);
  return text.slice(match.index + match[0].length);
};

const template = sectionAfter(resource, 'Context Template').split('### Intent Injection')[0];
const patterns = sectionAfter(template, 'Project Patterns').split('## Evidence')[0];

test('supplied rules are reused only with evidence in the receiving agent context', () => {
  assert.match(patterns, /current contents are already supplied to this agent/);
  assert.match(patterns, /do not read them again/);
  assert.doesNotMatch(patterns, /Read these files before implementing:/);
  assert.match(resource, /Do not infer loading from the provider name/);
  assert.match(resource, /parent's context/);
});

test('native Codex and unknown or partial loading retain explicit missing-rule reads', () => {
  assert.match(patterns, /Otherwise, read each missing file before implementing/);
  for (const name of ['allowed-patterns', 'forbidden-patterns']) {
    const path = `.claude/rules/core/${name}.md`;
    assert.ok(patterns.includes(path));
    assert.ok(read('AGENTS.md').includes(path), 'Native startup must retain its rule links');
  }
  assert.match(resource, /Native Codex/);
  assert.match(resource, /unknown or only partially supplied/);
});

test('phase budget includes induced reads and multiplicity without claiming a 2K total', () => {
  assert.match(resource, /automatic instructions \+ prompt \+ induced reads/);
  assert.match(resource, /plan file/);
  assert.match(resource, /verification resources/);
  assert.match(resource, /every phase and every agent in a wave/);
  assert.match(resource, /unknown/);
  assert.doesNotMatch(resource, /excluding files the sub-agent reads itself/);
});
