import assert from 'node:assert/strict';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillPath = resolve(root, '.agents/skills/planflow-workflow/SKILL.md');
const instructionPath = resolve(root, 'AGENTS.md');

function localLinks(path) {
  return [...readFileSync(path, 'utf8').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]).filter((link) => !/^[a-z]+:/i.test(link));
}

function checkedTarget(from, link) {
  const path = resolve(dirname(from), link.split('#')[0]);
  assert.ok(existsSync(path), `Missing reference: ${link}`);
  const target = realpathSync(path);
  const inside = relative(realpathSync(root), target);
  assert.ok(!inside.startsWith('..') && !isAbsolute(inside), `Reference escapes repository: ${link}`);
  return target;
}

test('native entry points link to maintained, repository-local workflow sources', () => {
  const rootTargets = localLinks(instructionPath).map((link) => checkedTarget(instructionPath, link));
  assert.ok(rootTargets.includes(realpathSync(skillPath)), 'Root instructions must expose the skill');
  const commands = localLinks(skillPath).map((link) => checkedTarget(skillPath, link));
  assert.ok(commands.length > 0, 'The skill must route to workflow sources');
  for (const command of commands) {
    const body = readFileSync(command, 'utf8');
    // Follow the existing commands' skill references too: moving a canonical
    // skill must fail validation rather than leave a discoverable dead router.
    for (const match of body.matchAll(/\.claude\/resources\/skills\/[a-z0-9-]+\.md/g)) {
      checkedTarget(instructionPath, match[0]);
    }
  }
});

test('skill exposes native discovery metadata without changing invocation policy', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  assert.ok(frontmatter, 'SKILL.md needs YAML frontmatter');
  assert.match(frontmatter, /^name: planflow-workflow$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.ok(!existsSync(resolve(dirname(skillPath), 'agents/openai.yaml')),
    'If UI policy is added, validate it explicitly instead of assuming default discovery');
});
