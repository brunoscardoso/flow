/**
 * A real V8 CPU profile of the main process.
 *
 * Handler timings say how long a request took; they cannot say what the process
 * was doing INSTEAD of answering it. The stall log kept reporting exactly that
 * shape — a channel blamed for a second it spent waiting, with its own work
 * measured at twenty milliseconds — so the next question ("busy with what?")
 * needs V8, not more instrumentation.
 *
 * Driven over the inspector's own WebSocket from the spec's Node, because the
 * main bundle is ESM: `require` does not exist in an evaluate() context and a
 * dynamic import has no callback there. The app is launched with `--inspect`.
 */
export interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}

export interface CpuProfile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

/** One frame's own cost, and where to find it. */
export interface HotFrame {
  name: string
  place: string
  ms: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** A connection to main's inspector, with just the calls a profile needs. */
export class MainProfiler {
  #socket: WebSocket | null = null
  #nextId = 1
  #pending = new Map<number, Pending>()

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    // The debugger URL is published over HTTP; it takes a moment after launch.
    let url: string | null = null
    for (let attempt = 0; attempt < 40 && url === null; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(this.port)}/json/list`)
        const targets = (await response.json()) as Array<{ webSocketDebuggerUrl?: string }>
        url = targets[0]?.webSocketDebuggerUrl ?? null
      } catch {
        url = null
      }
      if (url === null) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (url === null) throw new Error('main process inspector never answered')
    const socket = new WebSocket(url)
    this.#socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('inspector socket failed')), {
        once: true,
      })
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
      if (message.id === undefined) return
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  #send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.#socket
    if (socket === null) throw new Error('not connected')
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async start(intervalMicros = 200): Promise<void> {
    await this.#send('Profiler.enable')
    await this.#send('Profiler.setSamplingInterval', { interval: intervalMicros })
    await this.#send('Profiler.start')
  }

  async stop(): Promise<CpuProfile> {
    const result = (await this.#send('Profiler.stop')) as { profile: CpuProfile }
    return result.profile
  }

  close(): void {
    this.#socket?.close()
    this.#socket = null
  }
}

/**
 * Self time per frame, from the SAMPLE STREAM.
 *
 * `hitCount` alone loses the sampling interval; the deltas are what the wall
 * clock actually spent, which is the number a person feels.
 */
export function hotFrames(profile: CpuProfile, limit = 30): HotFrame[] {
  const selfMicros = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i]
    if (id === undefined) continue
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + Math.max(0, deltas[i] ?? 0))
  }
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  return [...selfMicros.entries()]
    .map(([id, micros]) => ({ node: byId.get(id), ms: micros / 1000 }))
    .filter((row): row is { node: ProfileNode; ms: number } => row.node !== undefined)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((row) => ({
      name: row.node.callFrame.functionName || '(anonymous)',
      place: shortPlace(row.node),
      ms: Math.round(row.ms * 10) / 10,
    }))
}

/** Total CPU the profile actually observed, in ms. */
export function profileCpuMs(profile: CpuProfile): number {
  return (profile.timeDeltas ?? []).reduce((sum, delta) => sum + Math.max(0, delta), 0) / 1000
}

function shortPlace(node: ProfileNode): string {
  const url = node.callFrame.url.replace(/^file:\/\//, '')
  if (url === '') return '(native)'
  const file = url.split('/').slice(-2).join('/')
  return `${file}:${String(node.callFrame.lineNumber + 1)}`
}
