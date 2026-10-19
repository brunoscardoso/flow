// looksLikeFilePath is pure (no DOM) — lives in its own module so it tests under
// the node env (markdown-renderer, its consumer, references `document`).

import { looksLikeFilePath } from './file-path'

describe('looksLikeFilePath', () => {
  it('matches paths with a recognized extension', () => {
    for (const p of [
      'flow/reviewed-pr/pr-notes-120160-acme-2083-2084-2085-onedrive-fe.md',
      'flow/tasklist.md',
      '/Users/me/project/flow/brain/index.md',
      'OfficeFileCanvas/index.tsx',
      'useOneDriveDelegateAuth.ts',
      'RestAPI.ts',
      'src/app.py',
      'config.yaml',
      'package.json',
    ]) {
      expect(looksLikeFilePath(p)).toBe(true)
    }
  })

  it('does not match code symbols or expressions', () => {
    for (const s of [
      'window.opener',
      'MAX_BODY_SIZE = 8192',
      'useOneDriveDelegateAuth',
      'deleteOneDriveDelegateToken()',
      'OfficeFileCanvasState',
      'BroadcastChannel',
      'saveToOneDrive',
      'v1.2',
      '3.10',
    ]) {
      expect(looksLikeFilePath(s)).toBe(false)
    }
  })

  it('excludes URLs, directories, and whitespace-bearing spans', () => {
    expect(looksLikeFilePath('https://example.com/a.md')).toBe(false)
    expect(looksLikeFilePath('file:///tmp/a.ts')).toBe(false)
    expect(looksLikeFilePath('flow/plans/')).toBe(false)
    expect(looksLikeFilePath('see index.ts here')).toBe(false)
    expect(looksLikeFilePath('')).toBe(false)
  })

  it('excludes bare framework brand names, any casing (#656)', () => {
    for (const brand of ['Node.js', 'Vue.js', 'Next.js', 'Nuxt.js', 'Three.js', 'D3.js', 'node.js', 'REACT.JS']) {
      expect(looksLikeFilePath(brand)).toBe(false)
    }
  })

  it('still matches brand-named files that carry a path, and real bare files (#656)', () => {
    expect(looksLikeFilePath('vendor/three.js')).toBe(true)
    expect(looksLikeFilePath('dist/vue.js')).toBe(true)
    expect(looksLikeFilePath('App.js')).toBe(true)
    expect(looksLikeFilePath('index.js')).toBe(true)
    expect(looksLikeFilePath('next.config.js')).toBe(true)
    expect(looksLikeFilePath('package.json')).toBe(true)
  })
})
