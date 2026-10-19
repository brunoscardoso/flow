// Brain query (#52, Phase 4) — the single retrieval interface over the TRUSTED
// brain tiers (features / errors / decisions). `.raw/` is never scanned, so
// un-compacted captures can never surface as fact (the tier boundary).
//
// A deterministic term-frequency search over the feature/error/decision
// markdown — enough for "what files relate to feature X" without re-scanning the
// codebase. This is now the ONLY shape retrieval takes: the FTS/vector index
// that was once meant to back this interface has been retired, and the CLI's
// `brain search` reads the same markdown by the same principle.

import { promises as fsPromises } from 'fs'
import { join } from 'path'

import type { BrainHit, BrainKind, BrainQueryResult } from '../../shared/ipc-contract'
import { BRAIN_SUBDIRS, type BrainSubdir } from './store'

const DEFAULT_LIMIT = 5
const TITLE_WEIGHT = 3
const SNIPPET_MAX = 200

/** Trusted markdown tiers, mapped to their hit kind. */
const MARKDOWN_TIERS: ReadonlyArray<{ sub: BrainSubdir; kind: BrainKind }> = [
  { sub: 'features', kind: 'feature' },
  { sub: 'errors', kind: 'error' },
  { sub: 'decisions', kind: 'decision' },
]

export interface BrainDoc {
  /** Root-relative POSIX path. */
  path: string
  title: string
  content: string
  kind: BrainKind
}

/**
 * Lowercase word terms of a query string. Splits on Unicode letter/number
 * boundaries (`\p{L}\p{N}`, u flag) so CJK/Cyrillic/Greek terms survive — an
 * ASCII-only class discarded every non-Latin character, making brain content
 * written in a non-Latin script (which #168 made first-class) unsearchable (#266).
 * Exported for tests.
 */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function firstMatchingSnippet(content: string, queryTerms: string[]): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (queryTerms.some((t) => lower.includes(t))) {
      return line.trim().slice(0, SNIPPET_MAX)
    }
  }
  const firstNonEmpty = lines.find((l) => l.trim().length > 0)
  return (firstNonEmpty ?? '').trim().slice(0, SNIPPET_MAX)
}

/**
 * Rank docs against a query by term frequency (title weighted). Pure and
 * deterministic — ties broken by path for stable ordering. Returns at most
 * `limit` hits, dropping zero-score docs.
 */
export function rankHits(
  docs: readonly BrainDoc[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): BrainHit[] {
  const queryTerms = terms(query)
  if (queryTerms.length === 0) return []

  const scored = docs
    .map((doc) => {
      const title = doc.title.toLowerCase()
      const content = doc.content.toLowerCase()
      let score = 0
      for (const term of queryTerms) {
        score += countOccurrences(title, term) * TITLE_WEIGHT
        score += countOccurrences(content, term)
      }
      return { doc, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path))

  return scored.slice(0, Math.max(0, limit)).map(({ doc }) => ({
    path: doc.path,
    title: doc.title,
    snippet: firstMatchingSnippet(doc.content, queryTerms),
    kind: doc.kind,
  }))
}

/** First markdown heading (`# ...`) or the filename stem as the doc title. */
function titleOf(content: string, fallback: string): string {
  const heading = content.split('\n').find((l) => l.startsWith('# '))
  return heading ? heading.replace(/^#\s+/, '').trim() : fallback
}

export interface QueryDeps {
  listMarkdown: (dir: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
}

export function fsQueryDeps(): QueryDeps {
  return {
    listMarkdown: async (dir) => {
      try {
        return (await fsPromises.readdir(dir)).filter((n) => n.endsWith('.md'))
      } catch {
        return []
      }
    },
    readFile: (path) => fsPromises.readFile(path, 'utf8'),
  }
}

/** Load all docs from the trusted markdown tiers (never `.raw/`). */
export async function readBrainDocs(
  rootPath: string,
  deps: QueryDeps = fsQueryDeps(),
): Promise<BrainDoc[]> {
  const docs: BrainDoc[] = []
  for (const tier of MARKDOWN_TIERS) {
    const dir = join(rootPath, BRAIN_SUBDIRS[tier.sub])
    const names = await deps.listMarkdown(dir)
    for (const name of names) {
      const content = await deps.readFile(join(dir, name))
      docs.push({
        path: `${BRAIN_SUBDIRS[tier.sub]}/${name}`,
        title: titleOf(content, name.replace(/\.md$/, '')),
        content,
        kind: tier.kind,
      })
    }
  }
  return docs
}

/** Search the trusted brain tiers and return ranked hits. */
export async function searchBrain(
  rootPath: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
  deps: QueryDeps = fsQueryDeps(),
): Promise<BrainQueryResult> {
  const docs = await readBrainDocs(rootPath, deps)
  return { hits: rankHits(docs, query, limit) }
}
