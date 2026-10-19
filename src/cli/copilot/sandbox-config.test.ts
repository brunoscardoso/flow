/**
 * Tests for Copilot local-sandbox compatibility (#1928).
 *
 * Real temp dirs + dependency injection (COPILOT_HOME / platform / logger) —
 * no node:fs mocking and no PATH/global-env stubs (allowed-pattern #12). Each
 * test builds an isolated project root (optionally with a flow/ symlink to an
 * outside "vault") and an isolated fake ~/.copilot home.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  COPILOT_WRITABLE_PATHS_KEY,
  copilotHome,
  copilotSettingsPath,
  pathIsCoveredBy,
  resolveVaultWritableTarget,
  mergeWritablePath,
  ensureCopilotSandboxAccess,
  type SandboxLogger,
} from './sandbox-config';

let counter = 0;
function tmp(prefix: string): string {
  const dir = join(tmpdir(), `pf-copilot-${prefix}-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeLogger(): SandboxLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    success: (m: string) => messages.push(`success:${m}`),
    warn: (m: string) => messages.push(`warn:${m}`),
    info: (m: string) => messages.push(`info:${m}`),
  };
}

/** A project whose flow/ symlinks to an OUTSIDE vault dir — the #1928 shape. */
function projectWithVaultSymlink(): { root: string; vaultFlow: string; cleanup: () => void } {
  const root = tmp('proj');
  const vault = tmp('vault');
  const vaultFlow = join(vault, 'brain', 'projects', 'demo', 'flow');
  mkdirSync(vaultFlow, { recursive: true });
  symlinkSync(vaultFlow, join(root, 'flow'));
  return {
    root,
    vaultFlow: realpathSync(vaultFlow),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    },
  };
}

describe('copilotHome / copilotSettingsPath', () => {
  it('honors COPILOT_HOME override', () => {
    expect(copilotHome({ COPILOT_HOME: '/custom/.copilot' })).toBe('/custom/.copilot');
    expect(copilotSettingsPath({ COPILOT_HOME: '/custom/.copilot' })).toBe(
      join('/custom/.copilot', 'settings.json'),
    );
  });

  it('falls back to ~/.copilot when unset/empty', () => {
    expect(copilotHome({}).endsWith(join('.copilot'))).toBe(true);
    expect(copilotHome({ COPILOT_HOME: '' }).endsWith(join('.copilot'))).toBe(true);
  });
});

describe('pathIsCoveredBy', () => {
  it('covers self and descendants, not siblings/ancestors', () => {
    expect(pathIsCoveredBy('/a/b', '/a/b')).toBe(true);
    expect(pathIsCoveredBy('/a/b', '/a/b/c')).toBe(true);
    expect(pathIsCoveredBy('/a/b', '/a/bc')).toBe(false); // prefix but not nested
    expect(pathIsCoveredBy('/a/b', '/a')).toBe(false);
    expect(pathIsCoveredBy('/a/b', '/x/y')).toBe(false);
  });
});

