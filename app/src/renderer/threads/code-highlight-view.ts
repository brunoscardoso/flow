/**
 * The DOM half of the chat's code highlighting — see `code-highlight.ts` for
 * the decisions, which live apart from this because the app's node-env jest
 * cannot import a module that names `HTMLElement`.
 */
import type { EditorApi } from '../editor'
import { monacoLanguageFor, planCodeSpans } from './code-highlight'

/**
 * The editor whose tokenizer the chat borrows, once the shell has one.
 *
 * REGISTERED RATHER THAN THREADED. `renderMarkdown` is called from a dozen
 * places — the feed, tool cards, artifact cards, the story card — and none of
 * them has an `EditorApi` or any reason to. Passing one through every call site
 * to reach a detail of how a fence is painted would put the editor in the
 * signature of every renderer in the app.
 *
 * Null until `initEditor` has run, and a code block rendered before then simply
 * stays plain — which is also what happens if the editor never initialises at
 * all. Nothing waits on this.
 */
let highlightEditor: Pick<EditorApi, 'monaco'> | null = null

/** Lend the chat the editor's tokenizer. Called once, from the shell's boot. */
export function useEditorForCodeHighlighting(api: Pick<EditorApi, 'monaco'>): void {
  highlightEditor = api
}

/** Colour one rendered code block, if anything can. Never throws, never waits. */
export async function highlightCodeBlock(
  code: HTMLElement,
  fenceTag: string,
  body: string,
): Promise<boolean> {
  if (highlightEditor === null) return false
  return highlightCode(code, fenceTag, body, highlightEditor)
}

/** Monaco's tokenizer surface, narrowed to what this needs. */
interface Tokenizer {
  editor: {
    tokenize(text: string, languageId: string): Array<Array<{ offset: number; type: string }>>
    colorize(text: string, languageId: string, options: object): Promise<string>
  }
}

/**
 * Colour a code element's existing text in place.
 *
 * Returns false when nothing was done — an unknown language, a tokenizer that
 * would not load, or an element that left the DOM while we were waiting. The
 * caller has already rendered the plain text, so every one of those is a
 * no-op the reader never sees rather than an error they do.
 */
export async function highlightCode(
  code: HTMLElement,
  fenceTag: string,
  body: string,
  editor: Pick<EditorApi, 'monaco'> | undefined,
): Promise<boolean> {
  const language = monacoLanguageFor(fenceTag)
  if (language === null || editor === undefined || body.trim() === '') return false
  let monaco: Tokenizer
  try {
    monaco = (await editor.monaco()) as unknown as Tokenizer
  } catch {
    // The editor chunk failed to load. The block is already readable.
    return false
  }
  // The element can be replaced while the chunk loads — a streaming turn
  // rewrites its tail, and a reconcile rebuilds the feed.
  if (!code.isConnected || code.textContent !== body) return false
  let lines: Array<Array<{ offset: number; type: string }>>
  try {
    // A LANGUAGE'S TOKENIZER IS REGISTERED LAZILY, and `tokenize` does not wait
    // for it — asked about a language whose contribution has not loaded, it
    // answers one token per line typed '', which is indistinguishable from
    // "this text has no syntax" and paints nothing. `colorize` is the one
    // public call that awaits the registration, so it is used here for that
    // side effect only; the spans still come from `tokenize`, because
    // colorize's own output is an HTML string this renderer must not take.
    await monaco.editor.colorize('', language, {})
    lines = monaco.editor.tokenize(body, language)
  } catch {
    return false
  }
  paintTokens(code, body, lines)
  return true
}

/**
 * Write the planned runs into the element, as text nodes and classed spans.
 *
 * Never `innerHTML`: Monaco offers `colorize()`, which returns an HTML string
 * and would be one assignment, but the markdown renderer's invariant is that
 * everything reaches the DOM through text. Code containing markup has to end up
 * as characters on screen, not as nodes in the document.
 */
export function paintTokens(
  code: HTMLElement,
  body: string,
  lines: ReadonlyArray<ReadonlyArray<{ offset: number; type: string }>>,
): void {
  const fragment = document.createDocumentFragment()
  for (const span of planCodeSpans(body, lines)) {
    if (span.className === null) {
      fragment.appendChild(document.createTextNode(span.text))
      continue
    }
    const el = document.createElement('span')
    el.className = span.className
    el.textContent = span.text
    fragment.appendChild(el)
  }
  code.textContent = ''
  code.appendChild(fragment)
}
