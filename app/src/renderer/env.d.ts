/** Vite handles CSS imports; give TypeScript a module shape for them. */
declare module '*.css'

/** Typed preload bridge exposed by `src/preload/index.ts` via contextBridge. */
interface Window {
  flow: import('../shared/ipc-contract').FlowApi
  /** Authoritative OS platform surfaced by the preload bridge (#1063):
   *  main's `process.platform` — 'darwin' | 'win32' | 'linux' | … */
  flowPlatform?: string
  /** file:// URL of the embedded browser's guest preload, surfaced by the
   *  preload bridge — set as the browser <webview>'s `preload` attribute. */
  flowBrowserGuestPreloadUrl?: string
}
