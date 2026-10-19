// Shared terminal exit marker (#446). The `[process exited with code N]` line was
// written renderer-side only, so it never made it into main's replayed scrollback —
// a window reopened from the dock (macOS keeps the app alive) showed the dead shell
// with no marker and no way to tell it was dead. Main now appends this same marker to
// its scrollback on PTY exit AND the renderer writes it live; keeping the exact string
// in ONE place stops the replayed and live copies from drifting (allowed-pattern #14).

/** The dim ANSI marker shown when a shell process exits. */
export function terminalExitMarker(exitCode: number): string {
  return `\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`
}
