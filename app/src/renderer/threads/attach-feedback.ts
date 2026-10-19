// Feedback when a reference is attached while the composer is hidden (#366). Both
// the Blueprint "Attach to chat" affordance (flow:blueprint-selected) and the
// terminal cmd+L path (flow:add-to-chat, #152) add a chip to the composer — but the
// composer is display:none until a thread is active, so with no thread open the click
// showed NO feedback (the chip only surfaced later, if the user opened a chat). This
// pure builder turns that into a toast so the attach is never a silent no-op; the
// Composer dispatches it via the flow:notify → NotificationCenter bridge.

export interface AttachToast {
  title: string
  body: string
  level: 'info'
}

/** Toast confirming a reference was attached but the composer isn't visible yet. */
export function attachedWhileHiddenToast(label: string): AttachToast {
  return {
    title: 'Attached to chat',
    body: `${label} will be included in your message when you open or start a chat.`,
    level: 'info',
  }
}
