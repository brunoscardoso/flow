/**
 * The last JSON object a CLI run printed on stdout — how every `planflow-ai`
 * answer is read. A refusal's prose can follow its payload on the same stream
 * (allowed-pattern #15), so the scan runs from the bottom up and skips any
 * line that is not an object.
 */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON after all — keep looking further up.
    }
  }
  return null
}
