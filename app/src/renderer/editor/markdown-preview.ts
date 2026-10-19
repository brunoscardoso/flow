// Markdown preview helpers (#575). The editor lets a `.md`/`.markdown` file
// toggle between its Monaco source buffer and a rendered preview. The decision
// of "is this a markdown file" is a pure, extension-only test kept here so it is
// unit-testable in isolation from the DOM-heavy editor wiring in index.ts.

/**
 * True when `path` names a Markdown file by extension (case-insensitive).
 * Recognizes `.md` and `.markdown`. A path is any absolute file path or tab id;
 * non-file tab ids (e.g. `flow://blueprint`) never match.
 */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

/** Toggle-button label for the current mode: "Preview" when showing source,
 *  "Source" when the rendered preview is showing. */
export function previewToggleLabel(previewOn: boolean): string {
  return previewOn ? 'Source' : 'Preview'
}