describe('resolveVaultWritableTarget', () => {
  it('returns the resolved vault target for an outside flow/ symlink', () => {
    const { root, vaultFlow, cleanup } = projectWithVaultSymlink();
    try {
      expect(resolveVaultWritableTarget(root)).toBe(vaultFlow);
    } finally {
      cleanup();
    }
  });

  it('returns null when flow/ is a real directory', () => {
    const root = tmp('proj-realdir');
    try {
      mkdirSync(join(root, 'flow'));
      expect(resolveVaultWritableTarget(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when flow/ is missing', () => {
    const root = tmp('proj-noflow');
    try {
      expect(resolveVaultWritableTarget(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when flow/ symlinks INSIDE the project root', () => {
    const root = tmp('proj-inside');
    try {
      const inside = join(root, 'real-flow');
      mkdirSync(inside);
      symlinkSync(inside, join(root, 'flow'));
      expect(resolveVaultWritableTarget(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeWritablePath', () => {
  const KEY = COPILOT_WRITABLE_PATHS_KEY; // 'sandbox.userPolicy.readwritePaths'

  function readList(settings: Record<string, unknown>): unknown {
    return (
      ((settings.sandbox as any)?.userPolicy?.readwritePaths) ?? undefined
    );
  }

  it('adds the target into the nested key, creating intermediate objects', () => {
    const { changed, settings } = mergeWritablePath({}, '/vault/flow');
    expect(changed).toBe(true);
    expect(readList(settings)).toEqual(['/vault/flow']);
    expect(KEY).toBe('sandbox.userPolicy.readwritePaths');
  });

  it('is idempotent — an exact existing entry means no change', () => {
    const first = mergeWritablePath({}, '/vault/flow').settings;
    const { changed, settings } = mergeWritablePath(first, '/vault/flow');
    expect(changed).toBe(false);
    expect(readList(settings)).toEqual(['/vault/flow']);
  });

  it('treats a covering ancestor as already-allowed (no narrower add)', () => {
    const withRoot = mergeWritablePath({}, '/vault').settings;
    const { changed } = mergeWritablePath(withRoot, '/vault/brain/projects/demo/flow');
    expect(changed).toBe(false);
  });

  it('preserves unknown sibling keys and does not mutate the input', () => {
    const input = {
      model: 'gpt-x',
      sandbox: { enabled: true, userPolicy: { deniedPaths: ['/secret'] } },
    };
    const snapshot = JSON.stringify(input);
    const { changed, settings } = mergeWritablePath(input, '/vault/flow');
    expect(changed).toBe(true);
    // input untouched
    expect(JSON.stringify(input)).toBe(snapshot);
    // siblings preserved
    expect((settings as any).model).toBe('gpt-x');
    expect((settings as any).sandbox.enabled).toBe(true);
    expect((settings as any).sandbox.userPolicy.deniedPaths).toEqual(['/secret']);
    expect((settings as any).sandbox.userPolicy.readwritePaths).toEqual(['/vault/flow']);
  });

  it('appends alongside a pre-existing unrelated read-write path', () => {
    const input = { sandbox: { userPolicy: { readwritePaths: ['/other'] } } };
    const { changed, settings } = mergeWritablePath(input, '/vault/flow');
    expect(changed).toBe(true);
    expect(readList(settings)).toEqual(['/other', '/vault/flow']);
  });
});

describe('ensureCopilotSandboxAccess', () => {
  it('grants: writes the vault target into a fresh settings.json', () => {
    const { root, vaultFlow, cleanup } = projectWithVaultSymlink();
    const home = tmp('copilot-home'); // exists → Copilot "present"
    const logger = fakeLogger();
    try {
      const res = ensureCopilotSandboxAccess(root, {
        env: { COPILOT_HOME: home },
        platform: 'darwin',
        logger,
      });
      expect(res.status).toBe('granted');
      expect(res.target).toBe(vaultFlow);
      const written = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf-8'));
      expect(written.sandbox.userPolicy.readwritePaths).toEqual([vaultFlow]);
      expect(logger.messages.some((m) => m.startsWith('success:'))).toBe(true);
    } finally {
      cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('already-allowed: second run makes no change (idempotent)', () => {
    const { root, cleanup } = projectWithVaultSymlink();
    const home = tmp('copilot-home');
    try {
      const env = { COPILOT_HOME: home };
      const first = ensureCopilotSandboxAccess(root, { env, platform: 'darwin' });
      expect(first.status).toBe('granted');
      const before = readFileSync(join(home, 'settings.json'), 'utf-8');
      const second = ensureCopilotSandboxAccess(root, { env, platform: 'darwin' });
      expect(second.status).toBe('already-allowed');
      expect(readFileSync(join(home, 'settings.json'), 'utf-8')).toBe(before); // byte-identical
    } finally {
      cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('no-copilot: ~/.copilot absent → silent no-op, no file created', () => {
    const { root, cleanup } = projectWithVaultSymlink();
    const home = join(tmpdir(), `pf-copilot-absent-${Date.now()}-${counter++}`); // not created
    const logger = fakeLogger();
    try {
      const res = ensureCopilotSandboxAccess(root, {
        env: { COPILOT_HOME: home },
        platform: 'darwin',
        logger,
      });
      expect(res.status).toBe('no-copilot');
      expect(existsSync(home)).toBe(false);
      expect(logger.messages).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('skipped-windows: never writes on win32', () => {
    const { root, cleanup } = projectWithVaultSymlink();
    const home = tmp('copilot-home');
    const logger = fakeLogger();
    try {
      const res = ensureCopilotSandboxAccess(root, {
        env: { COPILOT_HOME: home },
        platform: 'win32',
        logger,
      });
      expect(res.status).toBe('skipped-windows');
      expect(existsSync(join(home, 'settings.json'))).toBe(false);
      expect(logger.messages.some((m) => m.startsWith('warn:'))).toBe(true);
    } finally {
      cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('not-symlinked: real flow/ dir → nothing to grant, no write', () => {
    const root = tmp('proj-realdir');
    const home = tmp('copilot-home');
    try {
      mkdirSync(join(root, 'flow'));
      const res = ensureCopilotSandboxAccess(root, {
        env: { COPILOT_HOME: home },
        platform: 'darwin',
      });
      expect(res.status).toBe('not-symlinked');
      expect(existsSync(join(home, 'settings.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('error (fail-soft): malformed settings.json is left untouched, one notice', () => {
    const { root, cleanup } = projectWithVaultSymlink();
    const home = tmp('copilot-home');
    const logger = fakeLogger();
    try {
      const settingsPath = join(home, 'settings.json');
      writeFileSync(settingsPath, '{ this is not json', 'utf-8');
      const res = ensureCopilotSandboxAccess(root, {
        env: { COPILOT_HOME: home },
        platform: 'darwin',
        logger,
      });
      expect(res.status).toBe('error');
      // untouched
      expect(readFileSync(settingsPath, 'utf-8')).toBe('{ this is not json');
      expect(logger.messages.some((m) => m.startsWith('warn:'))).toBe(true);
    } finally {
      cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves other keys in an existing settings.json when granting', () => {
    const { root, vaultFlow, cleanup } = projectWithVaultSymlink();
    const home = tmp('copilot-home');
    try {
      const settingsPath = join(home, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({ model: 'x', sandbox: { enabled: true } }, null, 2),
        'utf-8',
      );
      const res = ensureCopilotSandboxAccess(root, {
        env: { COPILOT_HOME: home },
        platform: 'darwin',
      });
      expect(res.status).toBe('granted');
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.model).toBe('x');
      expect(written.sandbox.enabled).toBe(true);
      expect(written.sandbox.userPolicy.readwritePaths).toEqual([vaultFlow]);
    } finally {
      cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
