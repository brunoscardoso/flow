// Composer image-attachment chip state (#456). Pure add/dismiss/dedupe/cap over the
// pending attachments the user has attached but not yet sent — mirrors context-chips,
// but each entry is a MessageAttachmentInput (carries the base64 bytes, used both for
// the thumbnail preview and the send payload). DOM-free → unit-testable; the composer
// owns the thumbnail rendering and the file/paste/capture decoding.
import type { MessageAttachmentInput } from '../../shared/ipc-contract'
import { canAddAttachment } from './image-attachment'

/** Why an add did (or didn't) grow the list — 'duplicate' stays silent, but a
 *  'cap-reached' drop must be surfaced to the user (#649: no silent failures,
 *  matching the validation-reject toasts). */
export type AttachmentAddOutcome = 'added' | 'duplicate' | 'cap-reached'

/** Add an attachment, deduping by id and enforcing the per-message cap, and say
 *  WHICH of the three happened. The returned list is the ORIGINAL array
 *  unchanged unless the outcome is 'added'. */
export function addAttachmentWithOutcome(
  list: readonly MessageAttachmentInput[],
  item: MessageAttachmentInput,
): { list: readonly MessageAttachmentInput[]; outcome: AttachmentAddOutcome } {
  if (list.some((existing) => existing.id === item.id)) return { list, outcome: 'duplicate' }
  if (!canAddAttachment(list.length)) return { list, outcome: 'cap-reached' }
  return { list: [...list, item], outcome: 'added' }
}

/** Outcome-less convenience wrapper (callers that don't need feedback). */
export function addAttachment(
  list: readonly MessageAttachmentInput[],
  item: MessageAttachmentInput,
): readonly MessageAttachmentInput[] {
  return addAttachmentWithOutcome(list, item).list
}

/** Remove the attachment with the given id (missing id → original array). */
export function removeAttachment(
  list: readonly MessageAttachmentInput[],
  id: string,
): readonly MessageAttachmentInput[] {
  if (!list.some((existing) => existing.id === id)) return list
  return list.filter((existing) => existing.id !== id)
}

/** A data URL for previewing/rendering an attachment's bytes. */
export function attachmentDataUrl(item: {
  mediaType: string
  dataBase64: string
}): string {
  return `data:${item.mediaType};base64,${item.dataBase64}`
}
