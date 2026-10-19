// User-facing feedback for thread send actions (#180, #279). Both the Review
// "reject → redo" flow AND the primary composer optimistically echo a user bubble
// and start the loader before sending; when the send rejects, the failure was
// swallowed to console and the phantom bubble + spinner stayed, misrepresenting
// that the message was delivered (forbidden pattern #2). These pure builders turn
// the failure into a toast; the caller rolls back the bubble/loader and dispatches
// it via the flow:notify → NotificationCenter.

export interface RedoToast {
  title: string
  body: string
  level: 'info' | 'error'
}

/** Readable text from an unknown thrown value. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === '[object Object]' ? 'Unknown error' : text
}

/** A failed redo send → toast naming the file, so the user knows to retry. */
export function redoFailedToast(filePath: string, error: unknown): RedoToast {
  return {
    title: "Couldn't send redo request",
    body: `The agent didn't receive your redo of ${filePath} — ${errorText(error)}. Try again.`,
    level: 'error',
  }
}

/** A failed primary-composer send → toast, so the user knows it wasn't delivered (#279). */
export function sendFailedToast(error: unknown): RedoToast {
  return {
    title: "Couldn't send message",
    body: `${errorText(error)} — your message wasn't delivered. Try again.`,
    level: 'error',
  }
}
