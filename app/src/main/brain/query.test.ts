// Brain query tests (#52, Phase 4) — pure ranking + the real filesystem search
// over the trusted tiers, asserting the .raw/ tier is never scanned.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { rankHits, readBrainDocs, searchBrain, terms, type BrainDoc } from './query'
import { isTrustedBrainPath } from './store'

const docs: BrainDoc[] = [
  { path: 'flow/brain/features/auth.md', title: 'User authentication', content: '# User authentication\nTouches auth middleware and login.', kind: 'feature' },
  { path: 'flow/brain/features/theme.md', title: 'Dark theme', content: '# Dark theme\nColor tokens and the theme toggle.', kind: 'feature' },
  { path: 'flow/brain/errors/dlopen.md', title: 'ERR_DLOPEN_FAILED', content: '# ERR_DLOPEN_FAILED\nNative module ABI mismatch.', kind: 'error' },
]

describe('terms (#266)', () => {
  it('keeps CJK / Cyrillic / Greek terms, not just ASCII', () => {
    expect(terms('auth login flow')).toEqual(['auth', 'login', 'flow'])
    expect(terms('認証 ログイン')).toEqual(['認証', 'ログイン'])
    expect(terms('аутентификация')).toEqual(['аутентификация'])
    // Mixed query: the non-Latin term is no longer silently dropped.
    expect(terms('認証 auth')).toEqual(['認証', 'auth'])
  })
})

describe('rankHits', () => {
  it('finds a non-Latin feature memory (#266)', () => {
    const jp: BrainDoc = {
      path: 'flow/brain/features/認証フロー.md',
      title: '認証フロー',
      content: '# 認証フロー\n認証とログインの実装。',
      kind: 'feature',
    }
    const hits = rankHits([...docs, jp], '認証')
    expect(hits[0]?.path).toBe('flow/brain/features/認証フロー.md')
    expect(hits[0]?.kind).toBe('feature')
  })

  it('ranks title matches above content matches and returns the kind', () => {
    const hits = rankHits(docs, 'authentication')
    expect(hits[0].path).toBe('flow/brain/features/auth.md')
    expect(hits[0].kind).toBe('feature')
    expect(hits[0].snippet).toContain('authentication')
  })

  it('returns nothing for an empty query or no matches', () => {
    expect(rankHits(docs, '')).toEqual([])
    expect(rankHits(docs, 'kubernetes')).toEqual([])
  })

  it('respects the limit and orders ties by path', () => {
    expect(rankHits(docs, 'theme auth error native', 2)).toHaveLength(2)
  })
})

describe('searchBrain (real fs) — tier boundary', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('searches trusted tiers but never .raw/', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-query-'))
    mkdirSync(join(dir, 'flow/brain/features'), { recursive: true })
    mkdirSync(join(dir, 'flow/brain/.raw'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/features/widget.md'),
      '# Widget feature\nsecretmarker lives here',
    )
    // A raw capture that also contains the marker — must NOT be returned.
    writeFileSync(join(dir, 'flow/brain/.raw/t1.md'), '# raw\nsecretmarker in raw tier')

    const result = await searchBrain(dir, 'secretmarker')

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].path).toBe('flow/brain/features/widget.md')
  })

  /**
   * THE ORACLE, NOT A SECOND SPELLING OF THE ALLOWLIST.
   *
   * `readBrainDocs` enforces the tier boundary by ENUMERATION — it reads a
   * fixed `MARKDOWN_TIERS` list and never names `.raw/`. `isTrustedBrainPath`
   * (store.ts) states the same boundary declaratively and, until now, was
   * asserted only against string literals in compaction.test.ts: two
   * definitions of one invariant with nothing holding them together, which is
   * how compaction.ts came to credit the unused one with the enforcement.
   *
   * Here the declarative guard judges what the REAL read path actually
   * returned. Widening `MARKDOWN_TIERS` to include `raw`, or replacing its
   * per-tier readdir with a recursive walk of flow/brain/, turns this red —
   * the two ways the allowlist can be opened by accident.
   *
   * FALSIFIED (2026-08-10, this machine): adding `{ sub: 'raw', kind: 'feature' }`
   * to `MARKDOWN_TIERS` fails this test on the untrusted path it lets through,
   * and fails it alone in this file.
   */
  it('every doc the real read path returns is a trusted path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brain-query-'))
    for (const sub of ['features', 'errors', 'decisions', '.raw']) {
      mkdirSync(join(dir, 'flow/brain', sub), { recursive: true })
    }
    writeFileSync(join(dir, 'flow/brain/features/widget.md'), '# Widget\nleakmarker')
    writeFileSync(join(dir, 'flow/brain/errors/dlopen.md'), '# Dlopen\nleakmarker')
    writeFileSync(join(dir, 'flow/brain/decisions/schema.md'), '# Schema\nleakmarker')
    // Both shapes a capture can take on disk: the `.json` capture.ts really
    // writes, and a `.md` one, so a reader that filters by extension rather
    // than by tier is not accidentally passed by this test.
    writeFileSync(join(dir, 'flow/brain/.raw/t1.json'), '{"title":"leakmarker"}')
    writeFileSync(join(dir, 'flow/brain/.raw/t2.md'), '# Raw capture\nleakmarker')

    const docs = await readBrainDocs(dir)
    const untrusted = docs.map((doc) => doc.path).filter((path) => !isTrustedBrainPath(path))
    expect(untrusted).toEqual([])
    // …and the same statement about what a caller can actually see.
    const { hits } = await searchBrain(dir, 'leakmarker', 50)
    expect(hits.map((hit) => hit.path).filter((path) => !isTrustedBrainPath(path))).toEqual([])
    // Not vacuous: the trusted tiers really were read.
    expect(hits.length).toBe(3)
  })
})
