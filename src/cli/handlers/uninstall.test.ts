/**
 * Uninstall is init in reverse: provision a temp project with the real
 * handlers, add a person's own files beside plan-flow's, remove, and check
 * that exactly plan-flow's part is gone.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { initClaude } = await import('./claude');
const { updateGitattributes } = await import('./shared');
const { uninstallProject, withoutHookEntries, UninstallRefusal } = await import('./uninstall');
const { getPackageRoot } = await import('../utils/files');

let root: string;
let target: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-uninstall-'));
  target = join(root, 'project');
  mkdirSync(target);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('uninstalling a provisioned project', () => {
  it('removes what plan-flow added and keeps everything a person wrote', async () => {
    writeFileSync(join(target, 'CLAUDE.md'), '# My project\n\nOur own notes.\n');
    writeFileSync(join(target, '.gitignore'), 'node_modules\n');
    await initClaude(target, { force: false, nonInteractive: true });
    updateGitattributes(target);
    // The person's own files beside plan-flow's.
    writeFileSync(join(target, '.claude', 'commands', 'my-command.md'), 'mine');
    const editedRule = join(target, '.claude', 'rules', 'core', 'allowed-patterns.md');
    writeFileSync(editedRule, `${readFileSync(editedRule, 'utf-8')}\n### 99. A pattern a person captured\n`);
    const settings = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf-8'));
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo mine' }] });
    settings.permissions = { allow: ['Bash(ls)'] };
    writeFileSync(join(target, '.claude', 'settings.json'), JSON.stringify(settings));
    const vault = join(root, 'vault');
    mkdirSync(vault);
    symlinkSync(vault, join(target, 'flow'));
    // Positive first: provisioning really wrote these.
    expect(existsSync(join(target, '.claude', 'commands', 'execute-plan.md'))).toBe(true);
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf-8')).toContain('<!-- plan-flow-start -->');

    const result = uninstallProject({ target, packageRoot: getPackageRoot(), confirmed: true });

    expect(existsSync(join(target, '.claude', 'commands', 'execute-plan.md'))).toBe(false);
    expect(existsSync(join(target, '.claude', 'resources'))).toBe(false);
    expect(existsSync(join(target, '.claude', 'hooks'))).toBe(false);
    expect(readFileSync(join(target, '.claude', 'commands', 'my-command.md'), 'utf-8')).toBe('mine');
    expect(existsSync(editedRule)).toBe(true);
    expect(result.kept).toContain(join('.claude', 'rules', 'core', 'allowed-patterns.md'));
    const left = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf-8'));
    expect(left).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, permissions: { allow: ['Bash(ls)'] } });
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf-8')).toBe('# My project\n\nOur own notes.\n');
    expect(existsSync(join(target, '.gitattributes'))).toBe(false);
    expect(existsSync(join(target, 'flow'))).toBe(false);
    expect(readdirSync(vault)).toEqual([]);
    expect(existsSync(vault)).toBe(true);
  });

  it('never removes a real flow folder', () => {
    mkdirSync(join(target, 'flow', 'plans'), { recursive: true });
    writeFileSync(join(target, 'flow', 'plans', 'plan_x_v1.md'), 'plan');
    uninstallProject({ target, packageRoot: getPackageRoot(), confirmed: true });
    expect(readFileSync(join(target, 'flow', 'plans', 'plan_x_v1.md'), 'utf-8')).toBe('plan');
  });

  it('refuses without a confirmation, a missing folder, and the source repository', () => {
    expect(() => uninstallProject({ target, packageRoot: getPackageRoot(), confirmed: false as unknown as true })).toThrow(UninstallRefusal);
    expect(() => uninstallProject({ target: join(root, 'nope'), packageRoot: getPackageRoot(), confirmed: true })).toThrow(UninstallRefusal);
    // A stand-in for the source repository — never the real checkout, which a
    // broken refusal would strip.
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'planflow-ai' }));
    mkdirSync(join(target, 'templates', 'shared'), { recursive: true });
    writeFileSync(join(target, 'templates', 'shared', 'CLAUDE.md.template'), 'x');
    mkdirSync(join(target, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(target, '.claude', 'commands', 'execute-plan.md'), 'source');
    expect(() => uninstallProject({ target, packageRoot: getPackageRoot(), confirmed: true })).toThrow(/plan-flow's own source/);
    expect(readFileSync(join(target, '.claude', 'commands', 'execute-plan.md'), 'utf-8')).toBe('source');
  });
});

describe('dropping plan-flow hook entries', () => {
  it('leaves unparseable or hook-free settings alone', () => {
    expect(withoutHookEntries('{ nope')).toBeNull();
    expect(withoutHookEntries('{"permissions":{}}')).toBeNull();
  });

  it('reports a settings file with nothing else in it as empty', () => {
    const text = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'test -f .claude/hooks/cost-tracker.cjs && node .claude/hooks/cost-tracker.cjs || true' }] }] },
    });
    expect(withoutHookEntries(text)).toBe('empty');
  });
});
