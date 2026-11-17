// Pure parsers for the Source Control graph: a commit's refs (from `%D` with
// `--decorate=full`) and a commit's changed files (`diff-tree --name-status -z`
// joined with `--numstat -z`). DOM-free, Node-free, unit-tested.

import type { GitCommitFile, GitCommitRef, GitFileState } from '../../shared/ipc-contract'

/** At most this many refs ride one commit — a tag-per-build repo must not bloat a page. */
export const MAX_REFS_PER_COMMIT = 8

/**
 * `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.2`
 * into typed refs. Full ref names are asked for on purpose: with short names a
 * local branch called `origin/x` and the remote branch `origin/x` are the same
 * string, and the badge would claim the wrong one.
 */
export function parseDecorations(raw: string): GitCommitRef[] {
  const refs: GitCommitRef[] = []
  for (const part of raw.split(',')) {
    let token = part.trim()
    if (token.length === 0) continue
    let current = false
    if (token === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' })
      continue
    }
    if (token.startsWith('HEAD -> ')) {
      current = true
      token = token.slice('HEAD -> '.length).trim()
    }
    if (token.startsWith('tag: ')) {
      const name = token.slice('tag: '.length).replace(/^refs\/tags\//, '')
      refs.push({ kind: 'tag', name })
      continue
    }
    if (token.startsWith('refs/heads/')) {
      refs.push({ kind: 'branch', name: token.slice('refs/heads/'.length), ...(current ? { current: true } : {}) })
      continue
    }
    if (token.startsWith('refs/remotes/')) {
      const name = token.slice('refs/remotes/'.length)
      // `origin/HEAD` is a pointer, not a branch anybody works on.
      if (name.endsWith('/HEAD')) continue
      refs.push({ kind: 'remote', name })
      continue
    }
    if (token.startsWith('refs/tags/')) {
      refs.push({ kind: 'tag', name: token.slice('refs/tags/'.length) })
      continue
    }
    // refs/stash, refs/notes, anything else: not something the graph labels.
  }
  // The current branch first, then branches, remotes, tags — the order a reader scans.
  const rank = (ref: GitCommitRef): number =>
    ref.kind === 'head' ? 0 : ref.kind === 'branch' ? (ref.current === true ? 0 : 1) : ref.kind === 'remote' ? 2 : 3
  return refs.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_REFS_PER_COMMIT)
}

function stateFromLetter(letter: string): GitFileState {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

interface NameStatusEntry {
  state: GitFileState
  path: string
  renamedFrom?: string
}

/** `M\0path\0R100\0old\0new\0…` → entries (repo-relative paths). */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\0')
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const status = (tokens[i] ?? '').trim()
    if (status.length === 0) {
      i += 1
      continue
    }
    const letter = status[0] ?? 'M'
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1] ?? ''
      const to = tokens[i + 2] ?? ''
      if (to.length > 0) {
        entries.push(letter === 'R' ? { state: 'renamed', path: to, renamedFrom: from } : { state: 'added', path: to })
      }
      i += 3
      continue
    }
    const path = tokens[i + 1] ?? ''
    if (path.length > 0) entries.push({ state: stateFromLetter(letter), path })
    i += 2
  }
  return entries
}

/** `12\t3\tpath\0` / `1\t1\t\0old\0new\0` / `-\t-\tbin\0` → counts by (new) path. */
export function parseNumstatZ(raw: string): Map<string, { added: number | null; deleted: number | null }> {
  const counts = new Map<string, { added: number | null; deleted: number | null }>()
  const tokens = raw.split('\0')
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (token.trim().length === 0) {
      i += 1
      continue
    }
    const parts = token.split('\t')
    const added = parts[0] === '-' ? null : Number(parts[0])
    const deleted = parts[1] === '-' ? null : Number(parts[1])
    const value = {
      added: added === null || Number.isNaN(added) ? null : added,
      deleted: deleted === null || Number.isNaN(deleted) ? null : deleted,
    }
    const path = parts.slice(2).join('\t')
    if (path.length > 0) {
      counts.set(path, value)
      i += 1
      continue
    }
    // A rename: the two paths follow as their own NUL-terminated tokens.
    const to = tokens[i + 2] ?? ''
    if (to.length > 0) counts.set(to, value)
    i += 3
  }
  return counts
}

/**
 * Join the two reads and re-express each path inside the project (#1040): a
 * project opened in a subfolder of its repository shows only what lies under
 * that folder, project-relative — the same rule the status listing follows.
 */
export function buildCommitFiles(
  nameStatus: string,
  numstat: string,
  prefix: string,
  cap: number,
): { files: GitCommitFile[]; total: number; truncated: boolean } {
  const counts = parseNumstatZ(numstat)
  const files: GitCommitFile[] = []
  for (const entry of parseNameStatusZ(nameStatus)) {
    if (prefix && !entry.path.startsWith(prefix)) continue
    const count = counts.get(entry.path) ?? { added: null, deleted: null }
    const renamedFrom =
      entry.renamedFrom === undefined
        ? undefined
        : prefix && entry.renamedFrom.startsWith(prefix)
          ? entry.renamedFrom.slice(prefix.length)
          : entry.renamedFrom
    files.push({
      filePath: prefix ? entry.path.slice(prefix.length) : entry.path,
      state: entry.state,
      added: count.added,
      deleted: count.deleted,
      ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    })
  }
  return { files: files.slice(0, cap), total: files.length, truncated: files.length > cap }
}
