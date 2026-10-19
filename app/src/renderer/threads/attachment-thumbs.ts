// Transcript image-thumbnail helpers (#456). Pure/DOM-free bits of rendering a
// user message's image attachments — alt text and the resolved model list — so the
// (async, IPC-backed) src resolution in conversation-pane stays thin and this is
// unit-testable.

export interface ThumbModel {
  id: string
  alt: string
  /** Present when bytes are already in hand (optimistic echo); absent for history
   *  rows, whose bytes are fetched via attachments:read. */
  dataUrl?: string
}

/** Accessible alt text for a thumbnail (never empty). */
export function thumbAlt(fileName: string | undefined): string {
  return fileName && fileName.trim().length > 0 ? fileName : 'Attached image'
}

/** Normalize attachments (with or without bytes) into thumbnail models. */
export function thumbModels(
  attachments: readonly { id: string; fileName?: string; dataUrl?: string }[] | undefined,
): ThumbModel[] {
  if (!attachments || attachments.length === 0) return []
  return attachments.map((attachment) => ({
    id: attachment.id,
    alt: thumbAlt(attachment.fileName),
    dataUrl: attachment.dataUrl,
  }))
}
