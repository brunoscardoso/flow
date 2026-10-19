import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureGraphifyOutLocal,
  graphifyOutIsLocalDir,
  REPO_GRAPHIFY_OUT,
  VAULT_GRAPHIFY_OUT_RELPATH,
} from './graphify-out-symlink';

describe('ensureGraphifyOutLocal (#142 — local dir, Tailwind/Turbopack safety)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'graphify-out-local-'));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const repoDir = () => join(repoRoot, REPO_GRAPHIFY_OUT);
  const vault = () => join(repoRoot, VAULT_GRAPHIFY_OUT_RELPATH);

  it('creates a real local directory when nothing exists', () => {
    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('created');
    const node = lstatSync(repoDir());
    expect(node.isDirectory()).toBe(true);
    expect(node.isSymbolicLink()).toBe(false);
    expect(graphifyOutIsLocalDir(repoRoot)).toBe(true);
  });

  it('is idempotent — an existing local dir is a no-op', () => {
    ensureGraphifyOutLocal(repoRoot);
    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('noop');
    expect(graphifyOutIsLocalDir(repoRoot)).toBe(true);
  });

  it('migrates a legacy vault symlink into a real dir, copying the vault graph in', () => {
    // Simulate the old #142 relocation symlink with a prior graph in the vault.
    mkdirSync(vault(), { recursive: true });
    writeFileSync(join(vault(), 'graph.json'), '{"nodes":[]}', 'utf-8');
    mkdirSync(join(vault(), '2026-07-14'), { recursive: true });
    writeFileSync(join(vault(), '2026-07-14', 'graph.json'), '{"old":true}', 'utf-8');
    symlinkSync(VAULT_GRAPHIFY_OUT_RELPATH, repoDir());

    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('migrated');
    const node = lstatSync(repoDir());
    expect(node.isDirectory()).toBe(true);
    expect(node.isSymbolicLink()).toBe(false);
    // Prior graph copied into the real dir so incremental update keeps it.
    expect(readFileSync(join(repoDir(), 'graph.json'), 'utf-8')).toBe('{"nodes":[]}');
    expect(readFileSync(join(repoDir(), '2026-07-14', 'graph.json'), 'utf-8')).toBe('{"old":true}');
  });

  it('migrates a stale/wrong symlink into a real dir even with no vault graph', () => {
    mkdirSync(join(repoRoot, 'somewhere'), { recursive: true });
    symlinkSync('somewhere', repoDir());

    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('migrated');
    const node = lstatSync(repoDir());
    expect(node.isDirectory()).toBe(true);
    expect(node.isSymbolicLink()).toBe(false);
    expect(graphifyOutIsLocalDir(repoRoot)).toBe(true);
  });

  it('seeds a freshly created dir from the vault graph', () => {
    mkdirSync(vault(), { recursive: true });
    writeFileSync(join(vault(), 'graph.json'), '{"nodes":["vault"]}', 'utf-8');

    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('created');
    expect(readFileSync(join(repoDir(), 'graph.json'), 'utf-8')).toBe('{"nodes":["vault"]}');
  });

  it('seeds an existing but graph-less local dir instead of orphaning the vault graph', () => {
    // orbit-app's live state: real local dir holding only build sentinels,
    // while a fully built graph sits unused in the vault. Left unseeded, derive
    // finds no graph and silently degrades to native-only structure.
    mkdirSync(vault(), { recursive: true });
    writeFileSync(join(vault(), 'graph.json'), '{"nodes":["vault"]}', 'utf-8');
    mkdirSync(repoDir(), { recursive: true });
    writeFileSync(join(repoDir(), '.pf-building'), '2026-07-17T14:34:02.359Z', 'utf-8');

    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('noop');
    expect(readFileSync(join(repoDir(), 'graph.json'), 'utf-8')).toBe('{"nodes":["vault"]}');
  });

  it('never overwrites a local graph with the vault copy', () => {
    mkdirSync(vault(), { recursive: true });
    writeFileSync(join(vault(), 'graph.json'), '{"nodes":["vault"]}', 'utf-8');
    mkdirSync(repoDir(), { recursive: true });
    writeFileSync(join(repoDir(), 'graph.json'), '{"nodes":["local"]}', 'utf-8');

    ensureGraphifyOutLocal(repoRoot);
    expect(readFileSync(join(repoDir(), 'graph.json'), 'utf-8')).toBe('{"nodes":["local"]}');
  });

  it('skips (fail-soft) when a plain file blocks the path', () => {
    writeFileSync(repoDir(), 'not a dir', 'utf-8');
    const result = ensureGraphifyOutLocal(repoRoot);
    expect(result.action).toBe('skipped');
    expect(graphifyOutIsLocalDir(repoRoot)).toBe(false);
  });
});
