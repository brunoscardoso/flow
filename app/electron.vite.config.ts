import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { publicBuildConfig } from './scripts/build-config.mjs'

/**
 * Inject CSP placeholders in the renderer HTML. Dev needs 'unsafe-eval' +
 * ws: for Vite HMR; production strips both so the renderer runs under a
 * strict policy (contextBridge-only preload, no Node APIs in renderer).
 */
function cspHtmlReplacePlugin(isDev: boolean) {
  const scriptExtras = isDev ? "'unsafe-eval' 'unsafe-inline'" : ''
  const connectExtras = isDev ? 'ws://localhost:* http://localhost:*' : ''
  return {
    name: 'flow-csp-html-replace',
    transformIndexHtml(html: string): string {
      return html
        .replaceAll('%CSP_SCRIPT_EXTRAS%', scriptExtras)
        .replaceAll('%CSP_CONNECT_EXTRAS%', connectExtras)
    },
  }
}

const isDev = process.env.NODE_ENV !== 'production'

/**
 * BUILD-TIME CONFIGURATION — the mechanism this config did not have (C-5).
 *
 * The release script passes environment variables, and nothing was substituting
 * them into the bundle, so there was no way to tell a built app where anything
 * lives. These two are read from the BUILDER's environment and compiled in.
 *
 * WITHOUT THE KEY, NOTHING IS SENT: the endpoint is public and always compiled
 * in, but `configuredEndpoint()` reports "nowhere" when the key is empty, so a
 * dev or e2e build collects nothing and posts nothing. (Telemetry also waits
 * for the user's consent, which a fresh test profile never gives.)
 *
 * Whatever is put here is readable by anyone who unzips the app — so the key
 * must be a WRITE-ONLY ingest key. `telemetry-endpoint.ts` refuses the obvious
 * wrong ones at startup.
 */
// THE PUBLIC VALUES COME FROM app/build-config.json (committed), so every build
// — dev, e2e, install:local, release — knows where sign-in and sharing live
// without anyone exporting anything. A non-empty environment variable still
// overrides (scripts/build-config.mjs). The telemetry KEY is not in that file:
// only `release` and `install:local` pass it in, from the per-machine
// app/.flow-build.local.json, and both rebuild app/out without it afterwards.
const publicConfig = publicBuildConfig(resolve('.'))

const buildTimeDefines = {
  __FLOW_TELEMETRY_ENDPOINT__: JSON.stringify(publicConfig.FLOW_TELEMETRY_ENDPOINT),
  __FLOW_TELEMETRY_KEY__: JSON.stringify(process.env.FLOW_TELEMETRY_KEY ?? ''),
  // Sign-in (client-sign-in). The client id is MEANT to be public — it appears
  // in every authorization URL a browser sees — so unlike the ingest key it is
  // not a secret being smuggled. The client SECRET never ships: the code
  // exchange happens on the function.
  __FLOW_AUTH_ENDPOINT__: JSON.stringify(publicConfig.FLOW_AUTH_ENDPOINT),
  __FLOW_GITHUB_CLIENT_ID__: JSON.stringify(publicConfig.FLOW_GITHUB_CLIENT_ID),
  // Feature view sharing. A base URL and nothing else — the author's bearer is
  // the desktop session token, read from the keychain at the moment of a
  // request, so no credential of any kind is compiled in here.
  __FLOW_SHARE_ENDPOINT__: JSON.stringify(publicConfig.FLOW_SHARE_ENDPOINT),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Main only: nothing in the renderer may reach the network on its own, and
    // an ingest key in the renderer bundle would be readable from the page.
    define: buildTimeDefines,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // THE CLI HOST runs as a utility process (see cli-host/). Spawning a
          // child from Electron's main process costs main-thread time — a
          // sample taken during a live stall found 73% of its CPU inside
          // posix_spawn — so the spawning happens over here instead.
          'cli-host': resolve('src/main/cli-host/host.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // The embedded browser's <webview> loads this dedicated guest preload
          // (the inspect bridge). A separate entry so it bundles to a resolvable
          // out/preload/browser-guest.js the renderer can point the webview at.
          'browser-guest': resolve('src/browser-guest/browser-guest.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [cspHtmlReplacePlugin(isDev)],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
        },
      },
    },
  },
})
