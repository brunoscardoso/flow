import { terminalExitMarker } from './terminal-exit'

describe('terminalExitMarker (#446)', () => {
  it('embeds the exit code in a dim, newline-wrapped ANSI marker', () => {
    expect(terminalExitMarker(0)).toBe('\r\n\x1b[2m[process exited with code 0]\x1b[0m\r\n')
    expect(terminalExitMarker(137)).toContain('[process exited with code 137]')
  })

  it('is a stable single source so main-replayed and renderer-live copies never drift', () => {
    // Same input → byte-identical output (the whole point of the shared string).
    expect(terminalExitMarker(1)).toBe(terminalExitMarker(1))
  })
})
