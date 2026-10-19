// Bounded collector for an agent Bash command's output (#271). runCommand
// accumulated a command's entire output into one in-memory string in the
// Electron MAIN process with NO cap, then returned it whole to the model — so a
// single high-volume command inside the timeout window (cat of a large file,
// find /, yes, base64 /dev/urandom) could grow hundreds of MB and OOM/crash the
// whole app, and blow the model's context/cost. The display scrollback was
// bounded for exactly this reason in #171; this is the sibling collect path.
//
// Keeps the HEAD up to a char budget (what a command's result usually leads
// with; the exit code is returned separately), counts the overflow, and appends
// a clear truncation notice. Pure + PTY-free so the bound unit-tests directly.

/** Truncation notice appended to the returned output when anything was dropped. */
export function truncationNotice(omitted: number): string {
  return `\n[output truncated: ${omitted} bytes omitted]`
}

export class BoundedOutputCollector {
  #text = ''
  #omitted = 0
  readonly #maxChars: number

  constructor(maxChars: number) {
    this.#maxChars = maxChars
  }

  /** Append a chunk, keeping at most maxChars total; overflow is counted, not stored. */
  append(data: string): void {
    const room = this.#maxChars - this.#text.length
    if (room <= 0) {
      this.#omitted += data.length
      return
    }
    if (data.length <= room) {
      this.#text += data
      return
    }
    this.#text += data.slice(0, room)
    this.#omitted += data.length - room
  }

  /** How many characters were dropped (0 when nothing was truncated). */
  get omitted(): number {
    return this.#omitted
  }

  /** The bounded output, with a truncation notice appended iff anything was dropped. */
  result(): string {
    return this.#omitted > 0 ? this.#text + truncationNotice(this.#omitted) : this.#text
  }
}
