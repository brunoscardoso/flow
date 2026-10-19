/**
 * Vite `?worker` module shape — importing a module with the `?worker` suffix
 * yields a Worker constructor bundled as a self-hosted asset, which is how
 * Monaco's workers stay inside the strict CSP (no CDN, no blob eval).
 */
declare module '*?worker' {
  const WorkerFactory: {
    new (options?: { name?: string }): Worker
  }
  export default WorkerFactory
}
