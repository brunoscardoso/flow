/**
 * The measuring stick.
 *
 * Every number this repo has acted on came from a throwaway script somebody
 * wrote once and deleted — which means every round of "it is slow" started by
 * rebuilding the instrument before it could start on the problem. This is that
 * instrument, kept: build a worst case a real user reaches, time it, print
 * bytes AND milliseconds, and write the result where the next run can compare
 * against it (allowed-pattern #16).
 *
 * Probes live in `perf/*.probe.ts` and run under Electron-as-Node (the
 * better-sqlite3 ABI), never in the normal suite — they are slow on purpose.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One measured thing: what it was, how long, how big. */
export interface Measurement {
  name: string
  ms: number
  /** Bytes that crossed a boundary, when the answer is a payload. */
  bytes?: number
  /** Rows/files/modules — whatever "how much work" means for this probe. */
  items?: number
  /** Anything the reader needs to interpret the number. */
  note?: string
}

const RESULTS_DIR = join(__dirname, 'results')

/** Serialized size of what a call ACTUALLY hands back — the transfer cost, not
 *  the in-memory one. IPC pays for the JSON, so the JSON is what we count. */
export function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

/**
 * Run `fn` `runs` times and keep the MEDIAN.
 *
 * Not the mean: one GC pause or one cold cache should not become the headline,
 * and the median of five is stable enough to compare across days while still
 * being honest about a genuinely slow path.
 */
export async function measure(
  name: string,
  fn: () => unknown | Promise<unknown>,
  options: { runs?: number; items?: number; note?: string; bytesOf?: boolean } = {},
): Promise<Measurement> {
  const runs = options.runs ?? 5
  const timings: number[] = []
  let last: unknown
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now()
    last = await fn()
    timings.push(performance.now() - started)
  }
  timings.sort((a, b) => a - b)
  const median = timings[Math.floor(timings.length / 2)] ?? 0
  return {
    name,
    ms: Math.round(median * 100) / 100,
    ...(options.bytesOf === true ? { bytes: payloadBytes(last) } : {}),
    ...(options.items === undefined ? {} : { items: options.items }),
    ...(options.note === undefined ? {} : { note: options.note }),
  }
}

/** Human sizes, because 7318204 is not a number anybody compares at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** One line per measurement, aligned, with the comparison when there is one. */
export function report(title: string, measurements: readonly Measurement[]): void {
  const previous = readBaseline(title)
  const width = Math.max(...measurements.map((m) => m.name.length), 10)
  const lines = [`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`]
  for (const m of measurements) {
    const before = previous[m.name]
    const delta =
      before === undefined || before.ms === 0
        ? ''
        : `  (was ${String(before.ms)}ms — ${describeChange(before.ms, m.ms)})`
    const size = m.bytes === undefined ? '' : `  ${formatBytes(m.bytes)}`
    const count = m.items === undefined ? '' : `  ${String(m.items)} items`
    lines.push(`${m.name.padEnd(width)}  ${m.ms.toFixed(2).padStart(9)}ms${size}${count}${delta}`)
    if (m.note !== undefined) lines.push(`${' '.repeat(width)}  ↳ ${m.note}`)
  }
  console.log(lines.join('\n'))
}

/** "3.4× faster" / "1.8× SLOWER" — a ratio, because that is the target's unit. */
function describeChange(before: number, after: number): string {
  if (after <= 0) return 'instant'
  const ratio = before / after
  if (ratio >= 1.05) return `${ratio.toFixed(1)}× faster`
  if (ratio <= 0.95) return `${(1 / ratio).toFixed(1)}× SLOWER`
  return 'unchanged'
}

function baselinePath(title: string): string {
  return join(RESULTS_DIR, `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`)
}

/** The last recorded run of this probe, by measurement name. */
export function readBaseline(title: string): Record<string, Measurement> {
  try {
    const raw = readFileSync(baselinePath(title), 'utf8')
    const parsed = JSON.parse(raw) as { measurements: Measurement[] }
    return Object.fromEntries(parsed.measurements.map((m) => [m.name, m]))
  } catch {
    return {}
  }
}

/**
 * Record this run as the new baseline.
 *
 * Deliberately NOT stamped with a clock: a file that changes on every run is a
 * file nobody can diff. What changed is the numbers, and they are the point.
 */
export function writeBaseline(title: string, measurements: readonly Measurement[]): void {
  const path = baselinePath(title)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ probe: title, measurements }, null, 2)}\n`)
}
