// Editor "add selection to chat" support (#462). The composer already renders a
// `source: 'file'` context chip and folds its text into the message on send — the
// terminal feeds it via a ⌘L handler dispatching `flow:add-to-chat`. This mirrors
// that for the code editor. Pure/DOM-free bits (the chat label from a file path,
// and whether a selection is sendable) so they're unit-testable; monaco-host owns
// the Monaco action + the event dispatch.

/** The context-chip label for a file path — its base name, or 'File' as a fallback. */
export function fileChatLabel(path: string | null | undefined): string {
  if (!path) return 'File'
  const base = path.split(/[\\/]/).pop()
  return base && base.length > 0 ? base : 'File'
}

/** The trimmed selection to send, or null when there's nothing to add. */
export function sendableSelection(rawText: string | null | undefined): string | null {
  const trimmed = (rawText ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}
