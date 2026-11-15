/**
 * A user terminal's typed line — the hot path of command usage
 * (run/command-usage.ts). Per keystroke it appends to a string; a line counts
 * only when Enter ends it and it was typed plainly. An escape sequence
 * (arrows, history recall, a bracketed paste) or a control key (Tab
 * completion, Ctrl-R) makes what the shell runs unknowable, so that line is
 * dropped. Ctrl-C and Ctrl-U start over.
 */

/** A line longer than this is not something a person typed to start a process. */
export const MAX_LINE_LENGTH = 1000

export interface LineBuffer {
  text: string
  /** Something made this line unreliable; it is dropped at Enter. */
  tainted: boolean
}

export function newLineBuffer(): LineBuffer {
  return { text: '', tainted: false }
}

/**
 * Feed keystrokes into a terminal's line buffer. Returns the lines completed
 * by Enter that were typed plainly (trimmed, non-empty) — usually none.
 */
export function feedLine(buffer: LineBuffer, data: string): string[] {
  let done: string[] | null = null
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index]!
    const code = char.charCodeAt(0)
    if (char === '\r' || char === '\n') {
      const line = buffer.text.trim()
      if (!buffer.tainted && line !== '') (done ??= []).push(line)
      buffer.text = ''
      buffer.tainted = false
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C abandons the line; Ctrl-U erases it.
      buffer.text = ''
      buffer.tainted = false
    } else if (code === 0x7f || code === 0x08) {
      buffer.text = buffer.text.slice(0, -1)
    } else if (code < 0x20) {
      // Escape (arrows, history, paste brackets), Tab completion, Ctrl-R…
      buffer.tainted = true
    } else if (buffer.text.length < MAX_LINE_LENGTH) {
      buffer.text += char
    } else {
      buffer.tainted = true
    }
  }
  return done ?? []
}

