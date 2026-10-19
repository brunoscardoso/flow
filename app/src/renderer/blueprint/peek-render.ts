// Peek-render decisions — pure logic, no DOM, no Monaco (node-testable).
//
// The Monaco peek viewer (peek-viewer.ts) reads a file then has to choose ONE
// of three surfaces: a styled notice pane (no root / read failure / binary /
// too-large), the read-only Monaco editor, or — only when Monaco itself fails
// to load — a plain <pre>. The selection and the little string helpers around
// it are pulled out here so they are exhaustively testable without a DOM or
// the heavy Monaco import (eager structure / tiered semantics — the viewer's
// DOM is covered by typecheck, this brain by unit tests).

import type { FileContent, GitDiff } from '../../shared/ipc-contract'

/** Notice copy — mirrors MonacoHost's placeholder voice for a consistent tone. */
export const PEEK_NO_ROOT_NOTICE = 'No active project.'
export const PEEK_READ_ERROR_NOTICE = 'Unable to read this file.'
export const PEEK_BINARY_NOTICE = '(binary file — contents not shown)'
export const PEEK_TOO_LARGE_NOTICE = '(file too large to preview)'

/** Outcome of the project readFile call the viewer performs. */
export type PeekReadResult = { ok: true; file: FileContent } | { ok: false }

/** How to render the peek body: a short notice, or file content in the editor. */
export type PeekRender =
  | { kind: 'notice'; message: string }
  | { kind: 'editor'; content: string }

/**
 * Decide how to render a peek read result.
 *   - no active root      → "No active project." notice
 *   - read failed         → "Unable to read this file." notice
 *   - too-large           → too-large notice (wins over binary — FileContent
 *                           sets `binary: true` alongside `tooLarge: true`)
 *   - binary              → binary notice
 *   - otherwise           → editor with the file content
 * Total over the input space so the viewer never falls through to a blank pane.
 */
export function decidePeekRender(result: PeekReadResult, hasRoot: boolean): PeekRender {
  if (!hasRoot) return { kind: 'notice', message: PEEK_NO_ROOT_NOTICE }
  if (!result.ok) return { kind: 'notice', message: PEEK_READ_ERROR_NOTICE }
  const { file } = result
  if (file.tooLarge === true) return { kind: 'notice', message: PEEK_TOO_LARGE_NOTICE }
  if (file.binary) return { kind: 'notice', message: PEEK_BINARY_NOTICE }
  return { kind: 'editor', content: file.content }
}

/**
 * Renderer-safe mirror of main's `MAX_FILE_SIZE_BYTES`
 * (`app/src/main/project/files.ts`, 10 MB). The backend sets
 * `FileContent.tooLarge` past that limit — which `decidePeekRender` reads — but a
 * `GitDiff` carries no such flag, so the diff path measures its own combined
 * before/after content length against the same limit. Keep in sync with main.
 */
export const PEEK_MAX_DIFF_BYTES = 10 * 1024 * 1024

/** How to render the diff peek body: a short notice, or the diff editor. */
export type PeekDiffRender = { kind: 'notice'; message: string } | { kind: 'diff' }

/**
 * Decide how to render a working-tree diff peek. Mirrors `decidePeekRender`'s
 * notice-vs-content shape:
 *   - no active root  → "No active project." notice
 *   - binary          → binary notice (`GitDiff.binary`)
 *   - too-large       → too-large notice (combined content past PEEK_MAX_DIFF_BYTES)
 *   - otherwise       → diff editor
 * Total over the input space so the diff view never falls through to a blank pane.
 */
export function decidePeekDiffRender(diff: GitDiff, hasRoot: boolean): PeekDiffRender {
  if (!hasRoot) return { kind: 'notice', message: PEEK_NO_ROOT_NOTICE }
  if (diff.binary === true) return { kind: 'notice', message: PEEK_BINARY_NOTICE }
  const size = diff.beforeContent.length + diff.afterContent.length
  if (size > PEEK_MAX_DIFF_BYTES) return { kind: 'notice', message: PEEK_TOO_LARGE_NOTICE }
  return { kind: 'diff' }
}

/** Escape text for safe insertion into an HTML <pre> (the Monaco-load fallback
 *  builds markup directly rather than through a live editor). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build the Monaco URI for a peek model. A dedicated `peek:` scheme keeps peek
 * models from colliding with the editor's `file:` models for the same path
 * (one model per URI in Monaco), while the preserved extension lets Monaco
 * infer the language on its own — no manual language table.
 */
export function peekModelUri(relPath: string): string {
  const normalized = relPath.replace(/^\/+/, '')
  return `peek:///${normalized}`
}
